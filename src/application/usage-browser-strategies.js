// Browser/extension usage strategies; cookies never leave these functions.
function createUsageBrowserStrategies(deps) {
  const { resolveVaultKey, httpRequest, queryConsoleOnlyUsage, round1, round4, epochToISO, accountBalanceResult, MIMO_CONSOLE_URL, MIMO_BALANCE_CONSOLE_URL, MIMO_BALANCE_URL, MIMO_SESSION_VAULT_KEY } = deps;
async function queryQianfanCodingUsage(_apiKey) {
  const browserUsage = await queryQianfanPersonalUsageViaExtension();
  if (browserUsage) return browserUsage;
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '百度千帆 Token Plan 用量需要在已登录的千帆控制台页面中查询，请先打开并登录 Token Plan 页面后刷新。',
    action: { label: '打开千帆 Token Plan', url: 'https://console.bce.baidu.com/qianfan/resource/token-plan' },
  };
}

async function queryQianfanPersonalUsageViaExtension() {
  let bridge;
  try { bridge = require('../web/api/ws-extension'); } catch { return null; }
  if (!bridge.isExtensionConnected()) return null;

  let tabsResult;
  try {
    tabsResult = await bridge.sendCommand('tabs', { op: 'list', workspace: 'okit' }, 10000);
  } catch { tabsResult = { data: [] }; }
  const tabs = Array.isArray(tabsResult?.data) ? tabsResult.data : [];
  const target = tabs
    .filter(tab => /^https:\/\/console\.bce\.baidu\.com\/qianfan\/resource\/token-plan(?:[/?#]|$)/.test(tab?.url || ''))
    .sort((a, b) => Number(b.active) - Number(a.active))[0];
  if (!target?.tabId) return null;

  const code = `(${async function () {
    const response = await fetch('https://console.bce.baidu.com/api/qianfan/charge/tokenPlanPersonal/resource', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: (await response.text()).slice(0, 20000),
    };
  }})()`;
  let result;
  try {
    result = await bridge.sendCommand('exec', { tabId: target.tabId, code, workspace: 'okit' }, 20000);
  } catch { return null; }
  const response = result?.data;
  if (!result?.ok || !response) return null;
  if (response.status === 401 || response.status === 403 || response.status === 302) {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: '百度千帆控制台登录态已过期，请重新登录后刷新。',
      action: { label: '打开千帆 Token Plan', url: target.url },
    };
  }
  if (response.status !== 200 || !response.body || !/json/i.test(response.contentType || '')) {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: `百度千帆用量接口返回异常（HTTP ${response.status}）。`,
      action: { label: '打开千帆 Token Plan', url: target.url },
    };
  }
  let payload;
  try { payload = JSON.parse(response.body); } catch {
    return { supported: true, windows: [], source: 'console', notice: '百度千帆用量接口返回了无效 JSON。' };
  }
  const parsed = parseQianfanTokenPlanUsage(payload);
  if (parsed.error) {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: parsed.error,
      action: { label: '打开千帆 Token Plan', url: target.url },
    };
  }
  return { supported: true, windows: parsed.windows, source: 'browser' };
}

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

// Tencent Token Plan support in OKIT is currently limited to the personal
// plan. Tencent does not publish a reusable personal quota endpoint, so keep
// this card console-only instead of mixing in enterprise CAM credentials.
async function queryTencentTokenPlanUsage(_apiKey) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '腾讯云 Token Plan 个人版用量暂不支持自动查询，请在控制台查看。',
    action: { label: '打开腾讯云 Token Plan', url: 'https://console.cloud.tencent.com/tokenhub/tokenplan' },
  };
}

