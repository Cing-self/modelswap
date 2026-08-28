// API and local-credential usage strategies. All host dependencies are injected.
function createUsageApiStrategies(deps) {
  const { fs, path, os, providersPath, createVaultStore, round1, round4, epochToISO } = deps;
async function loadProviders() {
  if (!(await fs.pathExists(providersPath))) return [];
  try {
    const content = await fs.readFile(providersPath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data.providers) ? data.providers : [];
  } catch {
    return [];
  }
}

async function resolveVaultKey(vaultKey) {
  if (!vaultKey) return undefined;
  try {
    const { VaultStore } = require('../../vault/store');
    const store = new VaultStore();
    return await store.get(vaultKey);
  } catch {
    return undefined;
  }
}

// ── HTTP helper ──────────────────────────────────────────────

function httpRequest(url, options) {
  return new Promise((resolve) => {
    const parsed = new (require('url').URL)(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    if (options.body) req.write(options.body);
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy();
      resolve({ status: 0, error: 'Timeout' });
    });
    req.end();
  });
}

// ── Per-provider queries ─────────────────────────────────────

// Codex (ChatGPT subscription) — undocumented internal endpoint used by the
// Codex CLI TUI. Returns 5h (primary) and weekly (secondary) usage windows.
async function queryCodexUsage() {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  if (!(await fs.pathExists(authPath))) {
    return { supported: true, windows: [], error: '尚未登录 ChatGPT (无 ~/.codex/auth.json)' };
  }
  const content = await fs.readFile(authPath, 'utf-8');
  const auth = JSON.parse(content);
  // Distinguish API key mode from a missing ChatGPT subscription login.
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) {
    if (auth.OPENAI_API_KEY || auth.openai_api_key || auth.api_key) {
      return {
        supported: true,
        windows: [],
        error: '当前为 API Key 模式，无订阅配额。订阅用量仅限 ChatGPT Plus/Pro 用户。API 消耗请查看 platform.openai.com/usage',
      };
    }
    return { supported: true, windows: [], error: '尚未通过 codex login 登录 ChatGPT 订阅' };
  }
  const result = await httpRequest('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.tokens.access_token}`,
      'ChatGPT-Account-Id': auth.account_id || '',
      'User-Agent': 'codex-cli',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'OAuth Token 已过期，请重新登录' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  const windows = [];
  const rl = d.rate_limit || {};
  if (rl.primary_window) {
    windows.push({
      label: '5h',
      usedPercent: round1(rl.primary_window.used_percent),
      resetAt: rl.primary_window.reset_at ? epochToISO(rl.primary_window.reset_at) : null,
    });
  }
  if (rl.secondary_window) {
    windows.push({
      label: 'weekly',
      usedPercent: round1(rl.secondary_window.used_percent),
      resetAt: rl.secondary_window.reset_at ? epochToISO(rl.secondary_window.reset_at) : null,
    });
  }
  return { supported: true, windows, raw: d };
}

// Claude Code (Pro/Max subscription) — undocumented beta endpoint. Works with
// the OAuth token stored by `claude login`, NOT with an API key.
async function queryClaudeUsage(provider) {
  // Only attempt OAuth usage if the provider is NOT using an API key.
  // If authMode is api_key, fall through to "unsupported" for subscription query.
  if (provider.authMode === 'api_key') {
    return { supported: false };
  }

  // Try to read the OAuth token from ~/.claude/.credentials.json
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let accessToken;
  if (await fs.pathExists(credPath)) {
    try {
      const cred = JSON.parse(await fs.readFile(credPath, 'utf-8'));
      accessToken = cred.access_token || cred.tokens?.access_token;
    } catch {}
  }

  // On macOS, Claude Code may store the token in Keychain instead.
  if (!accessToken && process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (out) {
        const parsed = JSON.parse(out);
        accessToken = parsed.access_token || parsed.tokens?.access_token;
      }
    } catch {}
  }

  if (!accessToken) {
    return { supported: true, windows: [], error: '尚未登录 Claude (无 OAuth token)' };
  }

  const result = await httpRequest('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/1.0.0',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'OAuth Token 已过期，请重新登录' };
  if (result.status === 429) return { supported: true, windows: [], error: '请求过于频繁，请稍后重试 (429)' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  const windows = [];
  if (d.five_hour) {
    windows.push({
      label: '5h',
      usedPercent: round1((d.five_hour.utilization || 0) * 100),
      resetAt: d.five_hour.resets_at || null,
    });
  }
  if (d.seven_day) {
    windows.push({
      label: '7d',
      usedPercent: round1((d.seven_day.utilization || 0) * 100),
      resetAt: d.seven_day.resets_at || null,
    });
  }
  return { supported: true, windows, raw: d };
}

