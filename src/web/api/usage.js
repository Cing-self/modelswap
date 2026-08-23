// Usage / quota query for subscription-based providers, agents, and prepaid
// balance providers.
//
// Supports providers that have a live API or a reliable console-only fallback,
// all using existing credentials
// (no extra admin keys needed):
//
//   Codex (ChatGPT sub)  → OAuth token from ~/.codex/auth.json
//   Claude Code (sub)    → OAuth token from ~/.claude/.credentials.json
//   GLM Coding Plan      → Coding Plan API key (same as inference)
//   Kimi Coding Plan     → Coding Plan API key (same as inference)
//   MiniMax Token Plan   → Token Plan API key (same as inference)
//   OpenRouter           → Management Key (account credits; separate from inference)
//
// Unified response shape:
//   { providerId, supported: true, windows: [{ label, usedPercent, resetAt }], raw }
//
// Unsupported providers return { supported: false } so the UI can show a
// "console-only" hint without an error.

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const OKIT_DIR = path.join(os.homedir(), '.okit');
const PROVIDERS_PATH = path.join(OKIT_DIR, 'providers.json');
const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/console/plan-manage';
const MIMO_BALANCE_CONSOLE_URL = 'https://platform.xiaomimimo.com/console/balance';
const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance';
const MIMO_SESSION_VAULT_KEY = 'XIAOMI_MIMO_TOKEN_PLAN_SESSION_COOKIE';

// Providers we can query. Keyed by provider preset id.
const SUPPORTED = new Set([
  'anthropic',        // Anthropic API (console-only billing)
  'openai-codex',    // Codex (ChatGPT subscription)
  'openai',           // OpenAI API (organization billing)
  'anthropic-agent', // Claude Code Agent subscription (Pro/Max)
  'xai-grok-build',  // Grok subscription (console-only stats)
  'github-copilot',  // GitHub Copilot subscription (GitHub billing stats)
  'glm-coding',      // GLM Coding Plan
  'zai-global-coding', // Z.AI Coding Plan
  'kimi-coding-plan',// Kimi Coding Plan
  'minimax-coding',  // Legacy provider ID; product name is MiniMax Token Plan
  'minimax-global-coding', // Legacy provider ID; product name is MiniMax Token Plan (international)
  'minimax',         // MiniMax API (console-only balance)
  'minimax-global',  // MiniMax API (international, console-only balance)
  'zai',              // 智谱 API (console-only balance)
  'zai-global',       // Z.AI API (console-only balance)
  'kimi-coding',     // Kimi API balance
  'openrouter',      // OpenRouter (prepaid balance)
  'volcengine',      // 火山引擎 API account balance
  'volcengine-coding', // 火山引擎 Coding Plan (needs AK/SK)
  'volcengine-agent', // 火山引擎 Agent Plan (needs AK/SK)
  'qwen-coding',      // 阿里云百炼 Coding Plan (console-only usage)
  'qwen-token-plan',  // 阿里云百炼 Token Plan (console-only usage)
  'qianfan-coding',   // 百度千帆 Token Plan (console-only usage)
  'tencent-token-plan', // 腾讯云 Token Plan (console-only usage)
  'opencode-go',      // OpenCode Go (console-only usage)
  'xiaomi-coding',    // 小米 MiMo Token Plan (console-only usage)
  'xiaomi',           // 小米 MiMo API (console-only balance)
  'qianfan',          // 百度千帆 API account balance
  'tencent',          // 腾讯云 API/TokenHub billing
  'xai',              // xAI API prepaid balance
  'stepfun',          // 阶跃星辰 (console-only balance)
  'stepfun-global',   // StepFun Global (console-only balance)
  // Goal ①: prepaid / pay-as-you-go balance providers.
  'deepseek',        // DeepSeek (充值制)
  'siliconflow',     // 硅基流动 (充值制)
  'moonshot',        // Moonshot (充值制)
  'mistral',         // Mistral (充值制)
  'qwen',            // 通义千问 (充值制)
]);