// Tencent Cloud account balance is exposed by the Billing API, not by the
// TokenHub inference API or the browser session. Keep this credential path
// separate from TENCENT_API_KEY: a TokenHub key cannot query cloud billing.
async function queryTencentBalance() {
  const credentials = await resolveCredentialPair({
    combined: ['TENCENT_CLOUD_CREDENTIALS', 'TENCENT_BILLING_CREDENTIALS'],
    accessKey: ['TENCENT_SECRET_ID', 'TENCENT_CLOUD_SECRET_ID', 'TECENT_SECRET_ID'],
    secretKey: ['TENCENT_SECRET_KEY', 'TENCENT_CLOUD_SECRET_KEY', 'TECENT_SECRET_KEY', 'TENCENT'],
  });
  if (!credentials) {
    return manualCredentialPairNotice(
      '腾讯云',
      'TENCENT_CLOUD_CREDENTIALS',
      'TENCENT_SECRET_ID',
      'TENCENT_SECRET_KEY',
      'https://console.cloud.tencent.com/cam/capi',
    );
  }

  const result = await callTencentApi(
    credentials.accessKey,
    credentials.secretKey,
    'DescribeAccountBalance',
    {},
    { host: 'billing.tencentcloudapi.com', service: 'billing', version: '2018-07-09' },
  );
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) {
    return { supported: true, windows: [], error: '腾讯云 SecretId/SecretKey 无费用中心查询权限，请授予费用中心只读权限' };
  }
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: '腾讯云费用中心接口返回了无效 JSON' }; }
  const response = data.Response || data.response || data;
  if (response.Error) {
    const code = response.Error.Code ? `（${response.Error.Code}）` : '';
    const permissionDenied = /CamNoAuth|UnauthorizedOperation|AuthFailure/i.test(String(response.Error.Code || ''));
    return {
      supported: true,
      windows: [],
      error: permissionDenied
        ? '腾讯云费用中心查询权限未配置，请点击“配置”。'
        : `腾讯云费用中心查询失败${code}`,
      action: { label: '查看费用中心权限说明', url: 'https://cloud.tencent.com/document/product/555/61542' },
    };
  }
  const amountInFen = response.RealBalance ?? response.Balance;
  const parsed = accountBalanceResult(Number(amountInFen) / 100, 'CNY', data);
  return parsed || { supported: true, windows: [], error: '腾讯云费用中心接口暂未返回可识别余额' };
}

function callTencentApi(secretId, secretKey, action, payload, options = {}) {
  const crypto = require('crypto');
  const host = options.host || 'tokenhub.tencentcloudapi.com';
  const service = options.service || 'tokenhub';
  const version = options.version || '2026-03-22';
  const region = options.region || 'ap-guangzhou';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload || {});
  const hashedBody = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedBody}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return httpRequest(`https://${host}`, {
    method: 'POST',
    headers: {
      Host: host,
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      Authorization: authorization,
    },
    body,
    timeout: 10000,
  });
}

// OpenCode Go quota is rendered by the authenticated opencode.ai workspace
// page, not by the documented organization CSV export endpoint. Reuse the
// browser session through the OKIT extension: fetch() runs in the logged-in
// page context with credentials: include, so raw cookies never enter OKIT.
async function queryOpenCodeGoUsage(_apiKey) {
  const browserUsage = await queryOpenCodeGoUsageViaExtension();
  if (browserUsage) return browserUsage;
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '请先在已登录 OpenCode Go 的浏览器页面打开套餐页，然后回到这里刷新用量。',
    action: { label: '打开 OpenCode Go 套餐页', url: 'https://opencode.ai/' },
  };
}