// GLM/Z.AI Coding Plan — official endpoint used by the coding plugins and
// cc-switch. Note: NO "Bearer" prefix (Zhipu quirk).
async function queryZaiCodingUsage(apiKey, baseUrl) {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 API Key' };
  const result = await httpRequest(`${baseUrl}/api/monitor/usage/quota/limit`, {
    method: 'GET',
    headers: { 'Authorization': apiKey },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'API Key 无效' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  if (d.success === false) {
    return { supported: true, windows: [], error: d.msg || `API ${d.code || 'error'}` };
  }
  const limits = d.data?.limits || [];
  const windows = limits.map(l => ({
    // 智谱 unit 值: 3=5小时窗口, 5=月度, 6=周
    label: l.unit === 3 ? '5h' : l.unit === 6 ? 'weekly' : l.unit === 5 ? 'monthly' : 'limit',
    usedPercent: round1(l.percentage),
    resetAt: l.nextResetTime ? epochToISO(l.nextResetTime) : null,
  }));
  return { supported: true, windows, raw: d };
}

async function queryGlmCodingUsage(apiKey) {
  return queryZaiCodingUsage(apiKey, 'https://open.bigmodel.cn');
}

async function queryZaiGlobalCodingUsage(apiKey) {
  return queryZaiCodingUsage(apiKey, 'https://api.z.ai');
}

// Kimi Coding Plan — official endpoint returning limit/remaining per window.
async function queryKimiCodingUsage(apiKey) {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 API Key' };
  const result = await httpRequest('https://api.kimi.com/coding/v1/usages', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'API Key 无效' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  const windows = [];
  // limits[] = 5-hour window(s)
  if (Array.isArray(d.limits)) {
    for (const l of d.limits) {
      const det = l.detail || l;
      if (det.limit != null && det.remaining != null) {
        windows.push({
          label: '5h',
          usedPercent: round1(((det.limit - det.remaining) / det.limit) * 100),
          resetAt: det.resetTime || null,
        });
      }
    }
  }
  // usage = weekly window
  if (d.usage && d.usage.limit != null && d.usage.remaining != null) {
    windows.push({
      label: 'weekly',
      usedPercent: round1(((d.usage.limit - d.usage.remaining) / d.usage.limit) * 100),
      resetAt: d.usage.resetTime || null,
    });
  }
  return { supported: true, windows, raw: d };
}

// MiniMax Token Plan — official endpoint returning remaining percent.
// Domestic and international Token Plan keys use different API hosts. The
// current endpoint is /v1/token_plan/remains; keep the older coding_plan path
// as a compatibility fallback for older accounts/regions.
async function queryMinimaxCodingUsage(apiKey, apiHost = 'api.minimaxi.com') {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 API Key' };
  const currentHost = apiHost.includes('minimaxi.com') ? 'www.minimaxi.com' : 'www.minimax.io';
  const endpoints = [
    `https://${currentHost}/v1/token_plan/remains`,
    `https://${apiHost}/v1/token_plan/remains`,
    `https://${apiHost}/v1/api/openplatform/coding_plan/remains`,
  ];
  let lastError = null;

  for (const endpoint of endpoints) {
    const result = await httpRequest(endpoint, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000,
    });
    // A network failure is not fixed by trying legacy paths and would make
    // every refresh wait through three timeouts.
    if (result.error) return { supported: true, windows: [], error: result.error };
    if (result.status === 401) return { supported: true, windows: [], error: 'API Key 无效' };
    if (result.status !== 200 && result.status !== 404 && result.status !== 405) {
      return { supported: true, windows: [], error: `HTTP ${result.status}` };
    }
    if (result.status !== 200) {
      lastError = `HTTP ${result.status}`;
      continue;
    }

    let d;
    try { d = JSON.parse(result.body); } catch { lastError = '接口返回了无效 JSON'; continue; }
    const statusCode = d.base_resp?.status_code;
    if (statusCode && statusCode !== 0) {
      const message = d.base_resp?.status_msg || `API ${statusCode}`;
      if (statusCode === 2062) {
        return { supported: true, windows: [], error: '当前账号未开通 MiniMax Token Plan，或此 API Key 不属于 Token Plan。' };
      }
      return { supported: true, windows: [], error: message };
    }

    const remains = d.model_remains || d.data?.model_remains || [];
    const windows = minimaxWindows(remains);
    if (windows.length > 0 || Array.isArray(remains)) return { supported: true, windows, raw: d };
    lastError = '接口暂未返回 Token Plan 用量';
  }

  return { supported: true, windows: [], error: lastError || 'MiniMax Token Plan 查询失败' };
}

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

async function queryMinimaxGlobalCodingUsage(apiKey) {
  return queryMinimaxCodingUsage(apiKey, 'api.minimax.io');
}

// OpenRouter — account credits require a Management Key. The normal inference
// key endpoint (/api/v1/key) only describes that one key's usage/limit and
// must not be presented as the account's prepaid balance.
async function queryOpenRouterUsage() {
  const managementKey = await resolveFirstVaultKey(['OPENROUTER_MANAGEMENT_KEY']);
  if (!managementKey) {
    return managementCredentialNotice(
      'OpenRouter',
      ['OPENROUTER_MANAGEMENT_KEY'],
      'https://openrouter.ai/settings/management-keys',
    );
  }

  const result = await httpRequest('https://openrouter.ai/api/v1/credits', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${managementKey}` },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) {
    return {
      supported: true,
      windows: [],
      error: 'OpenRouter Management Key 无效或没有读取 Credits 的权限',
      action: { label: '打开 OpenRouter Management Keys', url: 'https://openrouter.ai/settings/management-keys' },
    };
  }
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    return { supported: true, windows: [], error: 'OpenRouter Credits 接口返回了无法识别的数据' };
  }

  return parseOpenRouterCredits(data)
    || { supported: true, windows: [], error: 'OpenRouter Credits 接口暂未返回可识别余额' };
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

async function resolveFirstVaultKey(names) {
  for (const name of names) {
    const value = await resolveVaultKey(name);
    if (value) return value;
  }
  return undefined;
}

async function resolveCredentialPair(pairNames) {
  const first = await resolveFirstVaultKey(pairNames.combined || []);
  if (first) {
    try {
      const parsed = JSON.parse(first);
      const accessKey = parsed.accessKey || parsed.accessKeyId || parsed.access_key_id || parsed.secretId;
      const secretKey = parsed.secretKey || parsed.secretAccessKey || parsed.secret_access_key || parsed.secretKeyId;
      if (accessKey && secretKey) return { accessKey, secretKey };
    } catch {}
  }
  const accessKey = await resolveFirstVaultKey(pairNames.accessKey || []);
  const secretKey = await resolveFirstVaultKey(pairNames.secretKey || []);
  return accessKey && secretKey ? { accessKey, secretKey } : undefined;
}

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

function managementCredentialNotice(label, keyNames, url) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: `${label} 需要单独的管理凭证才能查询余额，请在密钥管理中添加：${keyNames.join('、')}。推理 API Key 不能替代该凭证。`,
    action: { label: `打开 ${label} 控制台`, url },
  };
}

function manualCredentialPairNotice(label, combinedName, accessKeyName, secretKeyName, url) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: `${label}余额查询需要单独的云账号管理凭证，推理 API Key 不能替代。请在云控制台创建具有账务只读权限的 IAM/CAM 用户凭证，再到密钥管理手动录入 ${combinedName}，密钥值格式：{"accessKey":"...","secretKey":"..."}；也可分别录入 ${accessKeyName} 和 ${secretKeyName}。`,
    action: { label: `打开${label}凭证控制台`, url },
  };
}

// Kimi/Moonshot Open Platform — GET /v1/users/me/balance.
// This is an account balance, not the separate Kimi Coding Plan quota.
async function queryKimiApiBalance(apiKey, baseUrl) {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 Kimi API Key' };
  const origin = getOrigin(baseUrl) || 'https://api.moonshot.cn';
  const endpoints = [
    `${origin}/v1/users/me/balance`,
    'https://api.moonshot.cn/v1/users/me/balance',
    'https://api.moonshot.ai/v1/users/me/balance',
  ];
  let lastError = null;
  for (const endpoint of [...new Set(endpoints)]) {
    const result = await httpRequest(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: 10000,
    });
    if (result.error) { lastError = result.error; continue; }
    if (result.status === 401) return { supported: true, windows: [], error: 'Kimi API Key 无效' };
    if (result.status === 404 || result.status === 405) { lastError = `HTTP ${result.status}`; continue; }
    if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };
    let data;
    try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: 'Kimi 余额接口返回了无效 JSON' }; }
    const root = data.data || data;
    const amount = root.available_balance ?? root.availableBalance ?? root.cash_balance ?? root.cashBalance;
    const parsed = accountBalanceResult(amount, 'CNY', data);
    if (parsed) return parsed;
    return { supported: true, windows: [], error: 'Kimi 余额接口暂未返回可识别的余额' };
  }
  return { supported: true, windows: [], error: lastError || 'Kimi 余额接口暂不可用' };
}

// Alibaba Cloud BSS RPC — QueryAccountBalance. The DashScope API key is not a
// billing credential; use an Aliyun/RAM AccessKey with billing read permission.
async function queryAlibabaBalance() {
  const credentials = await resolveCredentialPair({
    combined: ['ALIYUN_BILLING_CREDENTIALS', 'ALIBABA_CLOUD_CREDENTIALS'],
    accessKey: ['ALIYUN_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'QWEN_ACCESS_KEY_ID'],
    secretKey: ['ALIYUN_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'QWEN_ACCESS_KEY_SECRET'],
  });
  if (!credentials) return managementCredentialNotice('阿里云百炼', ['ALIYUN_ACCESS_KEY_ID（手动录入）', 'ALIYUN_ACCESS_KEY_SECRET（手动录入）'], 'https://ram.console.aliyun.com/profile/accessKey');

  const result = await callAlibabaRpc(credentials.accessKey, credentials.secretKey, 'QueryAccountBalance', '2017-12-14');
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) return { supported: true, windows: [], error: '阿里云 AccessKey 无账务查询权限' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };
  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: '阿里云余额接口返回了无效 JSON' }; }
  const root = data.Data || data.data || data;
  const amount = root.AvailableAmount ?? root.availableAmount ?? root.AccountBalance ?? root.accountBalance ?? root.CashBalance ?? root.cashBalance;
  const parsed = accountBalanceResult(amount, 'CNY', data);
  return parsed || { supported: true, windows: [], error: '阿里云余额接口暂未返回可识别的可用余额' };
}

function callAlibabaRpc(accessKeyId, accessKeySecret, action, version) {
  const crypto = require('crypto');
  const encode = value => encodeURIComponent(String(value))
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
  const params = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: version,
  };
  const canonicalQuery = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${encode(canonicalQuery)}`;
  params.Signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  const query = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  return new Promise(resolve => {
    const req = require('https').get(`https://business.aliyuncs.com/?${query}`, { headers: { Accept: 'application/json' }, timeout: 10000 }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', error => resolve({ error: error.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
  });
}

// Baidu BCE Finance — POST /v1/finance/cash/balance.
async function queryQianfanBalance() {
  const credentials = await resolveCredentialPair({
    combined: ['QIANFAN_BCE_CREDENTIALS', 'BAIDU_BCE_CREDENTIALS'],
    accessKey: ['QIANFAN_ACCESS_KEY_ID', 'BCE_ACCESS_KEY_ID', 'BAIDU_BCE_ACCESS_KEY_ID'],
    secretKey: ['QIANFAN_SECRET_ACCESS_KEY', 'BCE_SECRET_ACCESS_KEY', 'BAIDU_BCE_SECRET_ACCESS_KEY'],
  });
  if (!credentials) {
    return manualCredentialPairNotice(
      '百度千帆',
      'QIANFAN_BCE_CREDENTIALS',
      'QIANFAN_ACCESS_KEY_ID',
      'QIANFAN_SECRET_ACCESS_KEY',
      'https://console.bce.baidu.com/iam/#/iam/accesslist',
    );
  }
  const host = 'billing.baidubce.com';
  const pathName = '/v1/finance/cash/balance';
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const headers = {
    Host: host,
    'x-bce-date': timestamp,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': '0',
  };
  const { authorization } = buildBceAuthorization({
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
    method: 'POST',
    pathName,
    headers,
    timestamp,
  });
  const result = await httpRequest(`https://${host}${pathName}`, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status !== 200) {
    const bceError = parseBceError(result.body);
    const detail = [bceError.code, bceError.message].filter(Boolean).join('：');
    if (/accessdenied|forbidden|permission|not authorized|no.?permission/i.test(detail)) {
      return { supported: true, windows: [], error: '百度 BCE AccessKey 已通过签名验证，但缺少 FCReadAccessPolicy（财务中心只读权限）' };
    }
    if (/signaturedoesnotmatch|signature|authentication|authfailure/i.test(detail)) {
      return { supported: true, windows: [], error: `百度 BCE 请求签名失败${bceError.code ? `（${bceError.code}）` : ''}` };
    }
    if (/invalidaccesskey|could not find credential|credential.*not found/i.test(detail)) {
      return { supported: true, windows: [], error: `百度 BCE AccessKey 无效或 AK/SK 不匹配${bceError.code ? `（${bceError.code}）` : ''}` };
    }
    return {
      supported: true,
      windows: [],
      error: `百度余额查询失败（HTTP ${result.status}${bceError.code ? ` · ${bceError.code}` : ''}）${bceError.message ? `：${bceError.message}` : ''}`,
    };
  }
  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: '百度余额接口返回了无效 JSON' }; }
  const root = data.data || data;
  const parsed = accountBalanceResult(root.cashBalance ?? root.CashBalance ?? root.cash_balance, 'CNY', data);
  return parsed || { supported: true, windows: [], error: '百度余额接口暂未返回可识别余额' };
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
async function queryXaiApiBalance() {
  const managementKey = await resolveFirstVaultKey(['XAI_MANAGEMENT_KEY', 'XAI_BILLING_MANAGEMENT_KEY']);
  let teamId = await resolveFirstVaultKey(['XAI_TEAM_ID', 'XAI_MANAGEMENT_TEAM_ID']);
  if (!managementKey) return managementCredentialNotice('xAI API', ['XAI_MANAGEMENT_KEY'], 'https://console.x.ai/team/default/settings/management-keys');

  // The management-key validation endpoint returns the scope/team id. This
  // keeps the auto-create flow to one secret and avoids asking users to copy a
  // non-secret team identifier into Vault manually.
  if (!teamId) {
    const validation = await httpRequest('https://management-api.x.ai/auth/management-keys/validation', {
      method: 'GET',
      headers: { Authorization: `Bearer ${managementKey}`, Accept: 'application/json' },
      timeout: 10000,
    });
    if (validation.error) return { supported: true, windows: [], error: validation.error };
    if (validation.status === 401 || validation.status === 403) return { supported: true, windows: [], error: 'xAI Management Key 无权限或已失效' };
    if (validation.status !== 200) return { supported: true, windows: [], error: `xAI Management Key 校验失败（HTTP ${validation.status}）` };
    try {
      const data = JSON.parse(validation.body);
      teamId = data.scopeId || data.teamId || data.scope_id || data.team_id;
    } catch {}
    if (!teamId) return { supported: true, windows: [], error: 'xAI Management Key 未返回可识别的 Team ID，请添加 XAI_TEAM_ID' };
  }

  const result = await httpRequest(`https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${managementKey}`, Accept: 'application/json' },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) return { supported: true, windows: [], error: 'xAI Management Key 无权限或已失效' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };
  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: 'xAI 余额接口返回了无效 JSON' }; }
  const parsed = parseXaiPrepaidBalance(data);
  return parsed || { supported: true, windows: [], error: 'xAI 余额接口暂未返回可识别余额' };
}