// Goal ①: classifies each supported provider so the frontend can split the
// usage page into Subscription (percentage + reset) vs Prepaid (balance) tabs.
// SUBSCRIPTION = quota-limited with a reset window (reported as usedPercent).
// PREPAID      = pay-as-you-go balance (reported as absolute credit amounts).
const UsageKind = { SUBSCRIPTION: 'subscription', PREPAID: 'prepaid' };
const PROVIDER_KIND = {
  // Subscription / coding-plan providers
  'anthropic': UsageKind.PREPAID,
  'openai': UsageKind.PREPAID,
  'openai-codex': UsageKind.SUBSCRIPTION,
  'anthropic-agent': UsageKind.SUBSCRIPTION,
  'xai-grok-build': UsageKind.SUBSCRIPTION,
  'github-copilot': UsageKind.SUBSCRIPTION,
  'glm-coding': UsageKind.SUBSCRIPTION,
  'zai-global-coding': UsageKind.SUBSCRIPTION,
  'kimi-coding-plan': UsageKind.SUBSCRIPTION,
  'minimax-coding': UsageKind.SUBSCRIPTION,
  'minimax-global-coding': UsageKind.SUBSCRIPTION,
  'qwen-coding': UsageKind.SUBSCRIPTION,
  'qwen-token-plan': UsageKind.SUBSCRIPTION,
  'qianfan-coding': UsageKind.SUBSCRIPTION,
  'tencent-token-plan': UsageKind.SUBSCRIPTION,
  'opencode-go': UsageKind.SUBSCRIPTION,
  'volcengine-coding': UsageKind.SUBSCRIPTION,
  'volcengine-agent': UsageKind.SUBSCRIPTION,
  'volcengine': UsageKind.PREPAID,
  'xiaomi-coding': UsageKind.SUBSCRIPTION,
  'minimax': UsageKind.PREPAID,
  'minimax-global': UsageKind.PREPAID,
  'zai': UsageKind.PREPAID,
  'zai-global': UsageKind.PREPAID,
  'kimi-coding': UsageKind.PREPAID,
  'xiaomi': UsageKind.PREPAID,
  'qianfan': UsageKind.PREPAID,
  'tencent': UsageKind.PREPAID,
  'xai': UsageKind.PREPAID,
  'stepfun': UsageKind.PREPAID,
  'stepfun-global': UsageKind.PREPAID,
  // Prepaid / balance providers
  'openrouter': UsageKind.PREPAID,
  'deepseek': UsageKind.PREPAID,
  'siliconflow': UsageKind.PREPAID,
  'moonshot': UsageKind.PREPAID,
  'mistral': UsageKind.PREPAID,
  'qwen': UsageKind.PREPAID,
};

async function loadProviders() {
  if (!(await fs.pathExists(PROVIDERS_PATH))) return [];
  try {
    const content = await fs.readFile(PROVIDERS_PATH, 'utf-8');
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
  try { bridge = require('./ws-extension'); } catch { return null; }
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

  if (!apiKey) return { supported: true, windows: [], error: '无可用 MiMo Token Plan Key' };

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
      const loginUrl = getTrustedXiaomiLoginUrl(result.body);
      return {
        supported: true,
        windows: [],
        source: 'console',
        notice: 'MiMo 用量接口需要登录态。点击下方按钮后，在 OKIT 浏览器插件打开的 MiMo 控制台中登录；完成后回到这里点击刷新。',
        action: { label: '在 OKIT 插件中登录', url: loginUrl, mode: 'extension' },
      };
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

async function resolveVolcCredentials() {
  const credentials = await resolveCredentialPair({
    combined: ['VOLCENGINE_BILLING_CREDENTIALS', 'VOLCENGINE_CREDENTIALS'],
    accessKey: ['VOLC_ARK_AK', 'VOLCENGINE_ACCESS_KEY'],
    secretKey: ['VOLC_ARK_SK', 'VOLCENGINE_SECRET_KEY'],
  });
  return credentials;
}

async function queryVolcengineBalance() {
  const credentials = await resolveVolcCredentials();
  if (!credentials) return managementCredentialNotice('火山引擎', ['VOLCENGINE_BILLING_CREDENTIALS（请按文档手动录入）', 'VOLCENGINE_ACCESS_KEY', 'VOLCENGINE_SECRET_KEY'], 'https://console.volcengine.com/iam/keymanage/');
  const result = await callVolcApi(credentials.accessKey, credentials.secretKey, 'QueryBalanceAcct', {
    service: 'billing',
    version: '2022-01-01',
  });
  if (result.error) return { supported: true, windows: [], error: result.error };
  if (result.status === 401 || result.status === 403) return {
    supported: true,
    windows: [],
    error: '火山引擎 AK/SK 无费用中心查询权限。请给当前 IAM 用户授予 BillingCenterReadOnlyAccess（仅查询余额），或按需授予 BillingCenterFullAccess；无需再创建主账号 Access Key。',
  };
  if (result.status !== 200) return { supported: true, windows: [], error: `HTTP ${result.status}` };
  let data;
  try { data = JSON.parse(result.body); } catch { return { supported: true, windows: [], error: '火山引擎余额接口返回了无效 JSON' }; }
  const root = data.Result || data.result || data;
  const parsed = accountBalanceResult(root.AvailableBalance ?? root.availableBalance, 'CNY', data);
  return parsed || { supported: true, windows: [], error: '火山引擎余额接口暂未返回可识别余额' };
}

async function openXiaomiLogin(req, res) {
  if (req.params.providerId !== 'xiaomi-coding') {
    return res.status(400).json({ success: false, error: '该 Provider 不支持浏览器登录' });
  }
  try {
    const { sendCommand, isExtensionConnected } = require('./ws-extension');
    if (!isExtensionConnected()) {
      return res.status(503).json({ success: false, error: 'OKIT 浏览器插件未连接，请先启动插件' });
    }
    const navigation = await sendCommand('navigate', {
      url: MIMO_CONSOLE_URL,
      workspace: 'okit',
    }, 30000);
    if (!navigation?.ok) {
      return res.status(502).json({ success: false, error: navigation?.error || '无法打开 MiMo 控制台' });
    }
    await sendCommand('focus-window', { workspace: 'okit', hold: true }, 10000).catch(() => {});
    res.json({ success: true, tabId: navigation.data?.tabId, url: MIMO_CONSOLE_URL });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message || String(error) });
  }
}