async function queryOpenCodeGoUsageViaExtension() {
  let bridge;
  try { bridge = require('./ws-extension'); } catch { return null; }
  if (!bridge.isExtensionConnected()) {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: 'OKIT 浏览器插件当前未连接。请先启动/重新加载 OKIT 插件，再刷新用量；内置浏览器里的登录态不会自动共享给插件。',
      action: { label: '打开 OpenCode Go 套餐页', url: 'https://opencode.ai/' },
    };
  }

  let tabsResult;
  try {
    tabsResult = await bridge.sendCommand('tabs', { op: 'list', workspace: 'okit' }, 10000);
  } catch { tabsResult = { data: [] }; }
  const tabs = Array.isArray(tabsResult?.data) ? tabsResult.data : [];
  let target = tabs
    .filter(tab => /^https:\/\/(?:www\.)?opencode\.ai\/workspace\/[^/]+\/go(?:[/?#]|$)/.test(tab?.url || ''))
    .sort((a, b) => Number(b.active) - Number(a.active))[0];
  if (!target?.tabId) {
    // The extension deliberately scopes tab discovery to its automation
    // window. OpenCode may still be open in another Chrome window, so create
    // a controlled tab and discover the user's workspace link there.
    try {
      const navigation = await bridge.sendCommand('navigate', {
        url: 'https://opencode.ai/',
        workspace: 'okit',
      }, 30000);
      if (!navigation?.ok || !navigation.data?.tabId) return null;
      target = { tabId: navigation.data.tabId, url: navigation.data.url || 'https://opencode.ai/' };
      const links = await bridge.sendCommand('exec', {
        tabId: target.tabId,
        code: "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /^https:\\/\\/(?:www\\.)?opencode\\.ai\\/workspace\\/[^/]+\\/go(?:[/?#]|$)/.test(h))",
        workspace: 'okit',
      }, 10000);
      const workspaceUrl = Array.isArray(links?.data) ? links.data[0] : null;
      if (!workspaceUrl) {
        return {
          supported: true,
          windows: [],
          source: 'console',
          notice: '插件已连接，但没有发现 OpenCode Go 套餐页。请在插件连接的 Chrome 中打开并登录 OpenCode Go 页面，然后刷新用量。',
          action: { label: '打开 OpenCode Go 套餐页', url: 'https://opencode.ai/' },
        };
      }
      const goNavigation = await bridge.sendCommand('navigate', {
        tabId: target.tabId,
        url: workspaceUrl,
        workspace: 'okit',
      }, 30000);
      if (!goNavigation?.ok) return null;
      target.url = workspaceUrl;
    } catch { return null; }
  }

  const code = `(${async function () {
    const workspaceId = location.pathname.match(/^\/workspace\/([^/]+)\/go(?:[/?#]|$)/)?.[1];
    const paths = ['/api/go', '/api/go/usage', '/api/usage', '/api/usage/summary'];
    const results = [];
    for (const path of paths) {
      try {
        const response = await fetch(new URL(path, location.origin), {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const body = await response.text();
        results.push({ path, status: response.status, contentType: response.headers.get('content-type') || '', body: body.slice(0, 12000) });
      } catch (error) {
        results.push({ path, status: 0, contentType: '', body: '', error: String(error) });
      }
    }
    // The Go page loads its quota through the SolidStart server function
    // `lite.subscription.get`. This is the same authenticated request the
    // page itself makes; the compact Seroval envelope keeps the workspace ID
    // in the page context and never exposes its session cookie to OKIT.
    if (workspaceId) {
      try {
        const response = await fetch(new URL('/_server', location.origin), {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Server-Id': 'c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd',
            'X-Server-Instance': 'okit:' + Date.now(),
          },
          body: JSON.stringify({
            t: { t: 9, s: 1, a: [{ t: 1, s: workspaceId }], o: 0 },
            f: 0,
            m: [],
          }),
        });
        results.push({ path: '/_server', status: response.status, contentType: response.headers.get('content-type') || '', body: (await response.text()).slice(0, 12000) });
      } catch (error) {
        results.push({ path: '/_server', status: 0, contentType: '', body: '', error: String(error) });
      }
    }
    // The Go page also embeds the authenticated quota in its SolidStart
    // hydration payload. This is the same data rendered on screen and avoids
    // depending on an undocumented JSON route whose response may be HTML.
    try {
      const source = Array.from(document.scripts)
        .map(script => script.textContent || '')
        .join('\n');
      const hydrated = {};
      for (const key of ['rollingUsage', 'weeklyUsage', 'monthlyUsage']) {
        let cursor = 0;
        while (cursor < source.length) {
          const start = source.indexOf(`${key}:`, cursor);
          if (start < 0) break;
          const chunk = source.slice(start, source.indexOf('}', start) + 1);
          const usagePercent = chunk.match(/(?:usagePercent|usedPercent):(-?\d+(?:\.\d+)?)/)?.[1];
          const resetInSec = chunk.match(/resetInSec:(\d+)/)?.[1];
          cursor = start + key.length + 1;
          if (usagePercent == null) continue;
          hydrated[key] = {
            usagePercent: Number(usagePercent),
            ...(resetInSec == null ? {} : { resetInSec: Number(resetInSec) }),
          };
          break;
        }
      }
      if (Object.keys(hydrated).length) {
        results.push({
          path: 'hydration',
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(hydrated),
        });
      }
    } catch (error) {
      results.push({ path: 'hydration', status: 0, contentType: '', body: '', error: String(error) });
    }
    return results;
  }} )()`;
  let result;
  try {
    result = await bridge.sendCommand('exec', { tabId: target.tabId, code, workspace: 'okit' }, 20000);
  } catch { return null; }
  if (!result?.ok || !Array.isArray(result.data)) return null;

  for (const response of result.data) {
    if (response.status !== 200 || !response.body || !/json/i.test(response.contentType || '')) continue;
    let payload;
    try { payload = JSON.parse(response.body); } catch { continue; }
    const parsed = parseOpenCodeGoUsage(payload);
    if (parsed) return { supported: true, windows: parsed.windows, source: 'browser', raw: payload };
  }
  const unauthorized = result.data.some(response => response.status === 401 || response.status === 403);
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: unauthorized
      ? 'OpenCode Go 页面登录态已过期，请在浏览器中重新登录后刷新。'
      : 'OpenCode Go 用量接口暂未返回可识别的额度数据，请在 Go 套餐页查看。',
    action: { label: '打开 OpenCode Go 套餐页', url: target.url },
  };
}

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
function xiaomiSessionNotice(loginUrl) {
  let bridge = null;
  try { bridge = require('../web/api/ws-extension'); } catch { /* fall through */ }
  if (!bridge || !bridge.isExtensionConnected()) {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: 'OKIT 浏览器插件未连接，无法读取 Chrome 中的 MiMo 登录态。请先在 Chrome 扩展管理页启用或重新加载 OKIT 插件，然后回到这里点击刷新。',
    };
  }
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: 'MiMo 的用量接口需要控制台会话 Cookie——即使浏览器已登录，也需打开一次控制台让小米账号完成 SSO 换发（已登录时无需再输密码）。点击下方按钮后无需其他操作：OKIT 会自动检测会话、关闭控制台窗口并刷新用量；会话同时被加密缓存，过期前不再需要打开。',
    action: { label: '在插件中打开 MiMo 控制台', url: loginUrl || MIMO_CONSOLE_URL, mode: 'extension' },
  };
}