// ── Goal ①: prepaid balance providers ────────────────────────
//
// Each returns a single "credits" window with absolute USD amounts (no reset
// time — pay-as-you-go balances don't reset). The isPrepaid flag drives the
// frontend's dollar-amount rendering instead of a percentage bar.

// DeepSeek — GET /user/balance returns { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }.
// Note: the field is balance_infos (plural array), not balance_info.
async function queryDeepseekUsage(apiKey) {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 API Key' };
  const result = await httpRequest('https://api.deepseek.com/user/balance', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'API Key 无效' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  // Pick the CNY entry (DeepSeek's primary billing currency); fall back to first.
  const infos = Array.isArray(d.balance_infos) ? d.balance_infos : [];
  const info = infos.find(i => i.currency === 'CNY') || infos[0] || {};
  const total = round4(parseFloat(info.total_balance ?? 0));
  return {
    supported: true,
    windows: [{
      label: 'credits',
      usedPercent: null,
      usedCredits: null,
      limitCredits: total,
      remainingCredits: total,
      isPrepaid: true,
    }],
    raw: d,
  };
}

// 硅基流动 (SiliconFlow) — GET /v1/user/info returns { data: { balance, ... } }.
async function querySiliconflowUsage(apiKey) {
  if (!apiKey) return { supported: true, windows: [], error: '无可用 API Key' };
  const result = await httpRequest('https://api.siliconflow.cn/v1/user/info', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000,
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401) return { supported: true, windows: [], error: 'API Key 无效' };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };

  const d = JSON.parse(result.body);
  const balance = round4(d.data?.balance ?? 0);
  return {
    supported: true,
    windows: [{
      label: 'credits',
      usedPercent: null,
      usedCredits: null,
      limitCredits: balance,
      remainingCredits: balance,
      isPrepaid: true,
    }],
    raw: d,
  };
}