// 火山引擎 Coding Plan / Agent Plan — requires AK/SK with ark:Read permission.
// Uses Volcengine Signature V4 (a variant of AWS SigV4) on the control-plane
// gateway open.volcengineapi.com. The inference API key cannot be used here.
// Keep the two plan APIs separate: an account may have either plan, and a
// successful response from one must never be shown on the other card.
async function queryVolcengineUsage(plan = 'coding') {
  // Resolve only explicitly named Volcengine credentials. A local Vault name
  // is not provider-side synchronization, so KMS entries must never be
  // treated as Volcengine AK/SK merely because their old name looks similar.
  const combined = await resolveVolcCredentials();
  let ak = combined?.accessKey || await resolveVaultKey('VOLC_ARK_AK') || await resolveVaultKey('VOLC_ARK_AK-default');
  let sk = combined?.secretKey || await resolveVaultKey('VOLC_ARK_SK') || await resolveVaultKey('VOLC_ARK_SK-default');
  if (!ak || !sk) return { supported: true, windows: [], error: '未找到火山引擎 AK/SK，请按文档手动添加 VOLCENGINE_BILLING_CREDENTIALS，或分别添加 VOLC_ARK_AK 和 VOLC_ARK_SK' };

  if (plan === 'agent') {
    // Agent Plan exposes absolute quota windows through GetAFPUsage.
    const afpResult = await callVolcApi(ak, sk, 'GetAFPUsage');
    if (afpResult.error) return { supported: true, windows: [], error: afpResult.error };
    if (afpResult.status === 403) return { supported: true, windows: [], error: 'AK/SK 无 ark 服务权限，请授予 ArkReadOnlyAccess' };
    if (afpResult.status !== 200) return { supported: true, windows: [], error: `HTTP ${afpResult.status}` };

    const afpData = JSON.parse(afpResult.body);
    const result = afpData.Result || {};
    const windows = [];
    const tiers = [
      { key: 'AFPFiveHour', label: '5h' },
      { key: 'AFPWeekly', label: 'weekly' },
      { key: 'AFPMonthly', label: 'monthly' },
    ];
    for (const tier of tiers) {
      const w = result[tier.key];
      if (w && w.Quota > 0) {
        windows.push({
          label: tier.label,
          usedPercent: round1((w.Used / w.Quota) * 100),
          resetAt: w.ResetTime ? epochToISO(w.ResetTime) : null,
        });
      }
    }
    return windows.length
      ? { supported: true, windows, raw: afpData }
      : { supported: true, windows: [], error: '当前账号未开通火山引擎 Agent Plan，或接口未返回额度' };
  }

  // Coding Plan exposes percentage windows through GetCodingPlanUsage.
  const cpResult = await callVolcApi(ak, sk, 'GetCodingPlanUsage');
  if (cpResult.error) return { supported: true, windows: [], error: cpResult.error };
  if (cpResult.status !== 200) {
    if (cpResult.status === 403) return { supported: true, windows: [], error: 'AK/SK 无 ark 服务权限' };
    return { supported: true, windows: [], error: `HTTP ${cpResult.status}` };
  }

  const cpData = JSON.parse(cpResult.body);
  const cpResult2 = cpData.Result || {};
  const quotaUsage = cpResult2.QuotaUsage || [];
  const windows = quotaUsage.map(q => ({
    label: q.Level === 'session' ? '5h' : q.Level === 'weekly' ? 'weekly' : q.Level === 'monthly' ? 'monthly' : q.Level,
    // Percent is a 0-1 decimal, multiply by 100.
    usedPercent: round1((q.Percent || 0) * 100),
    resetAt: q.ResetTimestamp ? epochToISO(q.ResetTimestamp) : null,
  })).filter(w => w.usedPercent !== null);

  return windows.length
    ? { supported: true, windows, raw: cpData }
    : { supported: true, windows: [], error: '当前账号未开通火山引擎 Coding Plan，或接口未返回额度' };
}