// Plan key as a Cookie rather than an Authorization header. The endpoint is
// not part of the inference API, so keep the request isolated and return a
// clear console-login message for accounts that require a web session.
async function queryXiaomiCodingUsage(apiKey, baseUrl) {
  // Reuse the encrypted session cache first. A 401 invalidates it and triggers
  // one refresh from the OKIT browser extension below.
  const cachedSession = await loadXiaomiSession();
  if (cachedSession?.cookie) {
    const cachedEndpoint = /^https:\/\/platform\.xiaomimimo\.com\/api\/v1\/tokenPlan\/usage/.test(cachedSession.endpoint || '')
      ? cachedSession.endpoint
      : undefined;
    const cachedUsage = await queryXiaomiUsageWithCookie(cachedSession.cookie, cachedEndpoint);
    if (cachedUsage) return cachedUsage;
    await clearXiaomiSession();
  }

  const browserUsage = await queryXiaomiUsageViaExtension();
  if (browserUsage) return browserUsage;

  // The browser-session route above needs no vault key — when it yielded
  // nothing, the honest next step is the one-time console visit (it mints the
  // platform session cookie via Xiaomi SSO), not "no key configured".
  if (!apiKey) return xiaomiSessionNotice();

  const endpoints = ['https://platform.xiaomimimo.com/api/v1/tokenPlan/usage'];
  const providerOrigin = getOrigin(baseUrl);
  if (providerOrigin) endpoints.push(`${providerOrigin}/api/v1/tokenPlan/usage`);

  let lastError = null;
  for (const endpoint of [...new Set(endpoints)]) {
    const result = await httpRequest(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': apiKey,
        'Referer': 'https://platform.xiaomimimo.com/console/plan-manage',
        'Origin': 'https://platform.xiaomimimo.com',
        'X-Timezone': 'Asia/Shanghai',
        'User-Agent': 'OKIT/usage',
      },
      timeout: 10000,
    });
    if (result.error) { lastError = result.error; continue; }
    if (result.status === 401) {
      return xiaomiSessionNotice(getTrustedXiaomiLoginUrl(result.body));
    }
    if (result.status === 404) { lastError = 'MiMo 用量接口暂不可用'; continue; }
    if (result.status !== 200) { lastError = `HTTP ${result.status}`; continue; }
    let d;
    try { d = JSON.parse(result.body); } catch { lastError = '接口返回了无效 JSON'; continue; }
    const parsed = parseXiaomiTokenPlanUsage(d);
    if (parsed.error) return { supported: true, windows: [], error: parsed.error };
    return { supported: true, windows: parsed.windows, raw: d };
  }

  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: lastError || 'MiMo 用量接口暂不可用，请在 MiMo 控制台的 Token Plan 页面查看。',
  };
}

