// Pure usage payload parsers and request-signing primitives.
function minimaxWindows(remains) {
  const windows = [];
  for (const r of Array.isArray(remains) ? remains : []) {
    if (r.model_name !== 'general') continue; // skip "video" etc.
    if (r.current_interval_remaining_percent != null) {
      windows.push({
        label: '5h',
        usedPercent: round1(100 - Number(r.current_interval_remaining_percent)),
        resetAt: r.end_time ? epochToISO(r.end_time) : null,
      });
    }
    if (r.current_weekly_status === 1 && r.current_weekly_remaining_percent != null) {
      windows.push({
        label: 'weekly',
        usedPercent: round1(100 - Number(r.current_weekly_remaining_percent)),
        resetAt: r.weekly_end_time ? epochToISO(r.weekly_end_time) : null,
      });
    }
  }
  return windows;
}

function parseOpenRouterCredits(payload) {
  const data = payload?.data || payload;
  const totalCredits = Number(data?.total_credits);
  const totalUsage = Number(data?.total_usage);
  if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return null;

  const remainingCredits = Math.max(0, totalCredits - totalUsage);
  const usedPercent = totalCredits > 0
    ? round1(Math.min(100, Math.max(0, (totalUsage / totalCredits) * 100)))
    : (totalUsage > 0 ? 100 : 0);
  return {
    supported: true,
    windows: [{
      label: 'credits',
      usedPercent,
      usedCredits: round4(totalUsage),
      limitCredits: round4(totalCredits),
      remainingCredits: round4(remainingCredits),
      unit: 'USD',
      isPrepaid: true,
    }],
    raw: payload,
  };
}

// ── Account-balance adapters ─────────────────────────────────
//
// A provider's inference API key is deliberately not promoted to a billing
// credential. Cloud billing APIs use separate management credentials, so the
// adapters below read narrowly-scoped values from Vault by conventional names.
// This keeps existing provider keys working and gives the UI a precise setup
// message when the extra credential has not been configured yet.

function accountBalanceResult(amount, unit = 'CNY', raw) {
  const balance = Number(amount);
  if (!Number.isFinite(balance)) return null;
  return {
    supported: true,
    windows: [{
      label: 'credits',
      usedPercent: null,
      usedCredits: null,
      limitCredits: round4(balance),
      remainingCredits: round4(balance),
      unit,
      isPrepaid: true,
    }],
    raw,
  };
}

/** Parse xAI's prepaid ledger balance.
 *
 * The current Management API returns USD cents as a signed ledger value:
 * `{ total: { val: "-1000" } }` represents $10 of prepaid credit. Older
 * responses exposed a flat numeric balance, so keep that format compatible.
 */
function parseXaiPrepaidBalance(data) {
  const root = data?.data || data;
  if (!root || typeof root !== 'object') return null;

  if (root.total && typeof root.total === 'object') {
    const cents = Number(root.total.val ?? root.total.value ?? root.total.amount);
    if (!Number.isFinite(cents)) return null;
    return accountBalanceResult(Math.abs(cents) / 100, 'USD', data);
  }

  const flatAmount = root.total ?? root.balance ?? root.remaining ?? root.amount;
  return accountBalanceResult(flatAmount, 'USD', data);
}

function bceUriEncode(value, encodeSlash = true) {
  const encoded = encodeURIComponent(String(value))
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? encoded : encoded.replace(/%2F/gi, '/');
}

function canonicalizeBceQuery(query) {
  return Object.entries(query || {})
    .filter(([key]) => key.toLowerCase() !== 'authorization')
    .map(([key, value]) => `${bceUriEncode(key)}=${bceUriEncode(value == null ? '' : value)}`)
    .sort()
    .join('&');
}

function buildBceAuthorization({
  accessKey,
  secretKey,
  method,
  pathName,
  query = {},
  headers = {},
  timestamp,
  expiration = 1800,
  signedHeaderNames,
}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()]),
  );
  const selectedNames = (signedHeaderNames?.length
    ? signedHeaderNames.map(name => name.toLowerCase())
    : Object.keys(normalizedHeaders).filter(name => (
      name === 'host'
      || name === 'content-length'
      || name === 'content-type'
      || name === 'content-md5'
      || name.startsWith('x-bce-')
    )))
    .sort();
  const signedHeaders = signedHeaderNames?.length ? selectedNames.join(';') : '';
  const canonicalHeaders = selectedNames
    .map(name => `${bceUriEncode(name)}:${bceUriEncode(normalizedHeaders[name])}`)
    .join('\n');
  const canonicalRequest = [
    String(method).toUpperCase(),
    bceUriEncode(pathName || '/', false),
    canonicalizeBceQuery(query),
    canonicalHeaders,
  ].join('\n');
  const authPrefix = `bce-auth-v1/${accessKey}/${timestamp}/${expiration}`;
  // BCE uses the hexadecimal SigningKey text as the key of the second HMAC.
  const signingKey = hmacSha256(secretKey, authPrefix, 'hex');
  const signature = hmacSha256(signingKey, canonicalRequest, 'hex');
  return {
    authorization: `${authPrefix}/${signedHeaders}/${signature}`,
    canonicalRequest,
    signingKey,
    signature,
  };
}