// Moonshot/Kimi Open Platform — use the provider's regional API host while
// keeping this separate from the Kimi Coding Plan quota endpoint.
async function queryMoonshotUsage(apiKey, baseUrl) {
  return queryKimiApiBalance(apiKey, baseUrl);
}

// Mistral — no public balance/credits API exists (all candidate endpoints return
// 404). Point users at the console.
async function queryMistralUsage(_apiKey) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: 'Mistral 暂无公开的余额查询 API，请在 Mistral Console 的 Billing 页面查看。',
  };
}

// 通义千问 (Qwen / DashScope) — account balance is exposed through Alibaba
// Cloud's signed billing API, not through the model API key. Do not call the
// old /compatible-mode/v1/usage path: it returns 404/405 for current accounts.
async function queryQwenUsage(_apiKey) {
  return queryAlibabaBalance();
}

// The Coding Plan endpoint is intentionally restricted to supported coding
// agents and does not expose a public quota endpoint for OKIT to call.
async function queryQwenCodingUsage(_apiKey) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '阿里云百炼 Coding Plan 用量请在百炼控制台的 Coding Plan 页面查看。该套餐接口仅供官方 Coding Agent 使用。',
    action: { label: '打开百炼套餐页', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan' },
  };
}

// Alibaba Token Plan exposes the plan and Credits on its subscription console,
// but the public inference API does not expose a personal quota endpoint.
// Keep this explicit instead of treating a model request as a usage probe.
async function queryQwenTokenPlanUsage(_apiKey) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: '阿里云百炼 Token Plan 用量请在“我的订阅”页面查看，当前没有可用的个人套餐用量 API。',
    action: { label: '打开百炼 Token Plan', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan' },
  };
}

// Qianfan Token Plan personal usage is exposed by a console-only endpoint. It
// requires the logged-in console page's session, not the inference API key.
  return { loadProviders, resolveVaultKey, resolveFirstVaultKey, resolveCredentialPair, managementCredentialNotice, queryCodexUsage, queryClaudeUsage, queryZaiCodingUsage, queryGlmCodingUsage, queryZaiGlobalCodingUsage, queryKimiCodingUsage, queryMinimaxCodingUsage, queryMinimaxGlobalCodingUsage, queryOpenRouterUsage, queryKimiApiBalance, queryAlibabaBalance, queryQianfanBalance, queryXaiApiBalance, queryDeepseekUsage, querySiliconflowUsage, queryMoonshotUsage, queryMistralUsage, queryQwenUsage, queryQwenCodingUsage, queryQwenTokenPlanUsage };
}

module.exports = { createUsageApiStrategies };