async function queryXiaomiUsageViaExtension() {
  const browserSession = await getXiaomiBrowserSession();
  if (!browserSession) return null;
  const { cookieHeader, cookies, tabs } = browserSession;

  const apiTab = tabs
    .filter(tab => /^https:\/\/platform\.xiaomimimo\.com\/api\/v1\/tokenPlan\/usage/.test(tab?.url || ''))
    .sort((a, b) => Number(/\?/.test(b.url || '')) - Number(/\?/.test(a.url || '')))[0];
  let endpoint = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';
  if (apiTab?.url) endpoint = apiTab.url;

  const usage = await queryXiaomiUsageWithCookie(cookieHeader, endpoint);
  if (usage && !usage.error) {
    await saveXiaomiSession(cookieHeader, endpoint, getCookieExpiry(cookies));
  }
  return usage;
}

async function getXiaomiBrowserSession() {
  let bridge;
  try { bridge = require('./ws-extension'); } catch { return null; }
  if (!bridge.isExtensionConnected()) return null;

  // Older OKIT extensions only support an exact-domain lookup. Query both the
  // host and its parent domain so this works without requiring an extension
  // reinstall/reload when the auth cookie is scoped to `.xiaomimimo.com`.
  const cookieResults = await Promise.all(['platform.xiaomimimo.com', 'xiaomimimo.com'].map(async domain => {
    try {
      return await bridge.sendCommand('cookies', { domain, workspace: 'okit' }, 10000);
    } catch {
      return null;
    }
  }));
  const cookies = cookieResults
    .flatMap(result => Array.isArray(result?.data) ? result.data : [])
    .filter((cookie, index, all) => all.findIndex(other => (
      other.name === cookie.name && other.domain === cookie.domain && other.path === cookie.path
    )) === index);
  const cookieHeader = cookies
    .filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
  if (!cookieHeader) return null;

  let tabsResult;
  try {
    tabsResult = await bridge.sendCommand('tabs', { op: 'list', workspace: 'okit' }, 10000);
  } catch { tabsResult = { data: [] }; }
  const tabs = Array.isArray(tabsResult?.data) ? tabsResult.data : [];
  return { cookieHeader, cookies, tabs };
}