// Volcengine Signature V4 signer + API caller.
function callVolcApi(ak, sk, action, options = {}) {
  const crypto = require('crypto');
  return new Promise(resolve => {
    const now = new Date();
    const xDate = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const shortDate = xDate.slice(0, 8);
    const region = options.region || 'cn-beijing';
    const service = options.service || 'ark';
    const host = 'open.volcengineapi.com';
    const version = options.version || '2024-01-01';
    const canonicalQuery = `Action=${action}&Region=${region}&Version=${version}`;
    const body = '';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const signedHeaders = 'host;x-content-sha256;x-date';
    const canonicalHeaders = `host:${host}\nx-content-sha256:${bodyHash}\nx-date:${xDate}\n`;
    const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
    const credentialScope = `${shortDate}/${region}/${service}/request`;
    const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

    // Volcengine variant: kDate = HMAC(SK, date) — no prefix, no AWS4.
    const kDate = crypto.createHmac('sha256', sk).update(shortDate).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = require('https').request(`https://${host}/?${canonicalQuery}`, {
      method: 'POST',
      headers: { Host: host, 'X-Date': xDate, 'X-Content-Sha256': bodyHash, Authorization: authorization, 'Content-Type': 'application/json' },
      timeout: 10000,
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}

function queryConsoleOnlyUsage(label, url, detail) {
  return {
    supported: true,
    windows: [],
    source: 'console',
    notice: detail || `${label}当前没有公开的个人余额查询接口，请在控制台 Billing/用量页面查看。`,
    action: { label: `打开${label}控制台`, url },
  };
}

// ── Dispatcher ───────────────────────────────────────────────

async function queryUsage(providerId) {
  // OAuth-based agents — read token from disk, no vault key needed.
  if (providerId === 'openai-codex') {
    return queryCodexUsage();
  }

  const providers = await loadProviders();
  const provider = providers.find(p => p.id === providerId);
  if (!provider) {
    return { supported: false, error: 'Provider 不存在' };
  }

  // Claude subscription uses OAuth, not the vault key.
  if (providerId === 'anthropic' || providerId === 'anthropic-agent') {
    return providerId === 'anthropic-agent'
      ? queryClaudeUsage(provider)
      : queryConsoleOnlyUsage('Anthropic', 'https://console.anthropic.com/settings/billing');
  }

  if (providerId === 'github-copilot') {
    return {
      supported: true,
      windows: [],
      source: 'console',
      notice: 'GitHub Copilot 订阅用量请在 GitHub Billing and licensing 或 Copilot 客户端的配额页面查看。当前没有可复用的个人订阅用量接口。',
    };
  }

  if (providerId === 'xai-grok-build') {
    return queryConsoleOnlyUsage('SuperGrok', 'https://grok.com/', 'SuperGrok 是订阅产品，与 xAI API 余额分开；目前没有公开稳定的个人订阅用量接口。');
  }

  // Volcengine Coding Plan needs AK/SK (control-plane SigV4), not the inference key.
  if (providerId === 'volcengine-coding' || providerId === 'volcengine-agent') {
    return queryVolcengineUsage(providerId === 'volcengine-agent' ? 'agent' : 'coding');
  }

  if (providerId === 'volcengine') return queryVolcengineBalance();

  // API-key-based providers — resolve key from vault.
  const apiKey = provider.vaultKey ? await resolveVaultKey(provider.vaultKey) : undefined;

  switch (providerId) {
    case 'openai':
      return queryConsoleOnlyUsage('OpenAI API', 'https://platform.openai.com/usage', 'OpenAI API 的用量/费用需要组织 Admin Key；普通 API Key 不提供剩余额度接口。');
    case 'zai':
      return queryConsoleOnlyUsage('智谱 AI', 'https://open.bigmodel.cn/finance/overview');
    case 'zai-global':
      return queryConsoleOnlyUsage('Z.AI', 'https://z.ai/manage-apikey/billing');
    case 'minimax':
      return queryConsoleOnlyUsage('MiniMax', 'https://platform.minimaxi.com/user-center/payment');
    case 'minimax-global':
      return queryConsoleOnlyUsage('MiniMax 国际站', 'https://platform.minimax.io/user-center/payment');
    case 'kimi-coding':
      return queryKimiApiBalance(apiKey, provider.baseUrl);
    case 'qianfan':
      return queryQianfanBalance();
    case 'tencent':
      return queryTencentBalance();
    case 'xai':
      return queryXaiApiBalance();
    case 'stepfun':
      return queryConsoleOnlyUsage('阶跃星辰', 'https://platform.stepfun.com/console/billing');
    case 'stepfun-global':
      return queryConsoleOnlyUsage('StepFun Global', 'https://platform.stepfun.ai/console/billing');
    case 'xiaomi':
      return queryXiaomiBalance();
    case 'glm-coding':
      return queryGlmCodingUsage(apiKey);
    case 'zai-global-coding':
      return queryZaiGlobalCodingUsage(apiKey);
    case 'kimi-coding-plan':
      return queryKimiCodingUsage(apiKey);
    case 'minimax-coding':
      return queryMinimaxCodingUsage(apiKey);
    case 'minimax-global-coding':
      return queryMinimaxGlobalCodingUsage(apiKey);
    case 'qwen-coding':
      return queryQwenCodingUsage(apiKey);
    case 'qwen-token-plan':
      return queryQwenTokenPlanUsage(apiKey);
    case 'qianfan-coding':
      return queryQianfanCodingUsage(apiKey);
    case 'tencent-token-plan':
      return queryTencentTokenPlanUsage(apiKey);
    case 'opencode-go':
      return queryOpenCodeGoUsage(apiKey);
    case 'xiaomi-coding':
      return queryXiaomiCodingUsage(apiKey, provider.baseUrl);
    case 'openrouter':
      return queryOpenRouterUsage();
    // Goal ①: prepaid balance providers.
    case 'deepseek':
      return queryDeepseekUsage(apiKey);
    case 'siliconflow':
      return querySiliconflowUsage(apiKey);
    case 'moonshot':
      return queryMoonshotUsage(apiKey, provider.baseUrl);
    case 'mistral':
      return queryMistralUsage(apiKey);
    case 'qwen':
      return queryQwenUsage(apiKey);
    default:
      return { supported: false };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function round1(n) { return Math.round((n || 0) * 10) / 10; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }
function epochToISO(ts) {
  // Accept epoch seconds or epoch millis.
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

// ── Express handler ──────────────────────────────────────────

async function getUsage(req, res) {
  const { providerId } = req.params;
  if (!providerId) {
    return res.status(400).json({ error: 'providerId required' });
  }
  try {
    const result = await queryUsage(providerId);
    // Goal ①: stamp the usage kind on every response so the frontend can split
    // subscription vs prepaid cards without re-deriving the classification.
    if (result && result.supported !== false) {
      result.kind = PROVIDER_KIND[providerId] || UsageKind.SUBSCRIPTION;
    }
    res.json(result);
  } catch (err) {
    res.json({ supported: false, error: err.message });
  }
}

// Returns the set of provider IDs that support usage queries, so the
// frontend can decide whether to show a "usage" button per provider.
//
// manualOnly: providers whose usage query DRIVES the browser (opens/navigates
// the OKIT automation window via the extension). These must never run from
// background auto-refresh — only from an explicit user action (per-card
// refresh or the manual "refresh all" button).
const MANUAL_ONLY_USAGE = ['opencode-go'];

function getSupportedUsageProviders(_req, res) {
  res.json({ providers: Array.from(SUPPORTED), manualOnly: MANUAL_ONLY_USAGE });
}

module.exports = { getUsage, getSupportedUsageProviders, queryUsage, parseOpenRouterCredits, parseXaiPrepaidBalance, parseXiaomiBalance, parseXiaomiTokenPlanUsage, parseOpenCodeGoUsage, parseQianfanTokenPlanUsage, buildBceAuthorization, openXiaomiLogin };