function parseBceError(body) {
  try {
    const data = JSON.parse(body);
    return {
      code: data.code || data.Code || data.error_code || data.error?.code || '',
      message: data.message || data.Message || data.error_msg || data.error?.message || '',
      requestId: data.requestId || data.request_id || '',
    };
  } catch {
    return { code: '', message: String(body || '').trim(), requestId: '' };
  }
}

function hmacSha256(key, value, encoding) {
  return require('crypto').createHmac('sha256', key).update(value).digest(encoding);
}

// xAI API prepaid balance — requires a Management Key and Team ID, not the
// normal inference XAI_API_KEY. SuperGrok subscription is a separate product.
function parseQianfanTokenPlanUsage(data) {
  const remainingKeys = new Set(['remaining', 'remain', 'left', 'available', 'balance', 'remainingtoken', 'remainingtokens', 'remainingamount', 'remainingquota']);
  const totalKeys = new Set(['total', 'quota', 'limit', 'capacity', 'totaltoken', 'totaltokens', 'totalamount', 'totalquota', 'totalresource']);
  const usedKeys = new Set(['used', 'usage', 'consumed', 'consume', 'usedtoken', 'usedtokens', 'usedamount']);
  const percentKeys = new Set(['remainingpercent', 'remainpercent', 'remainingrate', 'remainrate', 'usedpercent', 'usagerate', 'usagepercent']);
  const resetKeys = new Set(['resetat', 'resettimes', 'resetime', 'resettime', 'expiretime', 'expiresat', 'expiredat', 'endtime']);

  function numberField(object, keys) {
    for (const [key, value] of Object.entries(object || {})) {
      const normalized = key.toLowerCase().replace(/[_-]/g, '');
      if (keys.has(normalized) && value !== '' && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  }

  function visit(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value)) {
      const remaining = numberField(value, remainingKeys);
      const total = numberField(value, totalKeys);
      const used = numberField(value, usedKeys);
      const percent = numberField(value, percentKeys);
      if (total != null && (remaining != null || used != null || percent != null)) {
        const remainingPercent = Object.keys(value).some(key => /remaining|remain/i.test(key) && /percent|rate/i.test(key));
        const usedPercent = percent != null && !remainingPercent ? percent : null;
        const usedAmount = used != null ? used : (remaining != null ? Math.max(0, total - remaining) : null);
        const remainingAmount = remaining != null
          ? remaining
          : (usedAmount != null ? Math.max(0, total - usedAmount) : null);
        const usedPct = usedPercent != null
          ? (usedPercent <= 1 ? usedPercent * 100 : usedPercent)
          : usedAmount != null && total > 0 ? (usedAmount / total) * 100 : null;
        const resetAt = Object.entries(value).find(([key]) => resetKeys.has(key.toLowerCase().replace(/[_-]/g, '')))?.[1];
        const scale = scaleTokenAmount(total);
        return {
          windows: [{
            label: '额度',
            usedPercent: usedPct == null ? null : round1(usedPct),
            usedCredits: usedAmount == null ? null : round4(usedAmount / scale.divisor),
            limitCredits: round4(total / scale.divisor),
            remainingCredits: remainingAmount == null ? null : round4(remainingAmount / scale.divisor),
            unit: scale.unit,
            isPrepaid: true,
            resetAt: resetAt ? normalizeQianfanDate(resetAt) : null,
          }],
        };
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }

  return visit(data) || { error: '百度千帆接口暂未返回可识别的个人 Token Plan 额度' };
}

function scaleTokenAmount(value) {
  if (value >= 1e9) return { divisor: 1e9, unit: 'B Tokens' };
  if (value >= 1e6) return { divisor: 1e6, unit: 'M Tokens' };
  if (value >= 1e3) return { divisor: 1e3, unit: 'K Tokens' };
  return { divisor: 1, unit: 'Tokens' };
}

function normalizeQianfanDate(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return epochToISO(Number(value));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Tencent Cloud account balance is exposed by the Billing API, not by the
function parseOpenCodeGoUsage(data) {
  const root = data?.data || data;
  const candidates = [
    ['rollingUsage', '5h'],
    ['rolling', '5h'], ['fiveHour', '5h'], ['five_hour', '5h'], ['hourly', '5h'],
    ['weeklyUsage', 'weekly'],
    ['weekly', 'weekly'], ['week', 'weekly'], ['monthly', 'monthly'], ['month', 'monthly'],
    ['monthlyUsage', 'monthly'],
  ];
  const windows = [];
  for (const [key, label] of candidates) {
    const value = root?.[key] ?? root?.usage?.[key] ?? root?.quota?.[key] ?? root?.limits?.[key];
    if (!value || typeof value !== 'object') continue;
    const used = toNumber(value.used ?? value.usage ?? value.consumed ?? value.usedPercent ?? value.usagePercent);
    const limit = toNumber(value.limit ?? value.total ?? value.quota ?? value.max);
    const usedPercent = value.usedPercent != null || value.usagePercent != null
      ? round1(toNumber(value.usedPercent ?? value.usagePercent))
      : limit > 0 ? round1((used / limit) * 100) : null;
    if (usedPercent == null && limit <= 0) continue;
    windows.push({
      label,
      usedPercent: Math.min(100, Math.max(0, usedPercent ?? 0)),
      resetAt: value.resetAt || value.reset_at || value.reset || (Number(value.resetInSec) > 0
        ? new Date(Date.now() + Number(value.resetInSec) * 1000).toISOString()
        : null),
    });
  }
  return windows.length ? { windows } : null;
}

// MiMo Token Plan usage is exposed by the console endpoint. It uses the Token
// Shared dead-end notice for the MiMo usage query: the browser session is the
// supported route (no vault key involved). Distinguish "extension not
// connected" — which reads as "plugin problem", and fixing it needs no console
// visit — from "connected but no platform session", where a one-time console
// visit mints the API session cookie via Xiaomi SSO (instant when already
// signed in; OKIT then caches the session until it expires).
function getCookieExpiry(cookies) {
  const expiries = cookies
    .map(cookie => Number(cookie?.expirationDate))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return expiries.length ? new Date(expiries[0] * 1000).toISOString() : '';
}

function parseXiaomiTokenPlanUsage(data) {
  if (data?.code != null && Number(data.code) !== 0) {
    return { error: data.message || `MiMo API ${data.code}` };
  }
  const items = data?.data?.usage?.items || data?.usage?.items || [];
  const tracked = items.filter(item => ['plan_total_token', 'compensation_total_token'].includes(item.name));
  if (tracked.length === 0) return { error: 'MiMo 接口暂未返回 Token Plan 额度' };
  const used = tracked.reduce((sum, item) => sum + toNumber(item.used), 0);
  const limit = tracked.reduce((sum, item) => sum + toNumber(item.limit), 0);
  const remaining = Math.max(0, limit - used);
  const unit = scaleCredits(remaining).unit;
  const divisor = scaleCredits(remaining).divisor;
  return {
    windows: [{
      label: 'credits',
      usedPercent: limit > 0 ? round1((used / limit) * 100) : null,
      usedCredits: round4(used / divisor),
      limitCredits: round4(limit / divisor),
      remainingCredits: round4(remaining / divisor),
      unit,
      isPrepaid: true,
    }],
  };
}

function parseXiaomiBalance(data) {
  if (data?.code != null && Number(data.code) !== 0) {
    return { error: data.message || `MiMo API ${data.code}` };
  }
  const root = data?.data || data;
  const amount = root?.balance ?? root?.availableBalance ?? root?.available_balance;
  const currency = root?.currency || 'USD';
  const parsed = accountBalanceResult(amount, currency, data);
  return parsed || { error: '小米 MiMo 余额接口暂未返回可识别余额' };
}

function scaleCredits(value) {
  if (value >= 1e9) return { divisor: 1e9, unit: 'B Credits' };
  if (value >= 1e6) return { divisor: 1e6, unit: 'M Credits' };
  if (value >= 1e3) return { divisor: 1e3, unit: 'K Credits' };
  return { divisor: 1, unit: 'Credits' };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getOrigin(baseUrl) {
  try { return new URL(baseUrl).origin; } catch { return null; }
}

// The console API returns an account-login URL with a callback. Only reuse it
// when it points to Xiaomi/MiMo-owned hosts; otherwise fall back to the
// stable Token Plan page instead of rendering an arbitrary response URL.
function getTrustedXiaomiLoginUrl(body) {
  try {
    const candidate = JSON.parse(body).loginUrl;
    const parsed = new URL(candidate);
    const trusted = parsed.protocol === 'https:'
      && (parsed.hostname === 'account.xiaomi.com' || parsed.hostname.endsWith('.xiaomimimo.com'));
    if (trusted) return parsed.toString();
  } catch {}
  return MIMO_CONSOLE_URL;
}

function round1(n) { return Math.round((n || 0) * 10) / 10; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }
function epochToISO(ts) {
  // Accept epoch seconds or epoch millis.
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

// ── Express handler ──────────────────────────────────────────
module.exports = { minimaxWindows, parseOpenRouterCredits, accountBalanceResult, parseXaiPrepaidBalance, bceUriEncode, canonicalizeBceQuery, buildBceAuthorization, parseBceError, hmacSha256, parseQianfanTokenPlanUsage, scaleTokenAmount, normalizeQianfanDate, parseOpenCodeGoUsage, parseXiaomiTokenPlanUsage, parseXiaomiBalance, scaleCredits, toNumber, getOrigin, getTrustedXiaomiLoginUrl, round1, round4, epochToISO };