async function queryXiaomiUsageWithCookie(cookieHeader, endpoint = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage') {
  try {
    const result = await httpRequest(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
        'Referer': 'https://platform.xiaomimimo.com/console/plan-manage',
        'User-Agent': 'OKIT/usage',
      },
      timeout: 10000,
    });
    if (result.status === 401 || result.status === 403) return null;
    if (result.status !== 200 || !result.body) return null;
    const data = JSON.parse(result.body);
    if (data?.code === 401 || data?.code === 403) return null;
    const parsed = parseXiaomiTokenPlanUsage(data);
    if (parsed.error) return { supported: true, windows: [], error: parsed.error };
    return { supported: true, windows: parsed.windows, source: 'browser', raw: data };
  } catch {
    return null;
  }
}

async function loadXiaomiSession() {
  const raw = await resolveVaultKey(MIMO_SESSION_VAULT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.cookie === 'string') return parsed;
  } catch {}
  // Accept a cookie saved by an earlier development build as a one-time
  // migration. It will be rewritten to the structured encrypted value after
  // the next successful query.
  return { cookie: raw, endpoint: undefined, expiresAt: undefined };
}

async function saveXiaomiSession(cookie, endpoint, expiresAt) {
  try {
    const { VaultStore } = require('../../vault/store');
    const store = new VaultStore();
    await store.set(
      MIMO_SESSION_VAULT_KEY,
      JSON.stringify({ cookie, endpoint, expiresAt: expiresAt || '' }),
      '小米 MiMo',
      expiresAt || '',
      'MiMo 控制台浏览器会话缓存（仅在接口过期后重新获取）',
    );
  } catch {
    // Usage remains functional even if the optional session cache cannot be
    // written (for example, a read-only vault).
  }
}

async function clearXiaomiSession() {
  try {
    const { VaultStore } = require('../../vault/store');
    await new VaultStore().delete(MIMO_SESSION_VAULT_KEY);
  } catch {}
}

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

async function queryXiaomiBalance() {
  const cachedSession = await loadXiaomiSession();
  if (cachedSession?.cookie) {
    const cachedBalance = await queryXiaomiBalanceWithCookie(cachedSession.cookie);
    if (cachedBalance) return cachedBalance;
    await clearXiaomiSession();
  }

  const browserSession = await getXiaomiBrowserSession();
  if (browserSession?.cookieHeader) {
    const browserBalance = await queryXiaomiBalanceWithCookie(browserSession.cookieHeader);
    if (browserBalance) {
      if (!browserBalance.error) {
        await saveXiaomiSession(
          browserSession.cookieHeader,
          undefined,
          getCookieExpiry(browserSession.cookies),
        );
      }
      return browserBalance;
    }
  }

  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '小米 MiMo 余额接口需要控制台登录态。请在 OKIT 浏览器插件打开的 MiMo 控制台中登录，完成后回到这里刷新。',
    action: { label: '在 OKIT 插件中登录', url: MIMO_BALANCE_CONSOLE_URL, mode: 'extension' },
  };
}

async function queryXiaomiBalanceWithCookie(cookieHeader) {
  try {
    const result = await httpRequest(MIMO_BALANCE_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
        'Referer': MIMO_BALANCE_CONSOLE_URL,
        'X-Timezone': 'Asia/Shanghai',
        'User-Agent': 'OKIT/usage',
      },
      timeout: 10000,
    });
    if (result.status === 401 || result.status === 403) return null;
    if (result.error) return { supported: true, windows: [], error: result.error };
    if (result.status !== 200) return { supported: true, windows: [], error: `小米 MiMo 余额查询失败（HTTP ${result.status}）` };
    const data = JSON.parse(result.body);
    const parsed = parseXiaomiBalance(data);
    if (parsed.error) return { supported: true, windows: [], error: parsed.error };
    return { supported: true, windows: parsed.windows, source: 'browser', raw: data };
  } catch {
    return { supported: true, windows: [], error: '小米 MiMo 余额接口返回了无法识别的数据' };
  }
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

  return { queryQianfanCodingUsage, queryQianfanPersonalUsageViaExtension, queryTencentTokenPlanUsage, queryOpenCodeGoUsage, queryOpenCodeGoUsageViaExtension, queryXiaomiCodingUsage, queryXiaomiBalance };
}

module.exports = { createUsageBrowserStrategies };
