/**
 * Auto-create API keys for supported platforms.
 * Cloudflare: REST API (POST /client/v4/user/tokens)
 * Volcengine / Zhipu / MiniMax: Chrome Extension browser automation
 */

const https = require('https');
const crypto = require('crypto');
const { sendCommand, sendToExtension, isExtensionConnected } = require('./ws-extension');

// Interactive browser runs need a small amount of server-side state so a
// security gate can pause the exact in-flight browser flow. Re-running the
// create endpoint after a CAPTCHA is unsafe: it can create duplicate keys.
const AUTO_CREATE_RUNS = new Map();
const AUTO_CREATE_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;
const AUTO_CREATE_RUN_RESULT_TTL_MS = 10 * 60 * 1000;

// ─── Cloudflare REST API ───────────────────────────────────────────

async function createCloudflareToken({ parentToken, tokenName }) {
  const body = JSON.stringify({
    name: tokenName,
    policies: [{
      effect: 'allow',
      permission_groups: [
        { id: 'c8fed203ed3043cba015a93ad1616f1f' },
        { id: '82e64a83756745bbbb1c9c2701bf816b' },
      ],
      resources: { 'com.cloudflare.api.account.*': '*' },
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${parentToken}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) resolve({ value: json.result.value, name: json.result.name, id: json.result.id });
          else reject(new Error(json.errors?.[0]?.message || 'Cloudflare API error'));
        } catch { reject(new Error('Failed to parse Cloudflare response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deleteCloudflareToken({ parentToken, tokenId }) {
  if (!parentToken || !tokenId) throw new Error('Cloudflare 删除测试 Token 缺少 parentToken 或 tokenId');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/user/tokens/${encodeURIComponent(tokenId)}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${parentToken}` },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300 && json.success !== false) return resolve(json);
          reject(new Error(json.errors?.[0]?.message || `Cloudflare 删除失败（HTTP ${res.statusCode}）`));
        } catch { reject(new Error('Cloudflare 删除接口返回了无效 JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Zhipu (智谱AI) — atomic-capability orchestration ──────────────
// Orchestrates the zhipu API key creation flow by composing generic
// extension atoms (navigate / exec / network-capture-*). The extension
// knows nothing about zhipu — all platform specifics live here.
//
// Flow: navigate → arm network capture → dismiss popups → click "create"
//       → fill name → click "confirm" → read captured API response → extract key.

// Selectors derived from the proven Playwright script (src/scripts/auto-create-key.mjs).
const ZHIPU_URL = 'https://open.bigmodel.cn/apikey/platform';
// Only exact bilingual API-Key phrases: generic "Add/新建/创建新/添加新的" labels
// are far too broad to safely trigger credential creation and must never match.
const ZHIPU_CREATE_TEXTS = [
  '新建API Key',
  '新建 API Key',
  '创建API Key',
  '创建 API Key',
  'Create API Key',
  'Create Key',
  'New API Key',
];
const ZHIPU_CONFIRM_TEXTS = ['确定', '确认', '创建', '保存', 'OK', 'Confirm', 'Create', 'Save'];
const ZHIPU_NAME_SELECTORS = 'input[placeholder*="名称"],input[placeholder*="描述"],input[id*="name"],input[placeholder*="name" i],input[placeholder*="Name" i]';

/** Validate a full zhipu API key: exactly 32 lowercase hex chars, a single
 *  dot, then at least 6 ASCII alphanumerics. Masked or elided values
 *  (asterisks, underscore-run ellipses, single-character ellipsis) are always
 *  rejected so a partial/redacted capture can never be saved as a key. */
function isValidZhipuApiKey(value) {
  if (typeof value !== 'string') return false;
  if (/[*…]|\.{3}/.test(value)) return false;
  return /^[a-f0-9]{32}\.[a-zA-Z0-9]{6,}$/.test(value);
}

/** Gate a captured candidate value for the platform's key shape. Zhipu is the
 *  only platform that requires the full id.secret format; everything else is
 *  accepted exactly as before once the ordinary asset/masked checks pass. */
function isValidExtractionForPlatform(value, platform) {
  if (!value || isAssetData(value)) return null;
  if (platform === 'zhipu') return isValidZhipuApiKey(value) ? value : null;
  return value;
}

// Billing and plan-usage APIs for several cloud providers use a management
// AccessKey pair rather than the provider's inference API key. Store the pair
// as JSON in one Vault entry so the usage adapters can consume it atomically:
// { accessKey, secretKey }.
// Account-level cloud management credentials are manual-only. Automatic key
// creation is reserved for product API keys whose scope and lifecycle OKIT can
// safely verify. Pair parsing remains available for manually stored JSON.
const CREDENTIAL_PAIR_PLATFORMS = new Set();

function normalizeCredentialFieldName(name) {
  return String(name || '').replace(/[_-]/g, '').toLowerCase();
}

function findCredentialPair(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const pair = findCredentialPair(item, depth + 1);
      if (pair) return pair;
    }
    return null;
  }

  const fields = Object.entries(value);
  const fieldValue = names => {
    const wanted = new Set(names.map(normalizeCredentialFieldName));
    const match = fields.find(([name, candidate]) => {
      return wanted.has(normalizeCredentialFieldName(name))
        && typeof candidate === 'string'
        && candidate.length >= 8
        && !isAssetData(candidate);
    });
    return match?.[1] || null;
  };

  const accessKey = fieldValue([
    'accessKey', 'accessKeyId', 'access_key', 'access_key_id',
    'secretId', 'secret_id', 'SecretId', 'id',
  ]);
  const secretKey = fieldValue([
    'secretKey', 'secretAccessKey', 'accessKeySecret', 'access_key_secret',
    'secret_access_key', 'secret', 'SecretKey', 'sk',
  ]);
  if (accessKey && secretKey) return { accessKey, secretKey };

  for (const child of Object.values(value)) {
    const pair = findCredentialPair(child, depth + 1);
    if (pair) return pair;
  }
  return null;
}

function serializeCredentialPair(pair) {
  if (!pair?.accessKey || !pair?.secretKey) return null;
  // `sourceKey` is internal provenance metadata and must never be persisted
  // as part of the provider credential value.
  return JSON.stringify({ accessKey: pair.accessKey, secretKey: pair.secretKey });
}

function parseCredentialPairText(text) {
  if (!text) return null;
  try {
    return findCredentialPair(JSON.parse(String(text)));
  } catch {
    return null;
  }
}

/** Classify a Xiaomi MiMo Token Plan masked-row action icon from its SVG
 *  shape. The provider's Copy icon is a 20×20 viewBox containing two paths;
 *  Reset is 18×18 with one path. viewBox whitespace is normalized before
 *  comparison. Any other shape is unknown and must never be treated as Copy. */
function classifyXiaomiTokenPlanIcon({ viewBox, pathCount }) {
  const vb = String(viewBox == null ? '' : viewBox).replace(/\s+/g, ' ').trim();
  const count = Number(pathCount);
  if (vb === '0 0 20 20' && count === 2) return 'copy';
  if (vb === '0 0 18 18' && count === 1) return 'reset';
  return 'unknown';
}

// Browser-side equivalent of classifyXiaomiTokenPlanIcon, injected into the
// automation tab so icon-only masked-row buttons are classified by SVG shape
// instead of by document order. See classifyXiaomiTokenPlanIcon.
const XIAOMI_ICON_CLASSIFY_JS = `(btn) => {
  const svg = btn.querySelector('svg');
  if (!svg) return 'unknown';
  const vb = (svg.getAttribute('viewBox') || '').replace(/\\s+/g, ' ').trim();
  const paths = svg.querySelectorAll('path').length;
  if (vb === '0 0 20 20' && paths === 2) return 'copy';
  if (vb === '0 0 18 18' && paths === 1) return 'reset';
  return 'unknown';
}`;

/** Sleep helper that keeps the extension SW alive during long waits.
 *  MV3 service workers are killed after ~30s of inactivity. During long SPA
 *  load waits (e.g. volcengine's 8s extraWait), we must periodically send a
 *  lightweight command so Chrome considers the SW active. This function pings
 *  the extension every 5s during the wait. If the extension is disconnected,
 *  the ping is silently skipped (we can't keep it alive if it's already dead). */
async function sleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const wait = Math.min(remaining, 5000);
    await new Promise(r => setTimeout(r, wait));
    // Ping the extension to keep the SW alive (only if there's more to wait)
    if (Date.now() < deadline && isExtensionConnected()) {
      try {
        await sendCommand('exec', { code: '1', workspace: 'okit' }, 3000);
      } catch { /* ignore ping failures */ }
    }
  }
}

/** Run an exec atom on the automation tab. Returns the JS result value. */
async function execJs(code, timeoutMs = 15000) {
  const r = await sendCommand('exec', { code, workspace: 'okit' }, timeoutMs);
  if (!r.ok) throw new Error(r.error || 'exec failed');
  return r.data;
}

/** Close the automation Chrome window to avoid leaving stray windows open.
 *  Silently ignored if the window is already gone or the extension disconnected. */
async function closeAutomationWindow() {
  try {
    await sendCommand('close-window', { workspace: 'okit' }, 5000);
  } catch { /* window may already be closed — ignore */ }
}

/** Put the dedicated Chrome automation window in front for a login handoff.
 *  Failure is non-fatal: the UI can still tell the user where to finish login. */
async function focusAutomationWindow() {
  try {
    const result = await sendCommand('focus-window', { workspace: 'okit', hold: true }, 5000);
    return Boolean(result.ok);
  } catch {
    return false;
  }
}

/** Click a verified provider control with trusted foreground input. */
async function foregroundClick({ x, y, tabId }) {
  const pointer = { x: Number(x), y: Number(y), button: 'left', buttons: 1, clickCount: 1 };
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
  const focused = await sendCommand('focus-window', { workspace: 'okit' }, 5000).catch(() => ({ ok: false }));
  if (!focused.ok) return false;
  await sleep(150);
  await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { x: pointer.x, y: pointer.y, type: 'mouseMoved', buttons: 0 },
    workspace: 'okit',
    ...(tabId ? { tabId } : {}),
  }, 5000).catch(() => ({ ok: false }));
  const pressed = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mousePressed' },
    workspace: 'okit',
    ...(tabId ? { tabId } : {}),
  }, 5000).catch(() => ({ ok: false }));
  const released = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
    workspace: 'okit',
    ...(tabId ? { tabId } : {}),
  }, 5000).catch(() => ({ ok: false }));
  return Boolean(pressed.ok && released.ok);
}

function isLoginFailure(message) {
  return /login|log\s*in|sign\s*in|continue with (?:google|email|sso)|未登录|登录|401|authentication required/i.test(message || '');
}

/**
 * Provider key creation can be rejected because the account has reached a
 * credential-count limit. This is different from a transient API rate limit:
 * retrying the create action cannot help and may create confusing duplicates
 * when the provider accepted the mutation but hid the one-time secret.
 */
function classifyKeyCreationLimitFailure(message, platformLabel = '该平台', keyLimits = []) {
  const raw = String(message || '').replace(/[\r\n]+/g, ' ').trim();
  if (!raw) return null;
  const looksLikeKeyLimit = /(?:normal\s+)?token\s+quota\s+exceeded|(?:limit|maximum|max)\s*[=:]?\s*\d+\s*[,; ]+[^.]{0,80}\bcurrent\s*[=:]?\s*\d+|\bcurrent\s*[=:]?\s*\d+[^.]{0,80}\b(?:limit|maximum|max)\s*[=:]?\s*\d+|(?:api\s*key|access\s*key|secret\s*key|credential|token|密钥|凭证).{0,80}(?:limit|quota|maximum|max|上限|最多|达到|已满)|(?:limit|quota|maximum|max|上限|最多|达到|已满).{0,80}(?:api\s*key|access\s*key|secret\s*key|credential|token|密钥|凭证)/i.test(raw);
  if (!looksLikeKeyLimit) return null;
  const safeMessage = raw
    .replace(/sk-(?:api-)?[A-Za-z0-9_-]{12,}/gi, '[REDACTED]')
    .slice(0, 240);
  const configuredLimits = Array.isArray(keyLimits)
    ? keyLimits
      .map(limit => Number(limit?.max))
      .filter(limit => Number.isFinite(limit) && limit > 0)
      .filter((limit, index, all) => all.indexOf(limit) === index)
    : [];
  const limitHint = configuredLimits.length ? `（已知平台上限：${configuredLimits.join(' / ')}）` : '';
  return `${platformLabel} 已达到平台的密钥数量或创建上限${limitHint}，自动创建已停止。请删除/撤销旧密钥，或复用已有密钥后再试。平台提示：${safeMessage}`;
}

function isLoginUrl(url) {
  return /\/(?:login|log-in|sign-in|signin|auth)(?:[/?#]|$)/i.test(url || '');
}

/**
 * Some platforms redirect to a login page without returning a useful API
 * error. Probe only stable, non-sensitive page signals so the UI can hand the
 * browser over to the user instead of reporting a vague creation failure.
 */
async function detectLoginRequired(platform = null) {
  try {
    const raw = await execJs(`(() => {
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const url = location.href;
      const loginRoute = /(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(url);
      const hasPasswordField = [...document.querySelectorAll('input[type="password"], input[autocomplete="current-password"]')]
        .some(isVisible);
      const hasLoginInput = [...document.querySelectorAll('input')]
        .filter(isVisible)
        .some((el) => /账号名|账号ID|用户名|邮箱|password|密码/i.test(
          String(el.getAttribute('placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || '')
        ));
      const bodyText = (document.body?.innerText || '').slice(0, 12000);
      const hasLoginPrompt = /请(?:先)?登录|登录后(?:继续|使用)|请登录(?:后)?|sign in to continue|log in to continue|please sign in|authentication required/i.test(bodyText);
      const hasLoginAction = [...document.querySelectorAll('a, button, [role="button"]')]
        .filter(isVisible)
        .some((el) => /(?:登录|登入|sign in|log in)/i.test((el.textContent || '').trim()));
      const publicRootLoginSurface = ${Boolean(platform?.loginRequiredOnPublicRoot)}
        && /^https:\/\/www\.kimi\.com\/(?:zh\/)?(?:\?.*)?(?:#.*)?$/i.test(url)
        && hasLoginAction;
      // A signed-in console may keep a “登录/Sign in” navigation item in its
      // shell. That label is not proof that the credential page is signed out;
      // require an actual login surface or a contextual login prompt instead.
      return JSON.stringify({ loginRequired: loginRoute || hasPasswordField || (hasLoginInput && hasLoginAction) || (hasLoginPrompt && hasLoginAction) || publicRootLoginSurface, url });
    })()`);
    const state = JSON.parse(raw || '{}');
    return { loginRequired: Boolean(state.loginRequired), url: typeof state.url === 'string' ? state.url : undefined };
  } catch {
    return { loginRequired: false, url: undefined };
  }
}

/**
 * Provider consoles may stop at a slider, CAPTCHA, SMS, or other interactive
 * security gate while still keeping the normal page URL. Treat that as a
 * handoff, not as a missing create button; the user can complete the official
 * verification in the focused automation window and retry the same flow.
 */
const INTERACTIVE_VERIFICATION_PROFILES = {
  default: {
    dialogPattern: '安全验证|身份验证|短信验证码|微信扫码验证|拖动下方滑块|完成拼图|MFA|使用其他校验方式|CAPTCHA|Turnstile|security verification',
    // Do not use bare “安全验证” here. Provider pages often mention the
    // account-security feature in normal navigation/help text even when no
    // challenge is active.
    pagePattern: '需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|请验证后(?:继续|操作)|请(?:输入|填写)(?:短信)?验证码|拖动下方滑块|完成拼图|captcha challenge|security verification required',
    challengeSelectorPattern: 'captcha|turnstile|slider|security-check|security_check|verify-code|verification-code',
  },
  // Zhipu has a normal signed-in API-key page that can contain account-security
  // copy outside the challenge. Only an active dialog, challenge control, or
  // explicit “please complete verification” surface may pause its run.
  zhipu: {
    dialogPattern: '安全验证|身份验证|短信验证码|微信扫码验证|拖动下方滑块|完成拼图|MFA|使用其他校验方式|图形验证码|验证码',
    pagePattern: '需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|请验证后(?:继续|操作)|请(?:输入|填写)(?:短信)?验证码|拖动下方滑块|完成拼图|图形验证码|captcha challenge|security verification required',
    challengeSelectorPattern: 'captcha|turnstile|slider|security-check|security_check|verify-code|verification-code|安全验证|验证码',
  },
};

function getInteractiveVerificationProfile(platform) {
  const platformId = typeof platform === 'string' ? platform : platform?.id;
  return INTERACTIVE_VERIFICATION_PROFILES[platformId] || INTERACTIVE_VERIFICATION_PROFILES.default;
}

/**
 * Classify a read-only browser probe. Keeping this separate from execJs makes
 * the false-positive boundary testable without a live provider session.
 */
function classifyInteractiveVerificationState(state = {}, platform) {
  const profile = getInteractiveVerificationProfile(platform);
  const matches = (pattern, value) => {
    try { return new RegExp(pattern, 'i').test(String(value || '')); } catch { return false; }
  };
  const dialogMatch = (state.dialogTexts || []).some(text => matches(profile.dialogPattern, text));
  const explicitPageMatch = matches(profile.pagePattern, state.bodyText);
  const challengeSurface = Boolean(state.iframeSecurity || state.challengeControl || state.challengeNode);
  const pageMatch = explicitPageMatch && (challengeSurface || /拖动下方滑块|完成拼图|需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|security verification required/i.test(String(state.bodyText || '')));
  return {
    matched: Boolean(dialogMatch || pageMatch),
    reason: dialogMatch ? 'dialog' : (pageMatch ? 'page' : null),
  };
}

async function detectInteractiveVerification(platform) {
  const profile = getInteractiveVerificationProfile(platform);
  try {
    const raw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
      };
      const bodyText = (document.body?.innerText || '').slice(0, 16000);
      const dialogSelector = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .el-dialog, .modal, [class*="dialog"], [class*="modal"]';
      const dialogs = [...document.querySelectorAll(dialogSelector)]
        .filter(visible)
        .map(dialog => (dialog.innerText || '').trim().slice(0, 1200))
        .filter(Boolean)
        .slice(0, 20);
      const iframeSecurity = [...document.querySelectorAll('iframe')].some(frame => visible(frame) && /captcha|verify|security/i.test(
        String(frame.src || '') + ' ' + String(frame.title || '')
      ));
      const challengeSelectorPattern = ${JSON.stringify(profile.challengeSelectorPattern)};
      const challengeNode = [...document.querySelectorAll('body *')].some(el => {
        if (!visible(el)) return false;
        const identity = [el.id, el.className, el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(value => typeof value === 'string').join(' ');
        return new RegExp(challengeSelectorPattern, 'i').test(identity);
      });
      const challengeControl = [...document.querySelectorAll('input, textarea, button, [role="button"]')].some(el => {
        if (!visible(el)) return false;
        const identity = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('title'), el.textContent]
          .filter(value => typeof value === 'string').join(' ');
        return /验证码|图形验证|安全码|verification code|security code|captcha|滑块|slider/i.test(identity);
      });
      return JSON.stringify({ bodyText, dialogTexts: dialogs, iframeSecurity, challengeNode, challengeControl });
    })()`);
    return classifyInteractiveVerificationState(JSON.parse(raw || '{}'), platform).matched;
  } catch {
    return false;
  }
}

function scheduleAutoCreateRunExpiry(run, delay = AUTO_CREATE_RUN_RESULT_TTL_MS) {
  clearTimeout(run.expiryTimer);
  run.expiryTimer = setTimeout(() => {
    if (AUTO_CREATE_RUNS.get(run.id) === run) AUTO_CREATE_RUNS.delete(run.id);
  }, delay);
}

function markAutoCreateRun(run, status, details = {}) {
  run.status = status;
  run.updatedAt = new Date().toISOString();
  Object.assign(run, details);
  if (['succeeded', 'failed', 'login_required'].includes(status)) {
    scheduleAutoCreateRunExpiry(run);
  }
}

/**
 * Pause an interactive browser run at the provider's security gate. The
 * promise is resolved by POST /auto-create/resume/:runId after the user has
 * completed the official verification in the already-open browser window.
 */
async function waitForInteractiveVerification({ run, platform, stage }) {
  if (!run) {
    throw new Error(`${platform.label || platform.id} 当前页面停在安全验证/验证码，自动化未提交创建。请先完成官方验证后重试`);
  }

  while (true) {
    const label = platform.label || platform.id;
    let resumeResolve;
    let resumeReject;
    const resumePromise = new Promise((resolve, reject) => {
      resumeResolve = resolve;
      resumeReject = reject;
    });
    run.resumeResolve = resumeResolve;
    run.resumeReject = resumeReject;
    run.resumeAvailable = true;
    run.verification = {
      stage,
      platformId: platform.id,
      platformLabel: label,
      message: `${label} 需要完成页面上的安全验证。请在自动化浏览器窗口完成验证后，回到 OKIT 点击“验证完成，继续”。`,
    };
    run.updatedAt = new Date().toISOString();
    run.status = 'verification_required';
    const browserFocused = await focusAutomationWindow().catch(() => false);
    run.browserFocused = browserFocused;
    run.updatedAt = new Date().toISOString();

    const timeout = setTimeout(() => {
      resumeReject(new Error(`${label} 安全验证等待超时，任务已停止；未提交新的密钥`));
    }, AUTO_CREATE_VERIFICATION_TIMEOUT_MS);
    try {
      await resumePromise;
    } finally {
      clearTimeout(timeout);
      run.resumeResolve = null;
      run.resumeReject = null;
      run.resumeAvailable = false;
    }

    run.status = 'running';
    run.verification = null;
    run.updatedAt = new Date().toISOString();
    await sleep(400);
    if (!(await detectInteractiveVerification(platform))) return;
    // The user may have clicked Continue before the provider finished closing
    // its challenge. Keep the same run paused until the gate is really gone.
  }
}

/**
 * Cleanup can hit the same provider-owned security gate as creation, but the
 * scheduled checker has no modal to poll. Keep the exact deletion flow alive
 * while the focused automation window is handed to the user, then continue
 * automatically once the provider closes the challenge.
 */
async function waitForSecurityVerificationToClear({ platform, stage }) {
  const label = platform.label || platform.id;
  await focusAutomationWindow().catch(() => false);
  const deadline = Date.now() + AUTO_CREATE_VERIFICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await detectInteractiveVerification(platform))) return;
    await sleep(1000);
  }
  throw new Error(`${label} ${stage === 'delete' ? '删除' : '操作'}安全验证等待超时，请完成官方验证后重试`);
}

function createAutoCreateRun({ platformConfig, tokenName }) {
  const run = {
    id: crypto.randomUUID(),
    platformConfig,
    status: 'running',
    platform: platformConfig.id,
    platformLabel: platformConfig.label || platformConfig.id,
    tokenName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    verification: null,
    resumeAvailable: false,
  };
  AUTO_CREATE_RUNS.set(run.id, run);
  return run;
}

async function executeAutoCreateRun(run) {
  const { platformConfig, tokenName } = run;
  try {
    if (!isExtensionConnected()) throw new Error('OKIT Chrome 扩展未连接');
    const result = await createBrowserPlatformKey(platformConfig, tokenName, run);
    if (isAssetData(result.value)) throw new Error('Extracted asset data, not API key.');
    markAutoCreateRun(run, 'succeeded', {
      result: {
        value: result.value,
        name: result.name,
        platform: platformConfig.id,
        ...(result.reusedExisting ? {
          reusedExisting: true,
          sourceKey: result.sourceKey,
        } : {}),
        ...(platformConfig.readyAfterMs ? { readyAfterMs: platformConfig.readyAfterMs } : {}),
      },
      error: null,
      verification: null,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/not connected|disconnected|timed out/i.test(msg)) {
      markAutoCreateRun(run, 'failed', { error: msg });
      return;
    }
    const keyLimitError = classifyKeyCreationLimitFailure(msg, platformConfig.label || platformConfig.id, platformConfig.keyLimits);
    if (keyLimitError) {
      markAutoCreateRun(run, 'failed', { error: keyLimitError, errorKind: 'platform_key_limit' });
      return;
    }
    const loginState = await detectLoginRequired(platformConfig).catch(() => ({ loginRequired: false }));
    if (isLoginFailure(msg) || loginState.loginRequired) {
      const browserFocused = await focusAutomationWindow().catch(() => false);
      markAutoCreateRun(run, 'login_required', {
        loginRequired: true,
        browserFocused,
        loginUrl: loginState.url || platformConfig.url,
        error: browserFocused
          ? `需要登录 ${platformConfig.label || platformConfig.id}。已将自动化浏览器窗口置前，请完成登录后重新开始。`
          : `需要登录 ${platformConfig.label || platformConfig.id}。请在自动化浏览器窗口完成登录后重新开始。`,
      });
      return;
    }
    markAutoCreateRun(run, 'failed', { error: `${platformConfig.id} auto-create failed: ${msg}` });
  }
}

function serializeAutoCreateRun(run) {
  const base = {
    success: run.status !== 'failed' && run.status !== 'login_required',
    runId: run.id,
    status: run.status,
    platform: run.platform,
    platformLabel: run.platformLabel,
  };
  if (run.status === 'verification_required') {
    return {
      ...base,
      pending: true,
      verificationRequired: true,
      browserFocused: Boolean(run.browserFocused),
      verification: run.verification,
    };
  }
  if (run.status === 'running') return { ...base, pending: true };
  if (run.status === 'succeeded') return { ...base, ...run.result };
  if (run.status === 'login_required') {
    return {
      ...base,
      success: false,
      loginRequired: true,
      browserFocused: Boolean(run.browserFocused),
      loginUrl: run.loginUrl,
      error: run.error,
    };
  }
  return { ...base, success: false, ...(run.errorKind ? { errorKind: run.errorKind } : {}), error: run.error || '自动创建失败' };
}

async function autoCreateRunStatus(req, res) {
  const run = AUTO_CREATE_RUNS.get(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: '自动创建任务不存在或已过期' });
  return res.json(serializeAutoCreateRun(run));
}

async function resumeAutoCreateRun(req, res) {
  const run = AUTO_CREATE_RUNS.get(req.params.runId);
  if (!run) return res.status(404).json({ success: false, error: '自动创建任务不存在或已过期' });
  if (run.status !== 'verification_required' || typeof run.resumeResolve !== 'function') {
    return res.status(409).json({ success: false, error: '当前任务没有等待验证码验证' });
  }
  run.resumeResolve();
  return res.json({ success: true, runId: run.id, status: 'running' });
}

function isOpenRouterPublicPage(state) {
  return Boolean(state?.publicHome && !state?.keyWorkspace);
}

function hasOpenRouterPublicNavigation(labels) {
  return ['Home', 'Models', 'Fusion', 'Chat'].every((label) => labels.includes(label));
}

async function redirectOpenRouterToLogin() {
  const signInUrl = 'https://openrouter.ai/sign-in?redirect_url=https%3A%2F%2Fopenrouter.ai%2Fworkspaces%2Fdefault%2Fkeys';
  await sendCommand('navigate', { url: signInUrl, workspace: 'okit' }, 30000).catch(() => {});
}

/**
 * OpenRouter can fall back to its public home page instead of exposing a
 * conventional password form. Treat that as a login handoff, not as a missing
 * "Create Key" button. Only non-sensitive booleans and the current URL cross
 * the extension boundary.
 */
async function handoffOpenRouterLoginIfNeeded() {
  const raw = await execJs(`(() => {
    const url = location.href;
    const text = (document.body?.innerText || '').slice(0, 16000);
    const labels = [...document.querySelectorAll('a, button, [role="button"]')]
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);
    const publicNavigation = ['Home', 'Models', 'Fusion', 'Chat']
      .every((label) => labels.includes(label));
    return JSON.stringify({
      url,
      // The public shell sometimes preserves /keys in the address bar while
      // rendering only its Home/Models/Fusion/Chat navigation. That navigation
      // pattern itself is the reliable unauthenticated signal.
      publicHome: /The Unified Interface For LLMs|Get API Key/.test(text) || publicNavigation,
      keyWorkspace: /\\/workspaces\\/[^/]+\\/keys(?:[/?#]|$)/.test(location.pathname),
    });
  })()`);
  const state = JSON.parse(raw || '{}');
  if (isLoginUrl(state.url) || isOpenRouterPublicPage(state)) {
    if (!isLoginUrl(state.url)) {
      await redirectOpenRouterToLogin();
    }
    throw new Error(`OpenRouter login required${state.url ? ` (${state.url})` : ''}`);
  }
}

/** Extract a real API key from captured network responses.
 *  Tries common field names + a JWT/hex fallback. Mirrors the Playwright regex.
 *  For zhipu: keys are in "AK_ID.SK" format (e.g. "53f6...123.i2IC...xOe"),
 *  so we look for both the id and secret fields and join them with ".". */
function extractKeyFromCaptures(entries, platform) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Look at response bodies (responsePreview), prefer JSON bodies
  const candidates = [];
  for (const e of entries) {
    const body = e.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    // Mistral's admin session responses also contain generic key-like fields.
    // Only its API-key billing endpoint can contain a credential candidate.
    if (platform === 'mistral' && !/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(e.url || '')) continue;
    candidates.push({
      body,
      url: e.url || '',
      method: String(e.method || '').toUpperCase(),
      timestamp: Number(e.timestamp) || 0,
      status: e.responseStatus,
    });
  }

  // 1. Try parsing JSON bodies and pluck known key fields.
  //    For zhipu, the response has separate "api_key" and "api_secret" fields
  //    that must be joined as "api_key.api_secret".
  //    IMPORTANT: prefer POST responses (create API) over GET (list API), since
  //    the list API returns masked secrets while the create API has the full key.
  const sortedCandidates = [...candidates].sort((a, b) => {
    // The post-create secret is returned by the mutation. Page bootstrap
    // requests can also contain fields named `key` (for example, a session
    // public key), so they must never win over the create response.
    const aMutation = /^(POST|PUT|PATCH)$/i.test(a.method) ? 0 : 1;
    const bMutation = /^(POST|PUT|PATCH)$/i.test(b.method) ? 0 : 1;
    return aMutation - bMutation || b.timestamp - a.timestamp;
  });
  for (const c of sortedCandidates) {
    let data;
    try { data = JSON.parse(c.body); } catch { continue; }

    if (CREDENTIAL_PAIR_PLATFORMS.has(platform)) {
      const pair = findCredentialPair(data);
      if (pair) return serializeCredentialPair(pair);
    }

    // Moonshot's create response also carries an unrelated `key` identifier;
    // locate the actual sk-prefixed secret by shape before generic field-name
    // traversal can select that identifier.
    if (platform === 'moonshot') {
      const moonshotKey = findStringMatching(data, /^sk-[A-Za-z0-9_-]{16,}$/);
      if (moonshotKey) return moonshotKey;
    }

    // Diagnostic only: never log an API response body because this path is
    // expected to contain a newly-created secret.
    if (/api_key|api_secret|apikey|secret/i.test(c.body)) {
      console.log(`[auto-create] key-containing response captured from ${c.url.slice(0, 80)}`);
    }

    // Several providers return a key as two fields. Z.AI's live API may name
    // these apiKeyId/apiKeySecret rather than apiKey/secretKey, so keep the
    // accepted aliases explicit and pair them only within this captured
    // creation response. Masked list values are rejected below.
    const keyId = findFieldValue(data, [
      'api_key', 'apikey', 'api_key_id', 'apikeyid', 'key_id', 'keyid', 'key',
    ]);
    const secret = findFieldValue(data, [
      'api_secret', 'apikeysecret', 'api_key_secret', 'apikey_secret',
      'secret_key', 'secretkey', 'signature_secret', 'signaturesecret', 'secret',
    ]);
    if (keyId && secret && !isAssetData(keyId) && !isAssetData(secret)) {
      const joined = isValidExtractionForPlatform(keyId + '.' + secret, platform);
      if (joined) return joined;
    }

    // Generic: single key-like field
    const found = isValidExtractionForPlatform(findKeyField(data), platform);
    if (found) return found;

    // Z.AI may return the complete API key in a provider-specific field rather
    // than a field literally named key or secret. Inspect only JSON string
    // values from this captured create response for its documented id.secret
    // structure; URLs and other non-JSON text are deliberately excluded.
    if (platform === 'zai-global') {
      const joined = findIdSecretValue(data);
      if (joined && !isAssetData(joined)) return joined;
    }
  }

  // 2. Regex fallback over raw bodies (catches embedded JSON or JWTs)
  for (const c of candidates) {
    const m = c.body.match(/"(?:key|api_key|apiKey|token|value|secret)"\s*:\s*"([^"]{20,})"/);
    const quotedKey = isValidExtractionForPlatform(m && m[1], platform);
    if (quotedKey) return quotedKey;
  }
  for (const c of candidates) {
    const m = c.body.match(/eyJ[a-zA-Z0-9\-_]{50,}/);
    const jwtKey = isValidExtractionForPlatform(m && m[0], platform);
    if (jwtKey) return jwtKey;
  }
  // zhipu: full key format is 32-hex-dot-alphanumeric (e.g. xxxx.i2IC1jQ...)
  for (const c of candidates) {
    const m = c.body.match(/\b([a-f0-9]{32}\.[a-zA-Z0-9]{6,})\b/);
    const zhipuKey = isValidExtractionForPlatform(m && m[1], platform);
    if (zhipuKey) return zhipuKey;
  }
  for (const c of candidates) {
    // zhipu captured example: 32-char hex like a7cb939127954e91bd78d1cac4a1ee8f
    const m = c.body.match(/\b([a-f0-9]{32})\b/);
    const hexKey = isValidExtractionForPlatform(m && m[1], platform);
    if (hexKey) return hexKey;
  }

  return null;
}

function extractNewestNamedKeyFromCaptures(entries, tokenName, platform) {
  const matches = [];
  const wantedPrefix = `${tokenName}-`;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const fields = Object.entries(value);
    const field = aliases => fields.find(([name]) => aliases.includes(name.replace(/[_-]/g, '').toLowerCase()))?.[1];
    const name = field(['name', 'displayname', 'keyname']);
    if (typeof name === 'string' && name.startsWith(wantedPrefix)) {
      const candidate = field(['key', 'apikey', 'token', 'value', 'secret']);
      const key = typeof candidate === 'string' ? keyFromText(candidate, platform) : null;
      if (key) {
        const created = field(['createdat', 'created', 'creationdate', 'updatedat']);
        matches.push({ key, name, created: Date.parse(String(created || '')) || 0 });
      }
    }
    fields.forEach(([, child]) => visit(child));
  };

  for (const entry of entries || []) {
    if (platform.id === 'mistral' && !/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(entry.url || '')) continue;
    try { visit(JSON.parse(entry.responsePreview || '')); } catch {}
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0] || null;
}

function capturesContainMistralKeyRecords(entries) {
  const looksLikeKeyRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).map(key => key.replace(/[_-]/g, '').toLowerCase());
    if (keys.includes('apikeyid') || keys.includes('keyid')) return true;
    const hasIdentity = keys.includes('id') && (keys.includes('name') || keys.includes('keyname'));
    const hasKeyMetadata = keys.some(key => [
      'createdat', 'expiresat', 'expirationdate', 'lastusedat', 'workspaceid', 'ownerid', 'isactive', 'status',
    ].includes(key));
    return hasIdentity && hasKeyMetadata;
  };
  const containsRecord = value => {
    if (Array.isArray(value)) return value.some(item => looksLikeKeyRecord(item) || containsRecord(item));
    if (!value || typeof value !== 'object') return false;
    return looksLikeKeyRecord(value) || Object.values(value).some(containsRecord);
  };

  return (entries || []).some(entry => {
    if (!/\/api\/billing\/api-keys(?:[/?#]|$)/i.test(entry.url || '')) return false;
    if (String(entry.method || 'GET').toUpperCase() !== 'GET') return false;
    try { return containsRecord(JSON.parse(entry.responsePreview || '')); } catch { return false; }
  });
}

/** Find a field value by checking a list of candidate field names (case-insensitive). */
function findFieldValue(obj, fieldNames, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const lowerNames = fieldNames.map(f => f.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length >= 8 && lowerNames.includes(k.toLowerCase())) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findFieldValue(v, fieldNames, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Recursively search a JSON object for a key-like field. */
function findKeyField(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  const KEY_NAMES = ['apikey', 'api_key', 'apikeysecret', 'accesskey', 'access_key', 'key', 'token', 'value', 'secret', 'secret_key', 'secretkey'];
  const entries = Object.entries(obj);
  // A Kimi response can contain both the one-time API key and an unrelated
  // short-lived `key` identifier. Prefer explicit API-key/secret fields over
  // the generic identifier regardless of JSON property order.
  for (const keyName of KEY_NAMES) {
    const match = entries.find(([k, v]) => String(k).toLowerCase() === keyName && typeof v === 'string' && v.length >= 20);
    if (match) return match[1];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = findKeyField(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findStringMatching(obj, pattern, depth = 0) {
  if (depth > 8 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') return pattern.test(obj) && !isAssetData(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) {
    const found = findStringMatching(value, pattern, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Find a Z.AI id.secret value in JSON data without logging or otherwise
 * exposing the response. The two segments cannot contain whitespace or a
 * second dot, matching Z.AI's documented split('.') authentication format. */
function findIdSecretValue(obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') {
    const match = obj.match(/^([^.\s]{8,128}\.[^.\s]{8,256})$/);
    return match ? match[1] : null;
  }
  if (typeof obj !== 'object') return null;
  for (const value of Object.values(obj)) {
    const found = findIdSecretValue(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Safe diagnostics for a failed one-time-secret extraction. Provider API
 * responses may contain credentials, so this reports field paths, lengths and
 * coarse shapes only — never a response value or a response body.
 */
function describeCapturedSecretFields(entries) {
  const summaries = [];
  const visit = (value, path = '', depth = 0, output = []) => {
    if (depth > 6 || output.length >= 16 || value === null || value === undefined) return output;
    if (typeof value === 'string') {
      const field = path.split('.').pop() || '';
      if (/api.?key|secret|token|access.?key|credential|^key(?:id)?$/i.test(field)) {
        output.push({
          field: path,
          length: value.length,
          shape: /^[a-f0-9]{32}\./i.test(value) ? 'id.secret'
            : /^sk-/i.test(value) ? 'sk-prefix'
              : /^[a-f0-9]{32}$/i.test(value) ? 'hex-id'
                : 'other',
        });
      }
      return output;
    }
    if (typeof value !== 'object') return output;
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, path ? `${path}.${key}` : key, depth + 1, output);
      if (output.length >= 16) break;
    }
    return output;
  };

  for (const entry of entries || []) {
    const body = entry?.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    let data;
    try { data = JSON.parse(body); } catch { continue; }
    const fields = visit(data);
    if (!fields.length) continue;
    let path = String(entry.url || '');
    try { path = new URL(path).pathname; } catch {}
    summaries.push({ method: String(entry.method || 'GET').toUpperCase(), status: entry.responseStatus || 0, path: path.slice(0, 120), fields });
    if (summaries.length >= 6) break;
  }
  return summaries;
}

/** Safe shape-only diagnostics for captured responses. Never include response
 * values, headers, request bodies, or any credential-bearing text. */
function describeCapturedResponses(entries) {
  return (entries || []).slice(-12).map((entry) => {
    const body = String(entry?.responsePreview || '');
    let jsonKeys = [];
    if (body && !body.startsWith('base64:')) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          jsonKeys = Object.keys(parsed).slice(0, 24);
        }
      } catch {}
    }
    let path = String(entry?.url || '');
    try { path = new URL(path).pathname; } catch {}
    return {
      method: String(entry?.method || 'GET').toUpperCase(),
      status: Number(entry?.responseStatus) || 0,
      path: path.slice(0, 160),
      bodyLength: body.length,
      jsonKeys,
    };
  });
}

/** Safe MiniMax creation-result diagnostics. The backend wraps business
 * failures in base_resp and omits the token; expose only the numeric code and
 * short human-readable status, never arbitrary response fields or secrets. */
function describeMinimaxBackendResults(entries) {
  return (entries || [])
    .filter(entry => /\/backend\/token(?:[/?#]|$)/i.test(entry?.url || '')
      && String(entry?.method || '').toUpperCase() === 'POST')
    .map(entry => {
      let parsed = null;
      try { parsed = JSON.parse(entry.responsePreview || ''); } catch {}
      const base = parsed?.base_resp;
      if (!base || typeof base !== 'object') return null;
      const statusCode = base.status_code ?? base.code ?? null;
      const rawMessage = base.status_msg ?? base.message ?? '';
      const statusMessage = String(rawMessage || '')
        .replace(/sk-(?:api-)?[A-Za-z0-9_-]{12,}/gi, '[REDACTED]')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200);
      return { statusCode, statusMessage };
    })
    .filter(Boolean);
}

/** Return only whether a provider redacted a returned secret. This is
 * deliberately boolean-only: diagnostics must never surface credentials. */
function capturesContainMaskedSecret(entries) {
  const visit = (value, field = '', depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return false;
    if (typeof value === 'string') {
      return /secret|signature/i.test(field) && /[＊*•]/.test(value);
    }
    if (typeof value !== 'object') return false;
    return Object.entries(value).some(([key, nested]) => visit(nested, key, depth + 1));
  };
  for (const entry of entries || []) {
    const body = entry?.responsePreview || '';
    if (!body || body.startsWith('base64:')) continue;
    try {
      if (visit(JSON.parse(body))) return true;
    } catch {}
  }
  return false;
}

async function createZhipuKey({ tokenName, run }) {
  // Append a short timestamp suffix to avoid name collisions on the platform
  // (zhipu rejects duplicate key names silently — the confirm button works
  // but no key is actually created, resulting in 0 captured API responses).
  // The current dialog enforces a hard 20-character limit.
  const uniqueName = `${String(tokenName || '').slice(0, 13)}-${Date.now().toString(36).slice(-6)}`;

  // 1. Navigate to zhipu API key page (reuse logged-in cookies)
  const nav = await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const navData = nav.data || {};
  const tabId = navData.tabId;

  // 2. Arm network capture BEFORE clicking create
  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] zhipu: capture armed');

  // 3. Wait for SPA to render the key management page, then dismiss modals.
  //    Poll for the create action to appear (up to 15s) — zhipu's SPA load
  //    time varies and a fixed sleep is unreliable. Each pass uses the shared
  //    two-phase clickCreateAction flow. A merely missing create button keeps
  //    polling; ambiguous or live-drifted results are fatal and never clicked.
  let createResult = null;
  let createFatal = false;
  for (let wait = 0; wait < 15; wait++) {
    await sleep(1000);
    if (await detectInteractiveVerification('zhipu')) {
      await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'before-create' });
    }
    // Dismiss leftover modals each iteration
    await execJs(`(() => {
      for (let i = 0; i < 3; i++) {
        const close = document.querySelector('.ant-modal-close, [aria-label="Close"], .ant-modal-mask');
        if (close) close.click();
        const cancel = [...document.querySelectorAll('button')].find(b => /取消|关闭|我知道了/.test(b.textContent));
        if (cancel) cancel.click();
      }
    })()`).catch(() => {});

    // Two-phase create click (read-only collect → Node resolve → fingerprint
    // recheck → click) against the exact bilingual API-Key phrases.
    createResult = await clickCreateAction({ createTexts: ZHIPU_CREATE_TEXTS });
    if (createResult.ok) break;
    if (createResult.error === 'create-ambiguous' || createResult.error === 'create-mismatch') {
      createFatal = true;
      break;
    }
  }
  console.log('[auto-create] zhipu: create →', createResult);
  if (!createResult.ok) {
    if (createFatal) {
      throw new Error(`创建按钮候选不唯一或点击前已变化，为避免误点已停止。页面按钮: ${JSON.stringify(createResult.buttons || [])}`);
    }
    throw new Error(`创建按钮未找到。页面按钮: ${JSON.stringify(createResult.buttons || [])}`);
  }

  // 5. Wait for dialog, fill name — scoped to modal if one exists
  await sleep(1000);
  const fillResult = await execJs(`(() => {
    // zhipu uses a custom dialog — try multiple container selectors then body
    const scopes = ['.ant-modal-content', '.ant-modal', '[role="dialog"]', '.el-dialog', '.el-dialog__body', '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]', 'body'];
    for (const scope of scopes) {
      const container = scope === 'body' ? document : document.querySelector(scope);
      if (!container) continue;
      const inp = container.querySelector(${JSON.stringify(ZHIPU_NAME_SELECTORS)});
      if (inp && inp.getBoundingClientRect().width > 0) {
        // Use multiple strategies to set the value — Vue/React frameworks
        // sometimes don't react to a single input event.
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, ${JSON.stringify(uniqueName)});
        // Trigger events that Vue/React/Angular listen to
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        // Also try keyboard events for frameworks that track key sequences
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        // Focus back to keep the field active
        inp.focus();
        return JSON.stringify({ ok: true, scope, value: inp.value });
      }
    }
    return JSON.stringify({ error: 'not-found' });
  })()`).catch(e => JSON.stringify({ error: e.message }));
  const fillObj = JSON.parse(fillResult || '{}');
  console.log('[auto-create] zhipu: fill →', fillResult);
  if (fillObj.error) throw new Error('名称输入框未找到(创建对话框可能未打开)');

  // 6. Confirm via the shared two-phase helper scoped to the name dialog/form.
  //    Read-only collect → Node resolve with ZHIPU_CONFIRM_TEXTS (generics
  //    allowed inside that scope, button[type=submit] as selector evidence) →
  //    fingerprint/scope/selector recheck → click. Missing, disabled or
  //    ambiguous results fail closed: an error is returned and nothing clicks.
  await sleep(500);
  if (await detectInteractiveVerification('zhipu')) {
    await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'create-action' });
  }
  const confirmState = await clickZhipuConfirm();
  console.log('[auto-create] zhipu: confirm →', confirmState);
  if (confirmState.error) {
    if (confirmState.error === 'confirm-ambiguous') {
      throw new Error(`确认按钮存在多个候选且无法安全区分，为避免误点已停止。候选: ${(confirmState.buttons || []).join('、') || '无'}`);
    }
    throw new Error('确认按钮未找到或不可用(在 modal 内)，未执行点击');
  }

  // Zhipu may open the account-security challenge only after the final Create
  // click. Reuse the same resumable handoff before attempting to read the
  // one-time secret; otherwise a valid logged-in session is reported as a
  // generic extraction failure.
  await sleep(250);
  if (await detectInteractiveVerification('zhipu')) {
    await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'post-create-security-verification' });
  }

  // 7. IMMEDIATELY after confirm, check DOM for the full key. zhipu shows the
  //    complete "apiKey.secret" in a one-time success dialog that may close
  //    quickly. We check NOW (no sleep) before the dialog disappears.
  const immediateKey = await execJs(`(() => {
    // Look everywhere for the full "hex.secret" format
    const allText = document.body.innerText || '';
    // Strategy 1: full key in visible text
    let m = allText.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
    if (m) return m[0];
    // Strategy 2: in input/textarea values (copy fields)
    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.value && /[a-f0-9]{32}\./.test(el.value)) return el.value.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/)[0];
    }
    // Strategy 3: in data attributes / clipboard attributes
    for (const el of document.querySelectorAll('[data-clipboard-text], [data-copy], [data-key]')) {
      const val = el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') || el.getAttribute('data-key') || '';
      m = val.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    // Strategy 4: in any element's text content (dialogs, code blocks, spans)
    for (const el of document.querySelectorAll('[class*="key"], [class*="secret"], [class*="copy"], code, pre, .api-key')) {
      m = (el.textContent || '').match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    return '';
  })()`).catch(() => '');
  if (isValidZhipuApiKey(immediateKey)) {
    console.log('[auto-create] zhipu: found full key immediately after confirm');
    await closeAutomationWindow();
    return { value: immediateKey, name: uniqueName };
  }

  // 7b. Wait briefly and try again (dialog may take a moment to render)
  await sleep(1500);
  const delayedKey = await execJs(`(() => {
    const allText = document.body.innerText || '';
    let m = allText.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
    if (m) return m[0];
    for (const el of document.querySelectorAll('input, textarea, [data-clipboard-text], [data-key]')) {
      const val = el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || '';
      m = val.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    return '';
  })()`).catch(() => '');
  if (isValidZhipuApiKey(delayedKey)) {
    console.log('[auto-create] zhipu: found full key after delay');
    await closeAutomationWindow();
    return { value: delayedKey, name: uniqueName };
  }

  // 7c. (moved to after key extraction — see below)

  //    Retry reading up to 3 times — the API response may arrive later than
  //    our initial 2s wait, especially on slow connections.
  let entries = [];
  let key = null;
  for (let retry = 0; retry < 3 && !key; retry++) {
    await sleep(retry === 0 ? 3000 : 2000); // first wait 3s, then 2s increments
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) break;
    // network-capture-read drains the buffer, so accumulate across retries
    const newEntries = read.data || [];
    entries = entries.concat(newEntries);

    key = extractKeyFromCaptures(entries, 'zhipu');
    if (key) break;

    // If no key yet and this is the last retry, try the shared two-phase
    // confirm flow again in case the dialog is still open; it fails closed
    // (no click) when nothing confirmable is present.
    if (retry === 1) {
      const retryConfirm = await clickZhipuConfirm().catch(() => ({ error: 'confirm-not-found' }));
      console.log('[auto-create] zhipu: retry confirm check →', retryConfirm.ok ? 're-clicked-confirm' : retryConfirm.error);
    }
  }

  console.log(`[auto-create] zhipu: captured ${entries.length} requests total`);

  // 7c. zhipu's API returns a MASKED secret. The full key (apiKey.secret) is
  //    only available via the "copy" button (class: icon-wdapp_copy common-i)
  //    next to each key in the list. We inject a fetch/clipboard interceptor,
  //    click the copy button for our key, and read the intercepted value.
  // The current API platform returns the create response asynchronously and
  // may not expose the secret in the captured request. In that case, reload
  // the exact key list and copy only the row whose full test name matches.
  if (!key) {
    await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000).catch(() => {});
    await sleep(3000);
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      try {
        const original = navigator.clipboard?.writeText?.bind(navigator.clipboard);
        if (original) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: text => { window.__okitCapturedKey = String(text || ''); return original(text); } });
      } catch {}
      return 'interceptor-installed';
    })()`).catch(() => 'interceptor-failed');
    for (let attempt = 0; attempt < 5 && !key; attempt += 1) {
      const copyState = await execJs(`(() => {
        const target = ${JSON.stringify(uniqueName)};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
        if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
        const copies = [...rows[0].querySelectorAll('.icon-wdapp_copy, [class*="wdapp_copy"], [class*="copy"]')].filter(visible);
        if (copies.length !== 1) return JSON.stringify({ ok: false, copies: copies.length });
        copies[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"ok":false}');
      let copyStateObj = {};
      try { copyStateObj = JSON.parse(copyState || '{}'); } catch {}
      await sleep(500);
      const copied = await execJs('window.__okitCapturedKey || ""').catch(() => '');
      if (isValidZhipuApiKey(copied)) key = copied;
      if (!key && copyStateObj.ok === false) await sleep(700);
    }
    if (!key) {
      const clipboardRead = await sendCommand('clipboard-read', {
        workspace: 'okit',
        clipboardPattern: '^[a-f0-9]{32}\\.[A-Za-z0-9]{6,}$',
      }, 5000).catch(() => ({ ok: false, data: {} }));
      const clipboardKey = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
      if (isValidZhipuApiKey(clipboardKey)) key = clipboardKey;
    }
    if (key) {
      await closeAutomationWindow();
      return { value: key, name: uniqueName };
    }
  }

  if (key) {
    // Reload the page to get a fresh key list with the newly created key
    await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000).catch(() => {});
    await sleep(3000);

    // Inject a clipboard interceptor to capture what the copy button puts on the clipboard
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function(text) {
        window.__okitCapturedKey = text;
        return origWriteText(text);
      };
      // Also intercept execCommand('copy') as fallback
      const origExec = document.execCommand.bind(document);
      document.execCommand = function(cmd) {
        if (cmd === 'copy') {
          const sel = window.getSelection().toString();
          if (sel) window.__okitCapturedKey = sel;
        }
        return origExec(cmd);
      };
      return 'interceptor-installed';
    })()`).catch(() => 'interceptor-failed');

    // Find and click the copy button (icon-wdapp_copy) for our key
    const clickResult = await execJs(`(() => {
      const keyName = ${JSON.stringify(uniqueName)};
      const apiKey = ${JSON.stringify(key)};
      // Find the row containing our key name or apiKey
      const allEls = [...document.querySelectorAll('tr, li, [class*="row"], [class*="item"], [class*="card"], [class*="line"]')];
      let row = allEls.find(el => el.textContent.includes(keyName));
      if (!row) row = allEls.find(el => el.textContent.includes(apiKey));
      if (!row) return 'row-not-found';

      // Find the copy icon within the row
      const copyBtn = row.querySelector('.icon-wdapp_copy, [class*="wdapp_copy"], [class*="copy"]');
      if (copyBtn) { copyBtn.click(); return 'clicked-copy'; }

      // Fallback: search globally for copy icons near our key
      const allCopyBtns = [...document.querySelectorAll('.icon-wdapp_copy, [class*="wdapp_copy"]')];
      // Click each and check which one captures our key
      for (const btn of allCopyBtns) {
        btn.click();
      }
      return 'clicked-all-copy:' + allCopyBtns.length;
    })()`).catch(() => 'click-failed');
    console.log('[auto-create] zhipu: copy button →', clickResult);

    // Read the intercepted clipboard value
    await sleep(1000);
    const capturedKey = await execJs('window.__okitCapturedKey || ""').catch(() => '');
    console.log('[auto-create] zhipu: clipboard capture', capturedKey ? 'received' : 'empty');
    if (isValidZhipuApiKey(capturedKey)) {
      await closeAutomationWindow();
      return { value: capturedKey, name: uniqueName };
    }
  }

  // Diagnostic: retain only request metadata. Response bodies can contain the
  // one-time secret and must not be written to logs or to temporary images.
  for (const e of entries) {
    const body = e.responsePreview || '';
    if (/api_key|api_secret|apikey|secret/i.test(body) || /api_keys/i.test(e.url || '')) {
      console.log(`[auto-create] zhipu: matched ${e.method} ${e.responseStatus} ${e.url.slice(0, 100)}`);
    }
  }
  // Count likely key-shaped values for diagnostics without emitting any value.
  const domDiag = await execJs(`(() => {
    const text = document.body.innerText || '';
    // Find all hex-dot-alphanumeric patterns
    const fullKeys = text.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/g) || [];
    // Find all 32-hex patterns
    const hexKeys = text.match(/[a-f0-9]{32}/g) || [];
    return JSON.stringify({ full: fullKeys.length, partial: hexKeys.length });
  })()`).catch(() => '{}');
  try {
    const diag = JSON.parse(domDiag || '{}');
    console.log('[auto-create] zhipu: DOM key pattern counts', { full: diag.full || 0, partial: diag.partial || 0 });
  } catch {}

  // 8. zhipu keys are "apiKey.secretKey" format. The network response only
  //    returns a masked secretKey (e.g. "*****Y4n6"), so we must get the full
  //    secret from the DOM — zhipu shows it in a success dialog or key list
  //    after creation, with a copy button containing the full value.
  if (key) {
    // We have the apiKey from network; try to find the full secret on the page
    const fullKey = await execJs(`(() => {
      const text = document.body.innerText || '';

      // Strategy 1: look for the complete "hex.alphanumeric" key format directly
      // e.g. "64a3a143172d4b5e9420583a0b93d943.i2IC1jQfoptP1xOe"
      const fullMatch = text.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
      if (fullMatch) return fullMatch[1];

      // Strategy 2: look in input/copy fields (zhipu may have a hidden input
      // or data-attribute with the full key for the copy-to-clipboard feature)
      const inputs = [...document.querySelectorAll('input, textarea, [data-key], [data-clipboard-text]')];
      for (const el of inputs) {
        const val = el.value || el.getAttribute('data-key') || el.getAttribute('data-clipboard-text') || '';
        const m = val.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
        if (m) return m[1];
      }

      // Strategy 3: look in clipboard-related buttons or code blocks
      const codeBlocks = [...document.querySelectorAll('code, pre, .api-key-value, .key-value, [class*="key"], [class*="secret"]')];
      for (const el of codeBlocks) {
        const val = el.textContent || el.value || '';
        const m = val.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
        if (m) return m[1];
      }

      return '';
    })()`).catch(() => '');
    if (isValidZhipuApiKey(fullKey)) {
      console.log('[auto-create] zhipu: found full key (with secret) from DOM');
      key = fullKey;
    }
  }

  // 9. If still no key, try DOM-only extraction of the full key format.
  if (!key) {
    const domKey = await execJs(`(() => {
      const text = document.body.innerText || '';
      const fullMatch = text.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
      return fullMatch ? fullMatch[1] : '';
    })()`).catch(() => '');
    if (isValidZhipuApiKey(domKey)) key = domKey;
  }

  if (!key) {
    // List key-like API URLs in the error for debugging
    const apiUrls = entries
      .filter(e => /api_keys|apikeys|apikey|token/i.test(e.url))
      .map(e => `${e.method} ${e.responseStatus} ${e.url.slice(0, 120)}`)
      .join('\n  ');
    throw new Error(`未捕获到 key (抓包 ${entries.length} 条,API 相关:\n  ${apiUrls || '(无)'})`);
  }

  // The full zhipu key is "32-hex.secret-alnum". A masked or partial capture
  // (bare id, truncated secret, asterisks, or ellipses) must never be saved.
  if (!isValidZhipuApiKey(key)) {
    throw new Error('未读到完整有效的智谱 API Key(应形如 32 位小写十六进制 + "." + 至少 6 位字母数字),为避免保存被掩码的值已停止写入。');
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

/** Two-phase confirm for the zhipu name dialog/form, shared by the initial
 *  confirm and by re-confirming while the one-time key dialog may still be
 *  open. Phase 1 is read-only: the browser lists visible enabled controls
 *  scoped to the name input's form/dialog and flags button[type=submit]
 *  selector evidence; Node resolves a single target with ZHIPU_CONFIRM_TEXTS
 *  (generic labels allowed only inside that scope). Phase 2 recomputes the
 *  scope and rechecks the same index, its fingerprint, and that the scope
 *  still contains the target plus the selector evidence before clicking.
 *  Missing, disabled or ambiguous targets fail closed: an error object is
 *  returned and nothing is clicked. */
async function clickZhipuConfirm() {
  const options = {
    phrases: ZHIPU_CONFIRM_TEXTS,
    allowGenericInsideScope: true,
  };
  const collectRaw = await execJs(`(() => {
    const nameSelector = ${JSON.stringify(ZHIPU_NAME_SELECTORS)};
    const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="popup"]';
    const visible = el => {
      const r = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
    };
    const visibleEnabled = el => visible(el) && !el.disabled;
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();

    const nameInputCandidate = document.querySelector(nameSelector);
    const nameInput = visible(nameInputCandidate) ? nameInputCandidate : null;
    // Scope to the form/dialog that holds the name input, else any visible
    // dialog. Zhipu ships no explicit confirmSelectors, so document-wide
    // scope is never acceptable.
    let scope = null;
    if (nameInput) scope = nameInput.closest('form') || nameInput.closest(dialogSelectors);
    const hasScope = Boolean(scope);
    const inScopeOf = el => hasScope && (scope === document || scope === el || scope.contains(el));

    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
    const descriptors = controls.map((el, index) => {
      let selectorMatch = false;
      try { if (el.matches('button[type="submit"]')) selectorMatch = true; } catch { /* unselectable selector */ }
      selectorMatch = selectorMatch && inScopeOf(el);
      return {
        index,
        text: (el.textContent || '').trim().slice(0, 120),
        ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
        title: (el.title || '').trim().slice(0, 120),
        inVerifiedScope: inScopeOf(el),
        selectorMatch,
      };
    });
    return JSON.stringify({
      hasScope,
      nameFound: Boolean(nameInput),
      descriptors,
      buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16),
    });
  })()`);
  let collect = {};
  try { collect = JSON.parse(collectRaw || '{}'); } catch { collect = {}; }

  if (!collect.hasScope) {
    return { error: 'confirm-not-found', buttons: collect.buttons || [] };
  }
  const scopedCandidates = (collect.descriptors || []).filter(d => d.inVerifiedScope);
  const selected = resolveActionCandidate(scopedCandidates, options);
  if (!selected) {
    const scored = scopedCandidates
      .map(c => ({ raw: (c.text || '').slice(0, 40), score: scoreActionCandidate(c, options) }))
      .filter(entry => entry.score >= CREATE_ACTION_SCORE_THRESHOLD);
    return {
      error: scored.length === 0 ? 'confirm-not-found' : 'confirm-ambiguous',
      buttons: collect.buttons || [],
      scores: scored,
    };
  }

  const fingerprint = descriptorFingerprint(selected);
  const expectSelector = Boolean(selected.selectorMatch);
  const clickRaw = await execJs(`(() => {
    const nameSelector = ${JSON.stringify(ZHIPU_NAME_SELECTORS)};
    const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="popup"]';
    const visible = el => {
      const r = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
    };
    const visibleEnabled = el => visible(el) && !el.disabled;
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const slice = value => String(value == null ? '' : value).trim().slice(0, 120);

    const nameInputCandidate = document.querySelector(nameSelector);
    const nameInput = visible(nameInputCandidate) ? nameInputCandidate : null;
    let scope = null;
    if (nameInput) scope = nameInput.closest('form') || nameInput.closest(dialogSelectors);
    // Abort unless a scope around the name input still exists.
    if (!scope) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-gone' });

    const targetIndex = ${selected.index};
    const expected = ${JSON.stringify(fingerprint)};
    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
    const target = controls[targetIndex];
    if (!target) return JSON.stringify({ error: 'confirm-mismatch', reason: 'index-gone' });
    // The recomputed scope must still contain the approved target.
    if (scope !== document && !scope.contains(target)) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-changed' });
    const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
      .map(normalize).join('|');
    if (actual !== expected) return JSON.stringify({ error: 'confirm-mismatch', reason: 'fingerprint-changed' });
    // Selector evidence must still hold when it chose the target.
    if (${expectSelector}) {
      let stillMatches = false;
      try { if (target.matches('button[type="submit"]')) stillMatches = true; } catch {}
      if (!stillMatches) return JSON.stringify({ error: 'confirm-mismatch', reason: 'selector-gone' });
    }
    target.click();
    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 20) });
  })()`);
  let clickState = {};
  try { clickState = JSON.parse(clickRaw || '{}'); } catch { clickState = {}; }
  if (!clickState.ok) {
    return { error: 'confirm-mismatch', reason: clickState.reason, buttons: collect.buttons || [] };
  }
  return { ok: true, text: clickState.text };
}

// ─── Volcengine Ark (火山方舟) — atomic-capability orchestration ──
// The IAM API-key page creates AK/SK credentials for the cloud API. Those
// credentials cannot authenticate against Ark's OpenAI-compatible /api/v3
// endpoint. Model management must instead use Ark's dedicated API Key page.
// Live-verified flow: API Key 管理 → 创建 API Key → 名称 → 创建 → find the
// created row → click its eye icon. Ark's creation response contains only an
// internal API-key ID; the actual model credential is revealed by that row.
const VOLC_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey';
const VOLC_AGENT_PLAN_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan';
const VOLC_CREATE_TEXTS = ['创建 API Key'];

async function detectVolcengineLoginSurface() {
  const raw = await execJs(`(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const bodyText = String(document.body?.innerText || '').slice(0, 16000);
    const loginAction = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter(visible)
      .some(el => /登录|登入|sign in|log in/i.test(String(el.textContent || '').trim()));
    const loginPrompt = /立即登录使用|请先登录|登录后继续|登录后使用/i.test(bodyText);
    const credentialSurface = /API\s*Key|密钥管理|调用凭证|credential/i.test(bodyText);
    return JSON.stringify({ required: loginPrompt || (credentialSurface && loginAction) });
  })()`).catch(() => '{"required":false}');
  try { return Boolean(JSON.parse(raw || '{}').required); } catch { return false; }
}

async function createVolcengineKey({ tokenName, url = VOLC_URL, run }) {
  // Platform names must be unique. Keep the vault variable deterministic while
  // using a harmless suffix only for the console-side display name.
  const nameSuffix = Date.now().toString(36).slice(-4);
  const requestedName = `${tokenName}-${nameSuffix}`;
  const uniqueName = requestedName;
  const nav = await sendCommand('navigate', { url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const tabId = nav.data && nav.data.tabId;
  console.log('[auto-create] volcengine: navigated (tab ' + tabId + ')');

  // Ark renders a public shell with a visible “登录” action instead of
  // redirecting to /login. Detect that state before searching for the create
  // button so a signed-out account becomes a resumable login handoff rather
  // than a misleading “create button missing” failure.
  const loginState = await detectLoginRequired();
  if (loginState.loginRequired || await detectVolcengineLoginSurface()) {
    throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
  }

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] volcengine: capture armed');

  // Ark is an SPA. Poll its explicit create action rather than assuming a
  // fixed load time, so an expired session is not misreported as a click bug.
  let opened = false;
  for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
    const currentLoginState = await detectLoginRequired();
    if (currentLoginState.loginRequired || await detectVolcengineLoginSurface()) {
      throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
    }
    if (await detectInteractiveVerification('volcengine')) {
      await waitForInteractiveVerification({ run, platform: { id: 'volcengine', label: '火山引擎' }, stage: 'before-create' });
    }
    const result = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => ${JSON.stringify(VOLC_CREATE_TEXTS)}.includes((el.textContent || '').trim().replace(/\s+/g, ' ')));
      if (!button) return JSON.stringify({ error: 'create-not-found' });
      button.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{}');
    try { opened = Boolean(JSON.parse(result || '{}').ok); } catch {}
    if (!opened) await sleep(1000);
  }
  if (!opened) {
    if (await detectVolcengineLoginSurface()) {
      throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
    }
    if (url === VOLC_AGENT_PLAN_URL) {
      const currentUrl = await execJs('location.href').catch(() => '');
      if (/\/subscription\/agent-plan(?:[/?#]|$)/.test(currentUrl)) {
        throw new Error('当前账号被火山方舟重定向到 Agent Plan 套餐页，说明 Agent Plan 尚未开通、已失效或权益尚未生效。请先开通或续费 Agent Plan，待套餐生效后再自动创建专属 API Key。');
      }
    }
    throw new Error('未找到火山方舟“创建 API Key”按钮');
  }

  if (await detectInteractiveVerification('volcengine')) {
    await waitForInteractiveVerification({ run, platform: { id: 'volcengine', label: '火山引擎' }, stage: 'create-action' });
  }
  await sleep(500);
  const formResult = await execJs(`(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    // The Ark modal contains several nested elements whose generated class
    // names include "dialog". Selecting the last such element can scope us
    // below the input. Locate the visible form control globally, but require
    // the provider's visible label/default name so the global page search box
    // is never chosen.
    const inputs = [...document.querySelectorAll('input')]
      .filter(el => visible(el) && !el.disabled);
    const input = inputs.find(el => /名称|name/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')))
      || inputs.find(el => /^api-key-/i.test(el.value || ''));
    if (!input) return JSON.stringify({ error: 'name-input-not-found' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(uniqueName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const create = [...document.querySelectorAll('button, [role="button"]')].find(el => {
      const text = (el.textContent || '').trim().replace(/\s+/g, '');
      return visible(el) && text === '创建' && !el.disabled;
    });
    if (!create) return JSON.stringify({ error: 'confirm-not-found' });
    create.click();
    return JSON.stringify({ ok: true });
  })()`).catch(() => '{}');
  let formState = {};
  try { formState = JSON.parse(formResult || '{}'); } catch {}
  if (formState.error) throw new Error(`火山方舟创建对话框异常：${formState.error}`);

  await sleep(800);
  // The create mutation returns an internal 32-character API-key ID, not the
  // model API credential. Ark exposes the actual key only after the eye icon
  // in its newly-created table row is clicked. Scope every action to our
  // unique display name so we never reveal or copy a different key.
  let key = '';
  for (let attempt = 0; attempt < 8 && !key; attempt += 1) {
    const revealResult = await execJs(`(() => {
      const rows = [...document.querySelectorAll('tr')];
      const row = rows.find(el => (el.innerText || '').includes(${JSON.stringify(uniqueName)}));
      if (!row) return JSON.stringify({ error: 'created-row-not-found' });
      const eye = row.querySelector('svg[class*="eye"]');
      if (!eye) return JSON.stringify({ error: 'reveal-control-not-found' });
      const clickable = eye.parentElement || eye;
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      clickable.click?.();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{}');
    let revealState = {};
    try { revealState = JSON.parse(revealResult || '{}'); } catch {}
    if (revealState.error && revealState.error !== 'created-row-not-found') {
      throw new Error(`火山方舟创建成功，但无法展开该 Key：${revealState.error}`);
    }
    await sleep(350);
    const revealed = await execJs(`(() => {
      const row = [...document.querySelectorAll('tr')]
        .find(el => (el.innerText || '').includes(${JSON.stringify(uniqueName)}));
      if (!row) return '';
      // Ark keys are opaque 46-character tokens. Resource IDs are shorter
      // apikey-prefixed resource IDs are intentionally excluded here.
      const match = (row.innerText || '').match(/\\b[A-Za-z0-9_-]{40,}\\b/);
      return match ? match[0] : '';
    })()`).catch(() => '');
    if (revealed && !isAssetData(revealed)) key = revealed;
    if (!key) await sleep(500);
  }
  if (key) {
    await closeAutomationWindow();
    return { value: key, name: uniqueName };
  }

  const entries = [];
  const entryIdentity = entry => [entry?.url || '', entry?.method || '', entry?.timestamp || ''].join('|');
  let capturedCandidate = '';
  for (let attempt = 0; attempt < 5 && !capturedCandidate; attempt += 1) {
    await sleep(700);
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || 'network-capture-read failed');
    for (const entry of (read.data || [])) {
      const identity = entryIdentity(entry);
      const previous = entries.find(candidate => entryIdentity(candidate) === identity);
      if (!previous) entries.push(entry);
      else if (!previous.responsePreview && entry.responsePreview) Object.assign(previous, entry);
    }
    const candidate = extractKeyFromCaptures(entries, 'volcengine');
    // Do not mistake Ark's 32-character internal ID for a usable credential.
    if (/^[A-Za-z0-9_-]{40,}$/.test(candidate || '')) capturedCandidate = candidate;
  }
  console.log('[auto-create] volcengine: captured ' + entries.length + ' requests');
  // Response bodies can contain a one-time credential. Keep diagnostics to
  // field paths, lengths and shapes so an Ark UI/API change is observable
  // without writing any key material to logs.
  const volcSecretFields = describeCapturedSecretFields(entries);
  if (volcSecretFields.length) {
    console.log('[auto-create] volcengine: safe key-field diagnostics ' + JSON.stringify(volcSecretFields));
  }

  key = capturedCandidate;

  if (!key) {
    const domKey = await execJs(`(() => {
      const text = document.body.innerText || '';
      // Ark keys are UUID-like; never fall back to the IAM AKLT pattern.
      const arkMatch = text.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/i);
      if (arkMatch) return arkMatch[0];
      const tokens = text.match(/[a-zA-Z0-9_-]{40,}/g) || [];
      for (const t of tokens) {
        if (t.length > 500 || /css|chunk|font|webpack|preview/i.test(t)) continue;
        if (/^[0-9]+$/.test(t)) continue;
        return t;
      }
      return '';
    })()`).catch(() => '');
    if (domKey && !isAssetData(domKey)) key = domKey;
  }

  if (!key) {
    const apiUrls = entries
      .filter(e => /ark|key|token|secret/i.test(e.url))
      .map(e => e.method + ' ' + e.responseStatus + ' ' + e.url.slice(0, 100))
      .join('\n  ');
    throw new Error('volcengine 未捕获到 key (抓包 ' + entries.length + ' 条。API 相关:\n  ' + (apiUrls || '(无)') + ')');
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

// ─── MiniMax — atomic-capability orchestration ──────────────────────
// Flow: navigate → arm capture → dismiss M3 promo modal → click "创建" →
//       fill name in ant-modal → confirm via ant-modal-Footer primary btn →
//       read → extract. Known gotcha: a "MiniMax M3" promotional modal
//       covers the create button and must be dismissed first.
const MINIMAX_URL = 'https://platform.minimaxi.com/user-center/basic-information/interface-key';
const MINIMAX_CREATE_TEXTS = ['创建 API Key', '创建新的', 'Create new', '新建', '创建', 'Create'];

async function createMinimaxKey({ tokenName, run }) {
  // Append timestamp suffix to avoid name collisions on the platform
  const uniqueName = tokenName + '-' + Date.now().toString(36).slice(-4);

  const nav = await sendCommand('navigate', { url: MINIMAX_URL, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const tabId = nav.data && nav.data.tabId;

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] minimax: capture armed');

  await sleep(3000);
  if (await detectInteractiveVerification('minimax')) {
    await waitForInteractiveVerification({ run, platform: { id: 'minimax', label: 'MiniMax' }, stage: 'before-create' });
  }

  // CRITICAL: dismiss the "MiniMax M3" promotional modal first — it covers
  // the create button and intercepts clicks.
  await execJs(`(() => {
    for (let i = 0; i < 8; i++) {
      // Close buttons: 我知道了 / 关闭 / 取消 + generic modal close
      const closeTexts = ['我知道了', '关闭', '取消', 'Close', 'Got it'];
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const close = btns.find(b => closeTexts.some(t => (b.textContent || '').trim() === t || (b.textContent || '').includes(t)));
      if (close) { close.click(); }
      const x = document.querySelector('.ant-modal-close, [aria-label="Close"]');
      if (x) { x.click(); }
      const mask = document.querySelector('.ant-modal-mask');
      if (mask) { mask.click(); }
    }
    return 'promo-dismissed';
  })()`).catch(() => 'promo-skipped');
  console.log('[auto-create] minimax: promo dismissed');
  await sleep(500);

  // Click create button
  await execJs(`(() => {
    const texts = ${JSON.stringify(MINIMAX_CREATE_TEXTS)};
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const visible = els.filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.disabled;
    });
    const btn = visible.find(e => texts.some(t => (e.textContent || '').includes(t)));
    if (!btn) throw new Error('未找到创建按钮');
    btn.click();
    return 'clicked';
  })()`);
  console.log('[auto-create] minimax: create clicked');
  if (await detectInteractiveVerification('minimax')) {
    await waitForInteractiveVerification({ run, platform: { id: 'minimax', label: 'MiniMax' }, stage: 'create-action' });
  }

  // Wait for the ant-modal to appear
  await sleep(2500);

  // Fill name — minimax uses ant-modal inputs
  await execJs(`(() => {
    // Try multiple selectors within the modal
    const selectors = ['.ant-modal input', '.ant-modal-content input', 'input.ant-input', 'input[type="text"]:not([disabled])'];
    for (const sel of selectors) {
      const inp = document.querySelector(sel);
      if (inp && inp.getBoundingClientRect().width > 0) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(uniqueName)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'filled:' + sel;
      }
    }
    throw new Error('未找到 modal 输入框');
  })()`);

  // Confirm via ant-modal-Footer primary button
  await sleep(500);
  await execJs(`(() => {
    const selectors = [
      '.ant-modal-footer button.ant-btn-primary',
      '.ant-modal-Footer button.ant-btn-primary',
      '.ant-modal-footer button:not([disabled])',
      '.ant-modal button[type="submit"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.getBoundingClientRect().width > 0 && !btn.disabled) {
        btn.click();
        return 'confirmed:' + sel;
      }
    }
    // Fallback: any primary-looking button in modal
    const modal = document.querySelector('.ant-modal-content');
    if (modal) {
      const btns = [...modal.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0 && !b.disabled);
      const primary = btns.find(b => /确定|确认|创建|Create|Confirm/i.test(b.textContent));
      if (primary) { primary.click(); return 'fallback-confirmed'; }
    }
    throw new Error('未找到确认按钮');
  })()`);

  await sleep(3000);
  const entries = [];
  const entryIdentity = entry => [entry?.url || '', entry?.method || '', entry?.timestamp || ''].join('|');
  const collectCapture = async () => {
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || 'network-capture-read failed');
    for (const entry of (read.data || [])) {
      const identity = entryIdentity(entry);
      const previous = entries.find(candidate => entryIdentity(candidate) === identity);
      if (!previous) entries.push(entry);
      else if (!previous.responsePreview && entry.responsePreview) Object.assign(previous, entry);
    }
  };

  let key = null;
  // The create mutation can finish after the UI has closed its dialog. Keep a
  // short bounded read window so delayed response bodies are not mistaken for
  // a failed creation. The extension now waits for already-scheduled CDP body
  // reads before draining, while this loop covers providers that render late.
  for (let attempt = 0; attempt < 6 && !key; attempt += 1) {
    if (attempt > 0) await sleep(700);
    await collectCapture();
    key = extractKeyFromCaptures(entries, 'minimax');

    // DOM fallback — MiniMax keys are usually sk-api-... but some accounts
    // receive the ordinary sk- form. Read one-time result fields as well as
    // visible text because the modal may use an input or copy attribute.
    if (!key) {
      const domKey = await execJs(`(() => {
        const sources = [document.body?.innerText || ''];
        for (const el of document.querySelectorAll('input, textarea, code, pre, [data-clipboard-text], [data-copy], [data-key]')) {
          sources.push(el.value || el.textContent || el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') || el.getAttribute('data-key') || '');
        }
        for (const source of sources) {
          const m = String(source).match(/(sk-api-[a-zA-Z0-9\\-_]{20,})/) || String(source).match(/(sk-[a-zA-Z0-9\\-_]{30,})/);
          if (m) return m[1];
        }
        return '';
      })()`).catch(() => '');
      if (domKey && !isAssetData(domKey)) key = domKey;
    }
  }
  console.log(`[auto-create] minimax: captured ${entries.length} requests`);

  // MiniMax documents that the newly-created secret is shown once and must be
  // copied immediately. Some console builds return only a success envelope
  // from /backend/token and place the secret exclusively behind the result
  // dialog's Copy control. Use that control only when it is uniquely scoped
  // to an API-key dialog; never click an ambiguous page-wide copy button.
  if (!key) {
    await execJs(`(() => {
      window.__okitMinimaxCopiedKey = '';
      const capture = value => {
        const text = String(value || '');
        const match = text.match(/sk-(?:api-)?[A-Za-z0-9_-]{20,}/);
        if (match) window.__okitMinimaxCopiedKey = match[0];
      };
      try {
        const clipboard = navigator.clipboard;
        const original = clipboard?.writeText?.bind(clipboard);
        if (original) {
          const wrapped = text => { capture(text); return original(text); };
          try { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
          try { Object.defineProperty(Object.getPrototypeOf(clipboard), 'writeText', { configurable: true, value: wrapped }); } catch {}
        }
      } catch {}
      document.addEventListener('copy', event => {
        capture(event.clipboardData?.getData('text/plain') || window.getSelection()?.toString() || '');
      }, true);
      return 'minimax-copy-capture-ready';
    })()`).catch(() => 'minimax-copy-capture-failed');
    const copyStateRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
      };
      const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]';
      const dialogs = [...document.querySelectorAll(dialogSelectors)].filter(visible).filter(dialog => {
        const text = String(dialog.innerText || '');
        return /API\\s*Key|密钥|secret|sk-/i.test(text);
      });
      const candidates = dialog => [...dialog.querySelectorAll('button, a, [role="button"]')].filter(visible).filter(el => {
        const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.className]
          .filter(value => typeof value === 'string').join(' ');
        return /复制|copy/i.test(label);
      });
      const matches = dialogs.flatMap(dialog => candidates(dialog).map(control => ({ dialog, control })));
      if (matches.length !== 1) return JSON.stringify({ ok: false, dialogs: dialogs.length, copies: matches.length });
      const rect = matches[0].control.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let copyState = {};
    try { copyState = JSON.parse(copyStateRaw || '{}'); } catch {}
    if (copyState.ok) {
      const clicked = await foregroundClick({ x: copyState.x, y: copyState.y, tabId });
      if (clicked) {
        await sleep(500);
        const pageCopied = await execJs('window.__okitMinimaxCopiedKey || ""').catch(() => '');
        if (pageCopied && !isAssetData(pageCopied)) key = pageCopied;
        if (!key) {
          const clipboardRead = await sendCommand('clipboard-read', {
            workspace: 'okit',
            clipboardPattern: 'sk-(?:api-)?[A-Za-z0-9_-]{20,}',
          }, 5000).catch(() => ({ ok: false, data: {} }));
          const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
          if (clipboardValue && !isAssetData(clipboardValue)) key = clipboardValue;
        }
      }
    }

  }

  if (!key) {
    const apiUrls = entries
      .filter(e => /key|token|interface|api/i.test(e.url))
      .map(e => `${e.method} ${e.responseStatus} ${e.url.slice(0, 120)}`)
      .join('\n  ');
    const responseDiagnostics = describeCapturedResponses(entries)
      .filter(entry => /backend\/token|key|token|interface|api/i.test(entry.path));
    const secretFieldDiagnostics = describeCapturedSecretFields(entries)
      .filter(entry => /backend\/token|key|token|interface|api/i.test(entry.path));
    const backendResults = describeMinimaxBackendResults(entries);
    console.log('[auto-create] minimax: safe response diagnostics', JSON.stringify(responseDiagnostics));
    if (backendResults.length) {
      console.log('[auto-create] minimax: backend result diagnostics', JSON.stringify(backendResults));
    }
    if (secretFieldDiagnostics.length) {
      console.log('[auto-create] minimax: safe secret-field diagnostics', JSON.stringify(secretFieldDiagnostics));
    }
    const backendSummary = backendResults.length ? `,后端结果:${JSON.stringify(backendResults)}` : '';
    throw new Error(`minimax 未捕获到 key (抓包 ${entries.length} 条,API 相关:\n  ${apiUrls || '(无)'},响应体诊断:${JSON.stringify(responseDiagnostics)}${backendSummary})`);
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

// ─── Platform registry and shared browser flow ─────────────────────
//
// The registry is the single source of truth for the Vault UI and the API.
// Every entry below maps to an online provider available in Model Management;
// local runtimes and OAuth-only Codex intentionally do not appear here.
// A browser flow always uses the user's already signed-in session in the OKIT
// automation window. It never receives or stores a platform password.

const AUTO_CREATE_PLATFORMS = [
  { id: 'cloudflare', label: 'Cloudflare', keyHint: 'CLOUDFLARE_TOKEN', groupHint: 'Cloudflare', mode: 'api' },
  // Verified in the authenticated Platform console: the name field is
  // "My Test Key", and the dialog ends with "Create secret key".
  { id: 'openai', label: 'OpenAI', keyHint: 'OPENAI_API_KEY', groupHint: 'OpenAI', mode: 'browser', url: 'https://platform.openai.com/api-keys', createTexts: ['Create new secret key'], createWaitAttempts: 30, deleteReadyAttempts: 30, deleteButtonSelector: 'button[data-color="danger"]', nameSelectors: ['input[placeholder="My Test Key"]'], confirmTexts: ['Create secret key'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, keyPatterns: ['sk-(?:proj-)?[A-Za-z0-9_-]{20,}'] },
  { id: 'anthropic', label: 'Anthropic', keyHint: 'ANTHROPIC_API_KEY', groupHint: 'Anthropic', mode: 'browser', url: 'https://platform.claude.com/settings/workspaces/default/keys', createTexts: ['Create Key', 'Create API Key', 'Create key', '创建 API Key', '创建密钥', '新建 API Key'], formReadyAttempts: 8, deleteMenuTexts: ['More actions', '更多操作', 'More', '更多', '⋯', '…'], nameSelectors: ['input[placeholder*="key name" i]', 'input[placeholder*="name" i]', 'input[aria-label*="key name" i]', 'input[aria-label="Name" i]', 'input[name*="name" i]', 'input[id*="name" i]', 'input[placeholder*="密钥名" i]', 'input[aria-label*="密钥名" i]'], requireNameInput: true, allowDialogTextInputFallback: true, preConfirmSelectDefaults: [{ triggerTexts: ['Select an expiration', '3 hours', '1 day', '7 days', '30 days', '选择到期时间', '3 小时', '1 天', '7 天', '30 天'], optionTexts: ['Never', 'No expiration', '永不过期'], optional: true }], confirmTexts: ['Add', 'Create key', 'Create Key', 'Create', '添加', '创建密钥', '创建'], allowConfirmCreateText: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 5, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', 'input[value*="sk-ant"]', 'code', 'span.font-mono', 'div.font-mono'], postCreateCopyTexts: ['Copy'], postCreateCopyAttempts: 10, postCreateCopyRetryMs: 800, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-ant-api[a-zA-Z0-9_-]{16,}'] },
  // Verified in the signed-in Chinese AI Studio UI: the key is named through
  // its aria-labelled input and finalized with "创建密钥".
  { id: 'volcengine', label: '火山引擎', keyHint: 'VOLCENGINE_API_KEY', groupHint: '火山引擎', mode: 'browser' },
  { id: 'volcengine-agent', label: '火山引擎 Agent Plan', keyHint: 'VOLCENGINE_AGENT_PLAN_API_KEY', groupHint: '火山引擎 Agent Plan', mode: 'browser', url: VOLC_AGENT_PLAN_URL },
  // Volcengine's traditional AK/SK is intentionally manual-only. It is an
  // IAM identity credential, not an API key, and its permissions/rotation
  // limits cannot be safely managed by this browser key flow. See
  // docs/volcengine-usage-credentials.md.
  // Tencent Cloud's normal TokenHub API Key is separate from the Token Plan
  // key. The normal key is created in API Key management and must be granted
  // an access scope/model binding there.
  { id: 'tencent', label: '腾讯云', keyHint: 'TENCENT_API_KEY', groupHint: '腾讯云', mode: 'browser', url: 'https://console.cloud.tencent.com/tokenhub/apikey', createTexts: ['创建 API Key', '创建API Key', '创建 API 密钥', '创建API密钥', '新建 API 密钥', '新建API密钥'], nameSelectors: ['input[placeholder*="生产环境"]', 'input[placeholder*="Key"]', 'input[placeholder*="密钥名称"]', 'input[placeholder*="API Key"]', 'input[placeholder*="名称"]'], inlineFormScope: true, deleteSecurityVerificationTexts: ['身份验证', '微信扫码验证', 'MFA'], confirmTexts: ['确认', '确定', '创建'], postCreateCopyTexts: ['复制'], postCreateCopyByMaskedKeyPrefix: 'sk-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Token Plan keys live on the Token Plan tabs, are reused/copied only, and
  // are not interchangeable with normal TokenHub API Keys. The official key
  // format is sk-tp-... .
  { id: 'tencent-token-plan', label: '腾讯云 Token Plan', keyHint: 'TENCENT_TOKEN_PLAN_API_KEY', groupHint: '腾讯云', mode: 'browser', url: 'https://console.cloud.tencent.com/tokenhub/tokenplan', createTexts: ['生成密钥', '生成 API Key', '生成API Key', '创建 API Key', '创建API Key', '复制'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-tp-', missingExistingKeyMessage: '腾讯云 Token Plan 当前没有可复用的订阅 Key；请在 Token Plan 页面生成或复制 sk-tp- 开头的专属 Key，自动化不会重置已有 Key。', confirmTexts: ['确认', '确定', '创建'], postCreateCopyTexts: ['复制', '复制密钥', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-tp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['sk-tp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: '腾讯云 Token Plan 页面没有读取到 sk-tp- 开头的明文 Key；为避免误存普通 API Key 或重置已有 Key，请在 Token Plan 页面手动复制后重试。' },
  // Tencent SecretId/SecretKey is a CAM identity credential used by the
  // Billing API. Keep it manual-only: OKIT must not acknowledge primary-account
  // risk dialogs, choose an IAM identity, or create a credential it cannot
  // synchronize after deletion in the cloud console.
  { id: 'zhipu', label: '智谱 AI（国内站）', keyHint: 'ZHIPUAI_API_KEY', groupHint: '智谱AI', mode: 'browser', deleteConfirmWaitAttempts: 20, deleteConfirmTexts: ['确定'], deleteDialogText: '此操作将永久删除该行数据' },
  // Verified on the signed-in Z.AI console: the entry is "Add API Key", then
  // the dialog requires an "API key name" before its "Create" action is enabled.
  { id: 'zai-global', label: 'Z.AI（国际站）', keyHint: 'ZAI_API_KEY', groupHint: 'Z.AI', mode: 'browser', url: 'https://z.ai/manage-apikey/apikey-list', deleteButtonSelector: 'td.ant-table-cell-fix-end > div', deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['Remove'], deleteDialogText: 'This operation will permanently delete the data', createTexts: ['Add API Key'], nameSelectors: ['input#apiKeyName', 'input[placeholder="API key name"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, postCreateRowCopySelector: 'svg.lucide-copy', postCreateCopyAttempts: 20, postCreateCopyRetryMs: 1000, allowExtensionClipboardRead: true, requirePostCreateCopy: true, keyPatterns: ['[^.\\s]{8,128}\\.[^.\\s]{8,256}'], postCreateCopyFailureMessage: 'Z.AI 已创建 API Key，但列表复制控件没有返回可保存的明文；为避免保存掩码，已停止写入 Vault。' },
  { id: 'minimax', label: 'MiniMax（国内站）', keyHint: 'MINIMAX_API_KEY', groupHint: 'MiniMax · 国内', mode: 'browser', deleteDomRetry: true, deleteConfirmTexts: ['删 除'], deleteDialogText: '此 API Key 将立即被禁用', deleteConfirmWaitAttempts: 10 },
  // Token Plan uses a dedicated sk-cp key that is not interchangeable with
  // the ordinary pay-as-you-go API key. The subscribed account exposes the
  // key on the Token Plan page and may already have generated it.
  { id: 'minimax-coding', label: 'MiniMax Token Plan（国内）', keyHint: 'MINIMAX_TOKEN_PLAN_API_KEY', groupHint: 'MiniMax · 国内', mode: 'browser', url: 'https://platform.minimaxi.com/console/plan', createTexts: ['复制', '复 制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-cp-', missingExistingKeyMessage: 'MiniMax Token Plan（国内）页面没有显示可复制的订阅 Key。请确认账户已获得订阅 Key；自动化不会点击“重置 Key”。', postCreateCopyTexts: ['复制', '复 制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-cp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-cp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: 'MiniMax Token Plan（国内）页面已打开，但没有从订阅 Key 旁的复制按钮读取到明文。自动化不会点击“重置 Key”，以免现有 Key 失效。' },
  // Verified on the signed-in international console: "Create new API Key"
  // opens a named form whose final action is simply "Create".
  { id: 'minimax-global', label: 'MiniMax（国际站）', keyHint: 'MINIMAX_GLOBAL_API_KEY', groupHint: 'MiniMax · 国际', mode: 'browser', url: 'https://platform.minimax.io/user-center/basic-information/interface-key', deleteDomRetry: true, createTexts: ['Create new API Key'], deleteDisplayNameLength: 45, deleteConfirmTexts: ['Revoke'], deleteDialogText: 'This API Key will be immediately disabled', nameSelectors: ['input#token_name', 'input[placeholder="Please enter a key name"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, keyPatterns: ['sk-(?:api-)?[A-Za-z0-9_-]{20,}'] },
  // The international Token Plan mirrors the mainland console: one account
  // subscription key is shown on Plan details and copied in place. Never use
  // the ordinary API Keys page or click Reset key during automatic capture.
  { id: 'minimax-global-coding', label: 'MiniMax Token Plan（国际）', keyHint: 'MINIMAX_GLOBAL_TOKEN_PLAN_API_KEY', groupHint: 'MiniMax · 国际', mode: 'browser', url: 'https://platform.minimax.io/console/plan', deleteDisplayNameLength: 45, createTexts: ['Copy', '复制', '复 制'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-cp-', missingExistingKeyMessage: 'MiniMax Token Plan（国际）页面没有显示可复制的 Subscription Key。请确认账户已获得订阅 Key；自动化不会点击 Reset key。', postCreateCopyTexts: ['Copy', 'Copy key', '复制', '复 制', '复制密钥'], postCreateCopyByMaskedKeyPrefix: 'sk-cp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-cp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: 'MiniMax Token Plan（国际）页面已打开，但没有从 Subscription Key 旁的 Copy 按钮读取到明文。自动化不会点击 Reset key，以免现有 Key 失效。' },
  // DeepSeek's current console uses custom div[role="button"] controls. The
  // create flow is exactly: dismiss the optional email reminder, open
  // "创建 API key", enter the name, then press the dialog's exact "创建".
  // Use real text insertion and a foreground click for the final control so
  // React enables the button instead of leaving its ds-button--disabled class
  // in place after a synthetic value assignment.
  { id: 'deepseek', label: 'DeepSeek', keyHint: 'DEEPSEEK_API_KEY', groupHint: 'DeepSeek', mode: 'browser', url: 'https://platform.deepseek.com/api_keys', deleteReload: true, deleteReloadWaitMs: 2500, deleteReadyAttempts: 20, deletePreDismissTexts: ['稍后再填'], deleteButtonIndex: 1, deleteConfirmTexts: ['删除'], preCreateDismissTexts: ['稍后再填'], createTexts: ['Create new API key', 'Create API key', '创建 API Key', '创建新密钥'], nameSelectors: ['input[placeholder="输入 API key 的名称"]', 'input[placeholder*="输入 API key 的名称"]', 'input[placeholder*="API key 的名称"]'], nameFillViaInput: true, confirmByExactText: true, confirmNeedsForeground: true, confirmTexts: ['创建'], postCreateDomReadAttempts: 8, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], readyAfterMs: 15000 },
  // Verified against the signed-in Kimi international console. The form
  // requires both a name and a project; only its visible `default` project is
  // eligible for automatic selection.
  { id: 'moonshot', label: 'Moonshot API 平台', keyHint: 'MOONSHOT_API_KEY', groupHint: 'Moonshot', mode: 'browser', url: 'https://platform.kimi.ai/console/api-keys', createTexts: ['Create API Key'], createWaitAttempts: 10, nameMaxLength: 30, nameSelectors: ['input[placeholder*="Maximum 32"]'], defaultProjectLabel: 'default', confirmTexts: ['OK'], confirmNeedsForeground: true, confirmKeyboardFallback: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 5, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', 'input[value^="sk-"]'], deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['Confirm'], deleteConfirmSelector: 'button.ant-btn-primary', deleteDialogText: 'Confirm Delete API Key?', deleteConfirmDomRetry: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Keep the stable ID for existing configurations. The Kimi product uses the
  // mainland API console, not the separate Kimi Code subscription page.
  { id: 'kimi-coding', label: 'Kimi（国内站）', keyHint: 'KIMI_API_KEY', groupHint: 'Kimi', mode: 'browser', url: 'https://platform.kimi.com/console/api-keys', createTexts: ['新建 API Key'], createWaitAttempts: 10, nameMaxLength: 32, nameSelectors: ['input[placeholder*="最多输入32"]'], defaultProjectLabel: 'default', confirmTexts: ['确定', '确 定'], confirmByExactText: true, confirmNeedsForeground: false, confirmKeyboardFallback: false, confirmForceKeyboardFallback: false, postCreateDomReadAttempts: 20, postCreateCopyTexts: ['复制', 'Copy', 'copy'], postCreateCopyAttempts: 20, postCreateCopyRetryMs: 800, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 10, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', '[role="dialog"] input', 'input[value^="sk-"]'], deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['确 认', '确认'], deleteDialogText: '确定删除 API Key', keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], postCreateCopyFailureMessage: 'Kimi API Key 已创建，但没有从创建结果的复制按钮读取到一次性明文；请在结果弹窗中手动点击复制后重试。' },
  // Kimi Code subscription keys are managed separately from Kimi Open
  // Platform keys. The console allows up to five named keys and only shows a
  // newly-created secret once, so create a uniquely named key and capture its
  // one-time result instead of trying to reuse a masked row.
  { id: 'kimi-coding-plan', label: 'Kimi Coding Plan', keyHint: 'KIMI_CODE_API_KEY', defaultKeyName: 'KIMI_CODING_PLAN_API_KEY', groupHint: 'Kimi', mode: 'browser', url: 'https://www.kimi.com/code/console', loginRequiredOnPublicRoot: true, createDirectSelector: 'button.create-api-btn', createSelectors: ['button.create-api-btn'], createTexts: ['Create New API Key', 'Create API Key', '创建新的 API Key', '创建新 API Key', '创建 API Key', '新建 API Key'], createWaitAttempts: 12, nameMaxLength: 32, nameSelectors: ['input[placeholder*="名称"]', 'input[placeholder*="name" i]', 'input[name*="name" i]', 'textarea[placeholder*="名称"]', 'textarea[placeholder*="name" i]'], confirmTexts: ['Create', 'Create API Key', '创建', '创建 API Key', '新建 API Key', '新建', '确定'], confirmSelectors: ['.modal-mask .modal-actions button.kimi-button.primary'], allowConfirmCreateText: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 8, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]', 'input[value^="sk-"]', 'code'], postCreateCopyTexts: ['Copy key', 'Copy', '复制密钥', '复制'], postCreateCopyAttempts: 12, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], postCreateCopyFailureMessage: 'Kimi Code API Key 已创建，但创建结果的复制控件没有返回可保存的明文；该 Key 只在创建时显示一次，请在 Kimi Code 控制台手动复制后再录入 Vault。' },
  // Verified in the signed-in Bailian console: the default workspace is
  // already selected; fill its optional description textarea before "确定".
  { id: 'qwen', label: '阿里云百炼', keyHint: 'DASHSCOPE_API_KEY', groupHint: '阿里云百炼', mode: 'browser', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', deleteReadyAttempts: 20, deleteTexts: ['删除'], deleteNoConfirm: true, deleteNoConfirmDomRetry: true, deleteNoConfirmReload: true, deleteNoConfirmReloadWaitMs: 900, createTexts: ['创建API Key'], createWaitAttempts: 10, nameSelectors: ['textarea#description'], confirmTexts: ['确定'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9._-]{20,}'] },
  // 阿里云百炼 Coding Plan — 套餐专属 key，同一个控制台但独立管理页
  // Alibaba Coding Plan supports one dedicated sk-sp- key per subscription.
  // Reuse/copy it instead of submitting a second create action; the provider
  // exposes Reset separately and resetting would invalidate existing clients.
  { id: 'qwen-coding', label: '阿里云百炼 Coding Plan', keyHint: 'DASHSCOPE_CODING_API_KEY', groupHint: '阿里云百炼 Coding Plan', mode: 'browser', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key?plan=coding', createTexts: ['复制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-sp-', missingExistingKeyMessage: '阿里云百炼 Coding Plan 当前没有可复用的专属 Key；请在 Coding Plan 页面获取或复制 sk-sp- 开头的 Key，自动化不会点击“重置 API Key”。', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-sp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-sp-[A-Za-z0-9._-]{20,}'], postCreateCopyFailureMessage: '阿里云百炼 Coding Plan 已有专属 Key，但没有读取到可保存的明文；自动化不会重置 Key，请在 Coding Plan 页面手动复制后重试。' },
  // Token Plan keys are generated on the signed-in My Subscription page and
  // start with sk-sp-. Reuse an existing masked key and copy it; do not reset
  // a live subscription key just to automate vault setup.
  { id: 'qwen-token-plan', label: '阿里云百炼 Token Plan', keyHint: 'DASHSCOPE_TOKEN_PLAN_API_KEY', groupHint: '阿里云百炼', mode: 'browser', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan', createTexts: ['生成 API Key', '生成API Key', '生成', 'Generate API Key', '复制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-sp-', missingExistingKeyMessage: '阿里云百炼 Token Plan 当前没有可复用的订阅 Key；自动化不会生成新的用户 Key。', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-sp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-sp-[A-Za-z0-9._-]{20,}'], postCreateCopyFailureMessage: '阿里云百炼 Token Plan 已有订阅 Key，但没有读取到可保存的明文；自动化不会生成新的 Key。' },
  // The former /manage/ak route is no longer the current RAM credential
  // surface. The signed-in account page is /profile/accessKey; RAM-user keys
  // are created from 身份管理 > 用户 > 凭证管理, so this flow must never guess
  // which RAM user to mutate.
  // Alibaba Cloud AccessKey is an account-level RAM credential. Keep it out
  // of browser auto-create so OKIT never acknowledges a root-account risk
  // dialog or creates an identity credential on the user's behalf. The usage
  // adapter continues to accept manually stored, least-privilege RAM keys.
  // SiliconFlow exposes OpenAI-compatible Bearer keys from its account page.
  { id: 'siliconflow', label: '硅基流动', keyHint: 'SILICONFLOW_API_KEY', groupHint: '硅基流动', mode: 'browser', url: 'https://cloud.siliconflow.cn/account/ak', createTexts: ['新建API密钥', '新建 API 密钥', '创建API密钥', '创建 API 密钥'], nameSelectors: ['input[placeholder*="密钥名称"]', 'input[placeholder*="请输入描述"]', 'input[placeholder*="描述"]', 'input[placeholder*="名称"]'], confirmTexts: ['新建密钥'], deleteDomFirst: true, deleteConfirmWaitAttempts: 10, deleteDialogText: '确认删除密钥', deleteConfirmInputFromDialog: true, deleteConfirmTexts: ['确认删除'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 500, allowExtensionClipboardRead: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Verified on the signed-in BCE API Key page: clicking the list toolbar
  // starts an async route transition before the name form is mounted. Wait
  // for that real form instead of treating the still-visible AI-assistant
  // recommendations as a failed confirmation state.
  { id: 'qianfan', label: '百度千帆', keyHint: 'QIANFAN_API_KEY', groupHint: '百度千帆', mode: 'browser', url: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', createTexts: ['创建API Key'], formReadyAttempts: 12, formReadyDelayMs: 500, inlineFormScope: true, deleteDomFirst: true, deleteAllowMissingAfterClick: true, deleteTextSelector: 'span.idaas-column-operate-item', deleteConfirmWaitAttempts: 10, deleteDialogText: '删除API Key', deleteSecurityVerificationTexts: ['安全验证', '短信验证码'], nameSelectors: ['input#name', 'input[placeholder*="1-64"]'], confirmTexts: ['确定'], postCreateReadAttempts: 5, keyPatterns: ['bce-v3/[A-Za-z0-9_./=-]{20,}'] },
  // Token Plan is the current Qianfan subscription product. Its dedicated
  // key is generated directly by the subscribed account and revealed only
  // through the page's verified Copy action. Reuse it when already present;
  // do not reset a live subscription key.
  { id: 'qianfan-coding', label: '百度千帆 Token Plan', keyHint: 'QIANFAN_CODING_PLAN_API_KEY', groupHint: '百度千帆', mode: 'browser', url: 'https://console.bce.baidu.com/qianfan/resource/token-plan', createTexts: ['点击生成', '复制'], createWaitAttempts: 12, creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'bce-v3/', postCreateCopyTexts: ['复制'], postCreateCopyByMaskedKeyPrefix: 'bce-v3/', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['bce-v3/[A-Za-z0-9_./=-]{20,}'], existingMaskedCopyFailureMessage: '百度千帆 Token Plan 已存在专属 API Key，但复制控件没有返回可保存的明文；自动化不会点击重置，请在 Token Plan 页面手动点击复制后重试。', postCreateCopyFailureMessage: '百度千帆 Token Plan 已打开，但没有从专属 API Key 旁的复制按钮读取到明文；自动化不会点击重置，请在 Token Plan 页面手动点击复制后重试。' },
  // BCE AK/SK is likewise an IAM identity credential for finance APIs. Users
  // create a least-privilege IAM credential themselves and save it manually;
  // browser auto-create must never cross the primary-account risk prompt.
  // MiMo serves the public product page and Console from one origin. Going to
  // the homepage first leaves automation at marketing navigation; the real
  // signed-in API key screen is this exact Console route.
  // Verified on the signed-in MiMo Console: "Create API Key" opens a dialog
  // that requires its name input before the English "Confirm" button can run.
  { id: 'xiaomi', label: '小米 MiMo', keyHint: 'XIAOMI_MIMO_API_KEY', groupHint: '小米 MiMo', mode: 'browser', url: 'https://platform.xiaomimimo.com/console/api-keys', preCreateDismissTexts: ['关闭'], createTexts: ['Create API Key', '创建 API Key', '新建 API Key'], deleteTextOnly: true, deleteConfirmInputText: '确认删除', deleteConfirmInputSelector: 'input[placeholder="确认删除"]', nameSelectors: ['input#apiKeyName', 'input[placeholder="Please enter"]', 'input[placeholder*="请输入"]'], confirmTexts: ['Confirm', '确认', '确定'], postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Token Plan keys are managed on MiMo's separate subscription page. The
  // page reveals an existing dedicated key through a verified "复制/Copy"
  // action; automatic checks never create or reset a live subscription key.
  { id: 'xiaomi-coding', label: '小米 MiMo Token Plan', keyHint: 'XIAOMI_MIMO_TOKEN_PLAN_API_KEY', groupHint: '小米 MiMo', mode: 'browser', url: 'https://platform.xiaomimimo.com/console/plan-manage', createTexts: ['创建 API Key', 'Create API Key'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'tp-', missingExistingKeyMessage: '小米 MiMo Token Plan 当前没有可复用的订阅 Key；自动化不会创建或重置新的用户 Key。', existingMaskedCopyFailureMessage: '小米 MiMo Token Plan 已存在 API Key，但复制控件没有返回可保存的明文；为避免重复创建，请在订阅管理页面手动点击复制后重试。An existing Token Plan API Key was found, but its Copy control returned no storable plaintext; to avoid a duplicate, copy it manually on the plan page and retry.', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'tp-', postCreateCopyAttempts: 8, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['tp-[A-Za-z0-9_-]{5,}'], postCreateCopyFailureMessage: '小米 MiMo Token Plan 已有订阅 Key，但没有读取到可保存的明文；自动化不会创建或重置 Key。' },
  // Verified on the signed-in interface-key page: creation requires a name in
  // the current "请输入密钥名称" field (older builds said "最多输入20个字")
  // before the "确认" action becomes enabled.
  { id: 'stepfun', label: '阶跃星辰（StepFun）', keyHint: 'STEPFUN_API_KEY', groupHint: '阶跃星辰', mode: 'browser', url: 'https://platform.stepfun.com/interface-key', createTexts: ['创建新的密钥'], formReadyAttempts: 8, nameMaxLength: 20, nameSelectors: ['input[placeholder="请输入密钥名称"]', 'input[placeholder*="请输入密钥名称"]', 'input[placeholder*="最多输入20"]'], requireNameInput: true, confirmAfterNameInput: true, confirmByExactText: true, confirmTexts: ['确认'], postCreateDomReadAttempts: 8, postCreateReadAttempts: 5, keyPatterns: ['[A-Za-z0-9_-]{32,}'] },
  // The signed-in xAI console redirects / to a team-scoped Dashboard route.
  // Follow the real sidebar link so the opaque team ID is never hard-coded.
  // Its create dialog uses the same "Create API key" label for its final
  // submit button, so this platform explicitly permits that confirmed reuse.
  { id: 'xai', label: 'xAI（Grok）', keyHint: 'XAI_API_KEY', groupHint: 'xAI', mode: 'browser', url: 'https://console.x.ai/', deleteUrl: 'https://console.x.ai/', deletePreNavigationTexts: ['API Keys'], deletePreNavigationUseHref: true, deleteReadyAttempts: 20, preNavigationTexts: ['API Keys'], createTexts: ['Create API key'], deleteMenuTexts: ['Row actions'], deleteTexts: ['Delete key'], deleteConfirmTexts: ['Confirm'], deleteMenuGlobal: true, nameSelectors: ['input[placeholder="Production key"]'], confirmTexts: ['Create API key'], allowConfirmCreateText: true, postCreateReadAttempts: 5, keyPatterns: ['xai-[A-Za-z0-9_-]{20,}'] },
  { id: 'xai-management', label: 'xAI Management Key（用量）', keyHint: 'XAI_MANAGEMENT_KEY', groupHint: 'xAI', mode: 'browser', url: 'https://console.x.ai/team/default/settings/management-keys', rowPermissionDefaults: [{ rowTexts: ['Billing'], optionTexts: ['Read only'] }], deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete key'], deleteConfirmTexts: ['Continue'], deleteDialogText: 'This will delete the management key', createTexts: ['Create management key', 'Create Management Key', 'Create key', 'New management key'], nameSelectors: ['input[placeholder*="name" i]', 'input[placeholder*="Name" i]', 'input[name*="name" i]'], confirmTexts: ['Create management key', 'Create Management Key', 'Create key', 'Create'], allowConfirmCreateText: true, postCreateReadAttempts: 6, keyPatterns: ['xai-[A-Za-z0-9_-]{20,}'] },
  // Mistral currently opens the key form directly from "New key". Older
  // workspaces first showed a profile panel with a "Create new key" action,
  // so that intermediate step remains as an optional compatibility path.
  { id: 'mistral', label: 'Mistral', keyHint: 'MISTRAL_API_KEY', groupHint: 'Mistral', mode: 'browser', url: 'https://console.mistral.ai/api-keys', deleteReadyAttempts: 20, deleteReload: true, deleteButtonIndex: 2, deleteConfirmTexts: ['Delete'], createTexts: ['New key'], formEntryTexts: ['Add a new key', 'Create new key'], formEntryOptional: true, formEntryWaitAttempts: 5, formReadyAttempts: 8, nameSelectors: ['[role="dialog"] input[placeholder="My API Key"]', '[role="dialog"] input[name="name"]', '[role="dialog"] input[placeholder*="name" i]', 'input[placeholder="My API Key"]'], confirmTexts: ['New key'], confirmSelectors: ['button[type="submit"]'], confirmAfterNameInput: true, confirmNeedsForeground: true, captureBeforeConfirm: true, allowConfirmCreateText: true, postCreateKeySelectors: ['[role="dialog"] input', '[role="dialog"] textarea', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]'], postCreateDomReadAttempts: 4, postCreateCopyTexts: ['Copy API key', 'Copy key', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 350, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 3, keyPatterns: ['\\b[A-Za-z0-9_-]{80,120}\\b', '\\b[A-Za-z0-9]{32}\\b'] },
  // /keys is OpenRouter's documented entry point. It redirects signed-in users
  // to their default workspace and signed-out users to the sign-in page.
  // Verified in the workspace keys screen: "New Key" opens a form whose
  // required name is #name and final submit action is "Create".
  { id: 'openrouter', label: 'OpenRouter', keyHint: 'OPENROUTER_API_KEY', groupHint: 'OpenRouter', mode: 'browser', url: 'https://openrouter.ai/keys', deleteReadyAttempts: 20, deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete'], deleteConfirmTexts: ['Delete'], createTexts: ['New Key'], nameSelectors: ['input#name', 'input[placeholder*="Chatbot Key"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, keyPatterns: ['sk-or-v1-[A-Za-z0-9_-]{20,}'] },
  // Account credit totals are exposed only to a Management Key. OpenRouter
  // does not offer a billing-only permission selector for this key type, so
  // the Vault UI must disclose that it has broad key-management capability.
  { id: 'openrouter-management', label: 'OpenRouter Management Key（用量）', keyHint: 'OPENROUTER_MANAGEMENT_KEY', groupHint: 'OpenRouter', mode: 'browser', permissionNote: 'openrouter-management', url: 'https://openrouter.ai/settings/management-keys', deleteReadyAttempts: 20, deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete'], deleteConfirmTexts: ['Delete'], createTexts: ['Create Management Key', 'Create management key', 'New Management Key', 'New management key', 'New Key'], nameSelectors: ['input#name', 'input[placeholder*="name" i]', 'input[name*="name" i]'], confirmTexts: ['Create Management Key', 'Create management key', 'Create'], allowConfirmCreateText: true, postCreateReadAttempts: 6, postCreateCopyTexts: ['Copy Management Key', 'Copy key', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 500, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-or-v1-[A-Za-z0-9_-]{20,}'] },
  // OpenCode Go keys are issued from the signed-in OpenCode workspace after a
  // Go subscription is active. The auth route resolves the current workspace,
  // so no workspace identifier is hard-coded here.
  { id: 'opencode-go', label: 'OpenCode Go', keyHint: 'OPENCODE_API_KEY', groupHint: 'OpenCode Go', mode: 'browser', url: 'https://opencode.ai/auth', deletePreNavigationTexts: ['API 密钥'], deletePreNavigationUseHref: true, deleteReadyAttempts: 20, deleteTexts: ['删除'], deleteNoConfirm: true, deleteNoConfirmDomRetry: true, deleteNoConfirmReload: true, deleteNoConfirmReloadWaitMs: 900, preNavigationTexts: ['API 密钥', 'API Keys'], createTexts: ['创建 API 密钥', 'Create API Key', 'Create API key'], nameSelectors: ['[role="dialog"] input[placeholder*="名称"]', '[role="dialog"] input[placeholder*="name" i]', '[role="dialog"] input[name*="name" i]', 'input[placeholder*="名称"]', 'input[placeholder*="name" i]'], confirmTexts: ['创建 API 密钥', 'Create API Key', 'Create API key', '创建', 'Create'], allowConfirmCreateText: true, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]', '[role="dialog"] input[type="text"]', 'input[value^="sk-"]', 'code'], postCreateCopyTexts: ['复制密钥', '复制', 'Copy API key', 'Copy key', 'Copy'], postCreateCopyAttempts: 10, postCreateCopyRetryMs: 500, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 6, captureBeforeConfirm: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
];

// Provider-side credential limits. These are deliberately metadata and
// warnings, not a local Vault count: users can create/delete keys outside
// OKIT and there is no cross-platform synchronization API. The actual hard
// stop happens when the provider returns a limit error; reuse-only plans are
// blocked from submitting a duplicate create action above.
const AUTO_CREATE_KEY_LIMITS = {
  cloudflare: [{ max: 50, scope: 'user', kind: 'hard' }],
  tencent: [{ max: 50, scope: 'account', kind: 'default' }],
  'tencent-token-plan': [{ max: 1, scope: 'personal', kind: 'hard' }],
  minimax: [{ max: 10, scope: 'account', kind: 'observed' }],
  deepseek: [{ max: 100, scope: 'account', kind: 'hard' }],
  moonshot: [{ max: 50, scope: 'organization', kind: 'default' }],
  'kimi-coding-plan': [{ max: 5, scope: 'coding-plan', kind: 'hard' }],
  qwen: [
    { max: 50, scope: 'region', kind: 'hard' },
    { max: 20, scope: 'us-region', kind: 'hard' },
  ],
  'qwen-coding': [{ max: 1, scope: 'coding-plan', kind: 'hard' }],
  'qwen-token-plan': [{ max: 1, scope: 'seat', kind: 'hard' }],
  qianfan: [{ max: 200, scope: 'account-or-subuser', kind: 'hard' }],
  stepfun: [{ max: 10, scope: 'account', kind: 'hard' }],
};

for (const platform of AUTO_CREATE_PLATFORMS) {
  const keyLimits = AUTO_CREATE_KEY_LIMITS[platform.id];
  if (keyLimits) platform.keyLimits = keyLimits;
}

const AUTO_CREATE_PLATFORM_MAP = new Map(AUTO_CREATE_PLATFORMS.map(platform => [platform.id, platform]));

const SPECIAL_PLATFORM_URLS = {
  zhipu: ZHIPU_URL,
  volcengine: VOLC_URL,
  minimax: MINIMAX_URL,
};

function getBrowserPlatformUrl(platform) {
  return platform.url || SPECIAL_PLATFORM_URLS[platform.id];
}

// OpenRouter has been verified end-to-end. Cloudflare creates tokens directly
// from a user-supplied parent token, so neither belongs in the browser-login
// verification batch.
const BROWSER_LOGIN_VERIFICATION_PLATFORMS = AUTO_CREATE_PLATFORMS
  .filter(platform => platform.mode === 'browser' && platform.id !== 'openrouter')
  .map(platform => ({ id: platform.id, label: platform.label, url: getBrowserPlatformUrl(platform) }))
  .filter(platform => platform.url);

function keyFromText(text, platform) {
  const platformId = typeof platform === 'string' ? platform : platform?.id;
  if (CREDENTIAL_PAIR_PLATFORMS.has(platformId)) {
    return serializeCredentialPair(parseCredentialPairText(text));
  }
  const patterns = platform.keyPatterns || [];
  for (const source of patterns) {
    const match = String(text || '').match(new RegExp(source));
    if (match && !isAssetData(match[0])) return match[0];
  }
  return null;
}

async function clickCreateAction(platform) {
  const createTexts = platform.createTexts || CREATE_ACTION_STRONG_PHRASES;
  const createSelectors = platform.createSelectors || [];
  if (platform.createDirectSelector) {
    const directRaw = await execJs(`(() => {
      const selector = ${JSON.stringify(platform.createDirectSelector)};
      const phrases = ${JSON.stringify(createTexts)};
      const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const target = document.querySelector(selector);
      if (!target) return JSON.stringify({ error: 'not-found' });
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none' || target.disabled) {
        return JSON.stringify({ error: 'not-visible-or-disabled' });
      }
      const label = normalize(target.textContent || '');
      const verifiedText = phrases.some(phrase => {
        const expected = normalize(phrase);
        return expected && (label === expected || label.includes(expected));
      });
      if (!verifiedText) return JSON.stringify({ error: 'text-mismatch', text: (target.textContent || '').trim().slice(0, 120) });
      target.click();
      return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 120), selector });
    })()`).catch(() => '{"error":"direct-click-failed"}');
    let directState = {};
    try { directState = JSON.parse(directRaw || '{}'); } catch { directState = {}; }
    if (directState.ok) return directState;
  }
  // Phase 1: read-only. The browser only describes visible, enabled controls
  // and their stable page index; it never scores or clicks. All matching is
  // decided in Node by resolveActionCandidate against platform.createTexts.
  const collectRaw = await execJs(`(() => {
    const phrases = ${JSON.stringify(createTexts)};
    const selectors = ${JSON.stringify(createSelectors)};
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const visibleEnabled = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visibleEnabled);
    const descriptors = controls.map((el, index) => {
      const label = normalize((el.textContent || '').trim());
      return {
        index,
        text: (el.textContent || '').trim().slice(0, 120),
        ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
        title: (el.title || '').trim().slice(0, 120),
        exactPhraseMatch: Array.isArray(phrases) && phrases.some(phrase => label === normalize(phrase)),
        selectorMatch: Array.isArray(selectors) && selectors.some(selector => {
          try { return el.matches(selector); } catch { return false; }
        }),
      };
    });
    return JSON.stringify({
      descriptors,
      buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).slice(0, 12),
      workspaceKeys: /\\/workspaces\\/[^/]+\\/keys(?:[/?#]|$)/.test(location.pathname),
      keyInterface: /API Keys|Create (?:API )?Key|Key Management/i.test((document.body?.innerText || '').slice(0, 16000)),
    });
  })()`);
  let collect = {};
  try { collect = JSON.parse(collectRaw || '{}'); } catch { collect = {}; }

  const descriptors = Array.isArray(collect.descriptors) ? collect.descriptors : [];
  const options = { phrases: createTexts };
  const selected = resolveActionCandidate(descriptors, options);
  if (!selected) {
    const scored = descriptors
      .map(c => ({ text: (c.text || '').slice(0, 40), score: scoreActionCandidate(c, options) }))
      .filter(entry => entry.score >= CREATE_ACTION_SCORE_THRESHOLD);
    return {
      error: scored.length === 0 ? 'create-not-found' : 'create-ambiguous',
      buttons: collect.buttons || [],
      workspaceKeys: collect.workspaceKeys,
      keyInterface: collect.keyInterface,
      scores: scored,
    };
  }

  // Phase 2: re-collect and click the SAME index only after the live element's
  // normalized text/aria/title fingerprint still matches the descriptor that
  // Node approved. Anything moved between the two passes aborts the click.
  const fingerprint = descriptorFingerprint(selected);
  const clickRaw = await execJs(`(() => {
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const slice = value => String(value == null ? '' : value).trim().slice(0, 120);
    const visibleEnabled = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const targetIndex = ${selected.index};
    const expected = ${JSON.stringify(fingerprint)};
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visibleEnabled);
    const target = controls[targetIndex];
    if (!target) return JSON.stringify({ error: 'create-mismatch', reason: 'index-gone' });
    const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
      .map(normalize).join('|');
    if (actual !== expected) return JSON.stringify({ error: 'create-mismatch', reason: 'fingerprint-changed' });
    target.click();
    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60) });
  })()`);
  let clickState = {};
  try { clickState = JSON.parse(clickRaw || '{}'); } catch { clickState = {}; }
  if (!clickState.ok) {
    return { error: 'create-mismatch', buttons: collect.buttons || [], workspaceKeys: collect.workspaceKeys, keyInterface: collect.keyInterface };
  }
  return { ok: true, text: clickState.text };
}

async function createGenericBrowserKey({ tokenName, platform, run }) {
  if (!platform.url) throw new Error('该平台还没有可自动创建密钥的控制台地址');

  const uniqueSuffix = Date.now().toString(36).slice(-6);
  const rawUniqueName = `${tokenName}-${uniqueSuffix}`;
  const maxNameLength = Number(platform.nameMaxLength) || 0;
  const uniqueName = maxNameLength > 0 && rawUniqueName.length > maxNameLength
    ? `${String(tokenName).slice(0, Math.max(1, maxNameLength - uniqueSuffix.length - 1))}-${uniqueSuffix}`.slice(0, maxNameLength)
    : rawUniqueName;
  const nav = await sendCommand('navigate', { url: platform.url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开密钥管理页失败');
  const tabId = nav.data && nav.data.tabId;
  const arrivedUrl = nav.data && nav.data.url;
  if (isLoginUrl(arrivedUrl)) {
    throw new Error(`Login required at ${arrivedUrl}`);
  }

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || '无法开始安全抓取');

  await sleep(3000);
  // A previous attempt may have successfully created the key but failed local
  // format validation. Recover only an OKIT-named key from this provider's
  // credential-list response before considering another create action.
  if (platform.recoverExistingNamedKey || platform.blockWhenExistingKeys) {
    const recoveryRead = await sendCommand('network-capture-read', {
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 10000).catch(() => ({ ok: false, data: [] }));
    const capturedEntries = recoveryRead.ok ? (recoveryRead.data || []) : [];
    const recovered = platform.recoverExistingNamedKey
      ? extractNewestNamedKeyFromCaptures(recoveryRead.data || [], tokenName, platform)
      : null;
    if (recovered) {
      await closeAutomationWindow();
      return { value: recovered.key, name: recovered.name };
    }
    if (platform.blockWhenExistingKeys && capturesContainMistralKeyRecords(capturedEntries)) {
      throw new Error('Mistral 当前已有 Active API Key，控制台不会再次显示其明文。请使用已保存的 Key，或先在 Mistral 撤销旧 Key 后再自动创建。');
    }
  }
  // A few providers expose their console from a public product page. Follow
  // only the explicitly configured, non-destructive console action first.
  if (platform.preNavigationTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.preNavigationTexts)};
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled;
      });
      const target = candidates.find(el => texts.some(text => (el.textContent || '').trim().toLowerCase() === text.toLowerCase()));
      if (target) { target.click(); return 'clicked'; }
      return 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(2500);
  }
  // Some providers display a non-blocking profile reminder over their API-key
  // list. Dismiss only the provider's verified opt-out action; this never
  // accepts terms, billing, or permission changes on the user's behalf.
  if (platform.preCreateDismissTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.preCreateDismissTexts)};
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const target = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => texts.includes((el.textContent || '').trim()));
      if (target) target.click();
      return target ? 'dismissed' : 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(350);
  }
  if (await detectInteractiveVerification(platform)) {
    await waitForInteractiveVerification({ run, platform, stage: 'before-create' });
  }
  if (platform.id === 'openrouter') {
    await handoffOpenRouterLoginIfNeeded();
  }
  // Dismiss only generic promotional/cookie overlays before looking for the
  // create action. The actual creation dialog is never dismissed here.
  await execJs(`(() => {
    const closers = [...document.querySelectorAll('button, [role="button"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /^(关闭|取消|我知道了|Close|Dismiss|Got it)$/i.test((el.textContent || '').trim());
    });
    closers.slice(0, 2).forEach(el => el.click());
  })()`).catch(() => {});

  // MiMo Token Plan shows only Copy and Reset once a key already exists. In
  // that state there is deliberately no Create API Key button. Reuse the
  // existing key by clicking only the row's classified Copy icon; never click
  // Reset and never create a duplicate credential.
  if (platform.reuseExistingMaskedKey) {
    const existingRaw = await execJs(`(() => {
      const prefix = ${JSON.stringify(platform.existingMaskedKeyPrefix || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      const keyNode = [...document.querySelectorAll('input, textarea, p, span, div')]
        .filter(visible)
        .map(el => ({ el, text: String(el.value || el.textContent || '').trim() }))
        .filter(item => item.text.startsWith(prefix) && /(\\*{3,}|\.{3,}|…)/.test(item.text.slice(prefix.length)))
        .sort((a, b) => a.text.length - b.text.length)[0]?.el;
      const classifyIcon = ${XIAOMI_ICON_CLASSIFY_JS};
      let row = keyNode;
      for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
        const buttons = [...row.querySelectorAll('button, a, [role="button"]')].filter(visible);
        if (!buttons.length) continue;
        const copyTexts = ${JSON.stringify(platform.postCreateCopyTexts || [])};
        const copyButtons = buttons.filter(btn => {
          const label = [btn.textContent, btn.getAttribute('aria-label'), btn.getAttribute('title')]
            .filter(Boolean).join(' ').trim().toLowerCase();
          const textCopy = copyTexts.some(text => {
            const normalized = String(text).toLowerCase();
            return label === normalized || label.includes(normalized);
          });
          return textCopy || classifyIcon(btn) === 'copy';
        });
        // Only a single verified Copy action is safe to invoke. Zero or more
        // than one means the row is ambiguous — never click anything. Text
        // labels support providers such as Qianfan; icon-only controls still
        // use the existing MiMo classifier.
        if (copyButtons.length === 1) {
          const rect = copyButtons[0].getBoundingClientRect();
          return JSON.stringify({ found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, buttonCount: buttons.length });
        }
        if (copyButtons.length > 1) break;
      }
      return JSON.stringify({ found: false });
    })()`).catch(() => '{"found":false}');
    let existingState = {};
    try { existingState = JSON.parse(existingRaw || '{}'); } catch {}
    if (existingState.found) {
      // Install the same page-scoped Copy capture used after creation before
      // invoking an existing-key row. Some consoles (including Tencent) put
      // the one-time value into navigator.clipboard without exposing it in
      // the DOM or network response.
      await execJs(`(() => {
        window.__okitExistingCapturedKey = '';
        const capture = value => {
          const text = String(value || '');
          if (text) window.__okitExistingCapturedKey = text;
        };
        try {
          const clipboard = navigator.clipboard;
          const originalWriteText = clipboard?.writeText?.bind(clipboard);
          if (originalWriteText) {
            const wrappedWriteText = text => { capture(text); return originalWriteText(text); };
            try { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
            try { Object.defineProperty(Object.getPrototypeOf(clipboard), 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
        } catch {}
        try {
          const originalExecCommand = document.execCommand.bind(document);
          document.execCommand = command => {
            if (String(command).toLowerCase() === 'copy') {
              const selected = window.getSelection()?.toString() || '';
              const active = document.activeElement;
              capture(selected || (typeof active?.value === 'string' ? active.value : ''));
            }
            return originalExecCommand(command);
          };
        } catch {}
        document.addEventListener('copy', event => {
          capture(event.clipboardData?.getData('text/plain') || window.getSelection()?.toString() || '');
        }, true);
        return 'capture-ready';
      })()`).catch(() => {});
      const clicked = await foregroundClick({ x: existingState.x, y: existingState.y, tabId });
      if (!clicked) throw new Error(platform.existingMaskedCopyFailureMessage || '已有 API Key 的复制控件无法点击');
      await sleep(500);
      const capturedExisting = await execJs('window.__okitExistingCapturedKey || ""').catch(() => '');
      const capturedExistingKey = keyFromText(capturedExisting, platform);
      if (capturedExistingKey) {
        await closeAutomationWindow();
        return { value: capturedExistingKey, name: tokenName };
      }
      if (platform.allowExtensionClipboardRead) {
        const clipboardRead = await sendCommand('clipboard-read', {
          workspace: 'okit',
          clipboardPattern: platform.keyPatterns?.[0] || '',
        }, 5000).catch(() => ({ ok: false, data: {} }));
        const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
        const clipboardKey = keyFromText(clipboardValue, platform);
        if (clipboardKey) {
          await closeAutomationWindow();
          return { value: clipboardKey, name: tokenName };
        }
      }
      const existingNetwork = await sendCommand('network-capture-read', {
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 10000).catch(() => ({ ok: false, data: [] }));
      const existingEntries = existingNetwork.ok ? (existingNetwork.data || []) : [];
      const existingKey = keyFromText(extractKeyFromCaptures(existingEntries, platform.id), platform);
      if (existingKey) {
        await closeAutomationWindow();
        return { value: existingKey, name: tokenName };
      }
      throw new Error(platform.existingMaskedCopyFailureMessage || '已有 API Key，但复制控件没有返回可保存的明文');
    }
    if (platform.existingKeyRequired) {
      const loginState = await detectLoginRequired(platform);
      if (loginState.loginRequired) {
        throw new Error(`需要登录 ${platform.label || platform.id}`);
      }
      throw new Error(platform.missingExistingKeyMessage || '当前页面没有可复制的 API Key');
    }
  }

  let createState = await clickCreateAction(platform);
  if (await detectInteractiveVerification(platform)) {
    await waitForInteractiveVerification({ run, platform, stage: 'create-action' });
  }
  // The Kimi console first renders its organization/navigation shell and only
  // adds the API key action after asynchronous data finishes loading. Poll the
  // proven action rather than guessing from the shell's early buttons.
  const createAttempts = Math.max(1, Number(platform.createWaitAttempts) || 1);
  for (let attempt = 1; createState.error === 'create-not-found' && attempt < createAttempts; attempt += 1) {
    await sleep(1000);
    createState = await clickCreateAction(platform);
  }
  // The public OpenRouter shell can arrive after the earlier page-state probe.
  // These labels are the final button search's reliable, live signal.
  if (platform.id === 'openrouter'
    && createState.error
    && hasOpenRouterPublicNavigation(createState.buttons || [])
    && !createState.workspaceKeys
    && !createState.keyInterface) {
    await redirectOpenRouterToLogin();
    throw new Error('OpenRouter login required');
  }
  if (createState.error) {
    const actionLabel = platform.creationActionOnly ? '密钥操作按钮' : '创建密钥按钮';
    throw new Error(`未找到${actionLabel}：${(createState.buttons || []).join('、') || '请确认已登录并拥有操作权限'}`);
  }

  // Tencent Cloud shows a provider-owned warning before the actual SecretId /
  // SecretKey form. The acknowledgement is safe to automate only when the
  // exact warning, one checkbox, and one configured continuation action are
  // all present. This does not accept billing, terms, or permission changes.
  if (platform.preCreateAcknowledge) {
    const acknowledge = platform.preCreateAcknowledge;
    let acknowledged = false;
    let lastAcknowledgeState = {};
    const attempts = Math.max(1, Number(acknowledge.attempts) || 10);
    for (let attempt = 0; attempt < attempts && !acknowledged; attempt += 1) {
      const raw = await execJs(`(() => {
        const config = ${JSON.stringify(acknowledge)};
        const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
        };
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
          .filter(visible)
          .filter(dialog => {
            const text = normalize(dialog.innerText || '');
            return (config.dialogTexts || []).some(expected => text.includes(normalize(expected)));
          })
          .filter(dialog => [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].some(visible))
          .filter(dialog => [...dialog.querySelectorAll('button, [role="button"]')].some(button => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            if (!(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden')) return false;
            const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
            return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
          }));
        if (!dialogs.length) return JSON.stringify({ ok: false, reason: 'dialog', count: 0 });
        const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        const checkboxes = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible);
        const checkbox = checkboxes.find(candidate => {
          const label = normalize([candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.closest('label')?.innerText, candidate.parentElement?.innerText].filter(Boolean).join(' '));
          return (config.checkboxTexts || []).some(expected => label.includes(normalize(expected)));
        });
        if (!checkbox || checkboxes.length !== 1) return JSON.stringify({ ok: false, reason: 'checkbox', count: checkboxes.length });
        const checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
        if (!checked) {
          const rect = checkbox.getBoundingClientRect();
          return JSON.stringify({ ok: false, reason: 'checked', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }
        const continueTexts = (config.continueTexts || []).map(normalize);
        const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => {
          const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
          return continueTexts.some(expected => label === expected || label.startsWith(expected));
        });
        if (buttons.length !== 1) return JSON.stringify({ ok: false, reason: 'continue', count: buttons.length });
        const rect = buttons[0].getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      })()`).catch(() => '{"ok":false}');
      let state = {};
      try { state = JSON.parse(raw || '{}'); } catch {}
      lastAcknowledgeState = state;
      if (state.ok) {
        const domClicked = await execJs(`(() => {
            const config = ${JSON.stringify(acknowledge)};
            const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
            const visible = el => {
              const rect = el?.getBoundingClientRect?.();
              const style = el ? getComputedStyle(el) : null;
              return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
            };
            const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
              .filter(visible)
              .filter(dialog => (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))));
            if (!dialogs.length) return false;
            const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
            const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => {
              const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
              return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
            });
            if (buttons.length !== 1) return false;
            buttons[0].click();
            return true;
          })()`).catch(() => false);
        const clicked = domClicked === true || domClicked === 'true'
          || await foregroundClick({ x: state.x, y: state.y, tabId });
        if (!clicked) throw new Error(`${platform.label || platform.id} 主账号密钥风险确认按钮无法点击，未创建或保存密钥`);
        await sleep(450);
        const pendingWarning = await execJs(`(() => {
          const config = ${JSON.stringify(acknowledge)};
          const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const visible = el => {
            const rect = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
          };
          return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .some(dialog => visible(dialog) && (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))));
        })()`).catch(() => false);
        acknowledged = pendingWarning !== true && pendingWarning !== 'true';
      } else if (state.reason === 'checked' && Number.isFinite(state.x) && Number.isFinite(state.y)) {
        const domChecked = await execJs(`(() => {
          const config = ${JSON.stringify(acknowledge)};
          const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const visible = el => {
            const rect = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
          };
          const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .filter(visible)
            .filter(dialog => (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))))
            .filter(dialog => [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].some(visible))
            .filter(dialog => [...dialog.querySelectorAll('button, [role="button"]')].some(button => {
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              if (!(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden')) return false;
              const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
              return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
            }));
          if (!dialogs.length) return false;
          const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
          const checkboxes = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible);
          const checkbox = checkboxes.find(candidate => {
            const label = normalize([candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.closest('label')?.innerText, candidate.parentElement?.innerText].filter(Boolean).join(' '));
            return (config.checkboxTexts || []).some(expected => label.includes(normalize(expected)));
          });
          if (!checkbox || checkboxes.length !== 1) return false;
          checkbox.click();
          let checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
          if (!checked) {
            const label = checkbox.closest('label') || checkbox.parentElement;
            if (label) label.click();
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
          }
          return checked;
        })()`).catch(() => false);
        if (domChecked !== true && domChecked !== 'true') {
          const clicked = await foregroundClick({ x: state.x, y: state.y, tabId });
          if (!clicked) throw new Error(`${platform.label || platform.id} 主账号密钥风险复选框无法点击，未创建或保存密钥`);
        }
        await sleep(300);
      } else if (attempt + 1 < attempts) {
        await sleep(400);
      }
    }
    if (!acknowledged) throw new Error(`${platform.label || platform.id} 主账号密钥风险确认未完成，未创建或保存密钥（${lastAcknowledgeState.reason || 'unknown'}${Number.isFinite(lastAcknowledgeState.count) ? `:${lastAcknowledgeState.count}` : ''}）`);
    await sleep(700);
  }

  // Mistral's workspace action first opens the user's key-management panel;
  // enter its real form through the panel's visible "Create new key" action.
  if (platform.formEntryTexts?.length) {
    let formEntryState = { error: 'form-entry-not-found', buttons: [] };
    const formEntryAttempts = Math.max(1, Number(platform.formEntryWaitAttempts) || 5);
    for (let attempt = 0; attempt < formEntryAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 500 : 500);
      const raw = await execJs(`(() => {
        const texts = ${JSON.stringify(platform.formEntryTexts)};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
        };
        const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
        const target = candidates.find(el => texts.some(text => (el.textContent || '').trim().toLowerCase() === text.toLowerCase()));
        if (!target) return JSON.stringify({ error: 'form-entry-not-found', buttons: candidates.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16) });
        target.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{}');
      try { formEntryState = JSON.parse(raw || '{}'); } catch { formEntryState = {}; }
      if (!formEntryState.error) break;
    }
    if (formEntryState.error && !platform.formEntryOptional) {
      throw new Error(`未找到创建密钥表单入口：${(formEntryState.buttons || []).join('、') || platform.formEntryTexts.join('、')}`);
    }
    await sleep(350);
  }

  // Several consoles keep the list page mounted while an asynchronous route
  // transition loads the actual creation form. In that interval the page can
  // still contain unrelated buttons (for example the BCE AI assistant's
  // recommendations). Poll only for the configured form input or confirmation
  // action so those unrelated buttons can never be reported as the form.
  const formReadyAttempts = Math.max(1, Number(platform.formReadyAttempts) || 1);
  const formReadyDelayMs = Math.max(150, Number(platform.formReadyDelayMs) || 500);
  let formReadyState = { ready: formReadyAttempts === 1, nameInput: false, confirmButton: false, buttons: [] };
  for (let attempt = 0; attempt < formReadyAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 1200 : formReadyDelayMs);
    const readyRaw = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.nameSelectors || [])};
      const confirmTexts = ${JSON.stringify(platform.confirmTexts || [])};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      const scopes = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]'), document];
      const nameInput = selectors.length > 0 && scopes.some(scope => selectors.some(selector => {
        const input = scope.querySelector(selector);
        return Boolean(input && visible(input));
      }));
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      const confirmButton = buttons.some(button => {
        const label = (button.textContent || '').trim().replace(/\\s+/g, '').toLowerCase();
        return confirmTexts.some(text => {
          const expected = String(text).replace(/\\s+/g, '').toLowerCase();
          return label === expected || label.startsWith(expected);
        });
      });
      return JSON.stringify({ ready: Boolean(nameInput || confirmButton), nameInput, confirmButton, buttons: buttons.map(button => (button.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16) });
    })()`).catch(() => '{}');
    try { formReadyState = JSON.parse(readyRaw || '{}'); } catch { formReadyState = {}; }
    if (formReadyState.ready) break;
  }
  if (formReadyAttempts > 1 && !formReadyState.ready) {
    throw new Error(`创建密钥表单加载超时：${(formReadyState.buttons || []).join('、') || '请确认已登录并拥有创建权限'}`);
  }
  // A name is optional across platforms. Populate it when the create dialog
  // exposes a conventional input; platforms that create unnamed keys continue.
  const nameFillResult = await execJs(`(() => {
    const selectors = ${JSON.stringify(platform.nameSelectors || [
      'input[placeholder*="名称"]',
      'input[placeholder*="Name"]',
      'input[placeholder*="描述"]',
      'input[name*="name" i]',
      'input[id*="name" i]',
    ])};
    const scopes = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]'), document];
    for (const scope of scopes) {
      let input = selectors.map(selector => scope.querySelector(selector)).find(Boolean);
      if (!input && ${Boolean(platform.allowDialogTextInputFallback)}) {
        input = [...scope.querySelectorAll('input, textarea')].find(candidate => {
          const type = (candidate.getAttribute('type') || 'text').toLowerCase();
          const role = (candidate.getAttribute('role') || '').toLowerCase();
          const rect = candidate.getBoundingClientRect();
          return !candidate.disabled && !candidate.readOnly && role !== 'combobox'
            && ['text', ''].includes(type) && rect.width > 0 && rect.height > 0;
        });
      }
      if (!input || input.disabled || input.getBoundingClientRect().width === 0) continue;
      const prototype = input instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(uniqueName)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(uniqueName)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return JSON.stringify({ filled: input.value === ${JSON.stringify(uniqueName)} });
    }
    return JSON.stringify({ filled: false, error: 'no-name-input' });
  })()`).catch(() => '{"filled":false,"error":"fill-failed"}');
  let nameFillState = {};
  try { nameFillState = JSON.parse(nameFillResult || '{}'); } catch {}
  if (platform.nameFillViaInput) {
    const focusName = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.nameSelectors || [])};
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled; };
      const input = selectors.map(selector => document.querySelector(selector)).find(visible);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      if (setter) setter.call(input, ''); else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.select?.();
      return true;
    })()`).catch(() => false);
    if (focusName !== true && focusName !== 'true') throw new Error(`${platform.label || platform.id} 名称输入框无法聚焦`);
    const inserted = await sendCommand('insert-text', { text: uniqueName, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => ({ ok: false }));
    if (!inserted.ok) throw new Error(`${platform.label || platform.id} 名称无法通过真实输入提交`);
    await sleep(250);
  }
  if (platform.requireNameInput && !nameFillState.filled) {
    throw new Error(`${platform.label || platform.id} 创建框的密钥名称输入框未识别，尚未提交创建`);
  }

  // Do not misreport a disabled platform prerequisite as a failed click or a
  // possibly-created key. These are explicitly verified, non-secret messages
  // rendered inside the provider's own create form.
  if (platform.formBlockers?.length) {
    const formBlocker = await execJs(`(() => {
      const visibleText = document.body?.innerText || '';
      const blockers = ${JSON.stringify(platform.formBlockers)};
      return JSON.stringify(blockers.find(blocker => visibleText.includes(blocker.text)) || null);
    })()`).catch(() => 'null');
    let blocker;
    try { blocker = JSON.parse(formBlocker || 'null'); } catch {}
    if (blocker?.message) throw new Error(blocker.message);
  }

  // Anthropic 及类似平台有一个 expiration 下拉框需要选一个值才能确认。
  // 选第一个选项(通常是 "No expiration" 或 "1 year")。
  if (platform.preConfirmSelectDefaults?.length) {
    for (const selectConfig of platform.preConfirmSelectDefaults) {
      const openSelectResult = await execJs(`(() => {
        const triggerTexts = ${JSON.stringify(selectConfig.triggerTexts || [selectConfig.triggerText || ''])}.filter(Boolean);
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // Find the currently selected expiration trigger. Anthropic's current
        // Console renders the default preset itself (for example "3 hours")
        // instead of the former "Select an expiration" placeholder.
        const triggers = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]')]
          .filter(visible).concat([document]);
        let trigger = null;
        for (const scope of triggers) {
          const candidates = [...scope.querySelectorAll('button, [role="combobox"], [role="button"], select')]
            .filter(visible)
            .filter(el => triggerTexts.some(text => (el.textContent || '').includes(text) || el.getAttribute('aria-label')?.includes(text)));
          if (candidates.length) { trigger = candidates[0]; break; }
        }
        if (!trigger) return JSON.stringify({ error: 'select-trigger-not-found', triggerTexts });
        // 打开下拉
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"select-open-failed"}');
      let openSelectState = {};
      try { openSelectState = JSON.parse(openSelectResult || '{}'); } catch {}
      if (openSelectState.error && !selectConfig.optional) {
        throw new Error('未找到密钥过期时间选择框');
      }
      if (openSelectState.error) continue;
      await sleep(400);
      const chooseOptionResult = await execJs(`(() => {
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const optionTexts = ${JSON.stringify(selectConfig.optionTexts || [selectConfig.optionText || ''])}.filter(Boolean);
        let option = null;
        if (optionTexts.length) {
          option = [...document.querySelectorAll('[role="option"], li[role="option"], [role="menuitem"]')]
            .filter(visible)
            .find(el => optionTexts.some(text => (el.textContent || '').trim().toLowerCase().includes(text.toLowerCase())));
        }
        if (!option && !optionTexts.length) {
          option = [...document.querySelectorAll('[role="option"], li[role="option"], [role="menuitem"]')]
            .filter(visible)[0];
        }
        if (!option) return JSON.stringify({ error: 'option-not-found' });
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        option.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"option-select-failed"}');
      let chooseOptionState = {};
      try { chooseOptionState = JSON.parse(chooseOptionResult || '{}'); } catch {}
      if (chooseOptionState.error && !selectConfig.optional) {
        throw new Error('未找到期望的密钥过期时间选项');
      }
      await sleep(300);
    }
  }

  // xAI management keys expose one combobox per named endpoint. Select only
  // the configured endpoint and access level; a document-wide "No access"
  // click could silently grant the wrong scope.
  if (platform.rowPermissionDefaults?.length) {
    for (const permission of platform.rowPermissionDefaults) {
      const openPermission = await execJs(`(() => {
        const rowTexts = ${JSON.stringify(permission.rowTexts || [])};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const rows = [...document.querySelectorAll('[role="row"], tr')].filter(row => visible(row) && rowTexts.some(text => (row.innerText || '').includes(text)));
        if (rows.length !== 1) return JSON.stringify({ error: 'permission-row-not-found', rows: rows.length });
        const controls = [...rows[0].querySelectorAll('[role="combobox"], button')].filter(visible);
        const trigger = controls.find(control => control.matches('[role="combobox"]')) || controls[0];
        if (!trigger) return JSON.stringify({ error: 'permission-trigger-not-found' });
        trigger.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"permission-open-failed"}');
      let openPermissionState = {};
      try { openPermissionState = JSON.parse(openPermission || '{}'); } catch {}
      if (openPermissionState.error) throw new Error(`未找到 xAI ${permission.rowTexts?.join('、') || '权限'} 选择框`);
      await sleep(300);
      const choosePermission = await execJs(`(() => {
        const options = ${JSON.stringify(permission.optionTexts || [])};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const candidates = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, [data-radix-collection-item]')]
          .filter(visible)
          .filter(el => options.some(text => (el.innerText || '').trim().toLowerCase().includes(String(text).toLowerCase())));
        if (candidates.length !== 1) return JSON.stringify({ error: 'permission-option-not-found', candidates: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"permission-select-failed"}');
      let choosePermissionState = {};
      try { choosePermissionState = JSON.parse(choosePermission || '{}'); } catch {}
      if (choosePermissionState.error) throw new Error(`未找到 xAI ${permission.optionTexts?.join('、') || '权限级别'} 选项`);
      await sleep(300);
    }
  }

  // Kimi's form requires an explicit project. Choosing a different project
  // would change the scope of the created credential, so only the provider's
  // visible `default` project is eligible for automatic selection.
  if (platform.defaultProjectLabel) {
    const openProject = await execJs(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .find(el => el.getBoundingClientRect().width > 0) || document;
      const input = dialog.querySelector('input[role="combobox"]');
      if (!input) return JSON.stringify({ error: 'project-select-not-found' });
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.click();
      return JSON.stringify({ ok: true });
    })()`);
    let projectOpenState = {};
    try { projectOpenState = JSON.parse(openProject || '{}'); } catch {}
    if (projectOpenState.error) throw new Error('未找到 Kimi 项目选择框');

    await sleep(300);
    const selectProject = await execJs(`(() => {
      const label = ${JSON.stringify(platform.defaultProjectLabel)}.toLowerCase();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const options = [...document.querySelectorAll('[role="option"], .ant-select-item-option')]
        .filter(visible);
      const option = options.find(el => {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return text === label || text.startsWith(label + ' ');
      });
      if (!option) return JSON.stringify({ error: 'default-project-not-found', options: options.map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60)) });
      const rect = option.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`);
    let projectSelectState = {};
    try { projectSelectState = JSON.parse(selectProject || '{}'); } catch {}
    if (projectSelectState.error) {
      throw new Error(`未找到 Kimi 默认项目：${(projectSelectState.options || []).join('、') || platform.defaultProjectLabel}`);
    }
    // React's Ant Design select ignores synthetic element.click() in this
    // console. Dispatch a real CDP mouse gesture at the verified option.
    if (!Number.isFinite(projectSelectState.x) || !Number.isFinite(projectSelectState.y)) {
      throw new Error('无法定位 Kimi 默认项目的位置');
    }
    const projectMouseParams = {
      x: projectSelectState.x,
      y: projectSelectState.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    };
    const projectClicked = await foregroundClick({
      x: projectMouseParams.x,
      y: projectMouseParams.y,
      tabId,
    });
    if (!projectClicked) {
      throw new Error('无法选择 Kimi 默认项目');
    }
    await sleep(300);
    const projectAlreadyConfirmed = await execJs(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
        || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
      const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
        .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
      return Boolean(button && !button.disabled);
    })()`).catch(() => false);
    if (projectAlreadyConfirmed === true || projectAlreadyConfirmed === 'true') {
      await sleep(150);
    } else {
    // The option list can remain visually open after the mouse gesture, or
    // close without updating the controlled value. Re-focus the same
    // combobox, verify that it still exposes exactly the configured `default`
    // option, then commit it with real keyboard events and verify that the
    // provider enabled the final OK button.
    const focusProjectRaw = await execJs(`(() => {
      const input = document.querySelector('input[role="combobox"]');
      if (!input) return JSON.stringify({ ok: false });
      input.focus();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const listOpen = [...document.querySelectorAll('[role="listbox"]')].some(visible);
      const rect = input.getBoundingClientRect();
      return JSON.stringify({ ok: true, listOpen, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let focusProject = {};
    try { focusProject = JSON.parse(focusProjectRaw || '{}'); } catch {}
    if (!focusProject.ok) throw new Error('无法重新聚焦 Kimi 默认项目选择框');
    if (!focusProject.listOpen && Number.isFinite(focusProject.x) && Number.isFinite(focusProject.y)) {
      const projectOpenMouse = { x: focusProject.x, y: focusProject.y, button: 'left', buttons: 1, clickCount: 1 };
      const openPressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...projectOpenMouse, type: 'mousePressed' },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000);
      const openReleased = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...projectOpenMouse, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000);
      if (!openPressed.ok || !openReleased.ok) throw new Error('无法打开 Kimi 默认项目选择框');
    }
    await sleep(700);
    let projectOptionCount = 0;
    let projectOptionCoords = null;
    for (let optionAttempt = 0; optionAttempt < 2 && projectOptionCount !== 1; optionAttempt += 1) {
      const projectOptionRaw = await execJs(`(() => {
      const label = ${JSON.stringify(platform.defaultProjectLabel)}.toLowerCase();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const matches = [...document.querySelectorAll('[role="option"], .ant-select-item-option')]
        .filter(visible)
        .filter(el => {
          const text = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
          return text === label || text.startsWith(label + ' ');
        });
      if (matches.length !== 1) return JSON.stringify({ count: matches.length });
      const rect = matches[0].getBoundingClientRect();
      return JSON.stringify({ count: 1, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      })()`).catch(() => '{"count":0}');
      let projectOptionState = {};
      try { projectOptionState = JSON.parse(projectOptionRaw || '{}'); } catch {}
      projectOptionCount = Number(projectOptionState.count) || 0;
      projectOptionCoords = Number.isFinite(projectOptionState.x) && Number.isFinite(projectOptionState.y)
        ? { x: projectOptionState.x, y: projectOptionState.y }
        : null;
      if (projectOptionCount === 1) break;
      if (Number.isFinite(focusProject.x) && Number.isFinite(focusProject.y)) {
        const retryOpenMouse = { x: focusProject.x, y: focusProject.y, button: 'left', buttons: 1, clickCount: 1 };
        await sendCommand('cdp', {
          cdpMethod: 'Input.dispatchMouseEvent',
          cdpParams: { ...retryOpenMouse, type: 'mousePressed' },
          workspace: 'okit',
          ...(tabId ? { tabId } : {}),
        }, 5000);
        await sendCommand('cdp', {
          cdpMethod: 'Input.dispatchMouseEvent',
          cdpParams: { ...retryOpenMouse, type: 'mouseReleased', buttons: 0 },
          workspace: 'okit',
          ...(tabId ? { tabId } : {}),
        }, 5000);
        await sleep(700);
      }
    }
    // The earlier live scan already verified exactly one `default` option. A
    // provider rerender may unmount that option after the mouse gesture; in
    // that case still use the focused keyboard commit and rely on the final
    // enabled-OK check below. Abort only if a second project becomes visible.
    if (Number(projectOptionCount) > 1) throw new Error(`Kimi 默认项目选择项发生变化（找到 ${Number(projectOptionCount)} 个），未创建 API Key`);
    let projectCommittedByMouse = false;
    if (projectOptionCoords) {
      projectCommittedByMouse = await foregroundClick({ ...projectOptionCoords, tabId });
      if (projectCommittedByMouse) {
        await sleep(350);
        projectCommittedByMouse = await execJs(`(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
            || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
          const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
            .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
          return Boolean(button && !button.disabled);
        })()`).catch(() => false);
      }
    }
    if (!projectCommittedByMouse) {
    await sendCommand('focus-window', { workspace: 'okit' }, 5000).catch(() => ({ ok: false }));
    await sleep(150);
    const keyParams = { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
    const keyDown = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: keyParams,
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const keyUp = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: { ...keyParams, type: 'keyUp' },
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    const enterDown = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: enterParams,
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const enterUp = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: { ...enterParams, type: 'keyUp' },
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    if (!keyDown.ok || !keyUp.ok || !enterDown.ok || !enterUp.ok) {
      throw new Error('无法提交 Kimi 默认项目选择');
    }
    await sleep(300);
    const projectConfirmed = await execJs(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
        || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
      const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
        .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
      return Boolean(button && !button.disabled);
    })()`).catch(() => false);
    if (projectConfirmed !== true && projectConfirmed !== 'true') {
      const projectDebug = await execJs(`(() => JSON.stringify({
        comboboxes: [...document.querySelectorAll('input[role="combobox"]')].map(input => ({
          value: input.value || '',
          ariaExpanded: input.getAttribute('aria-expanded') || '',
          selected: input.parentElement?.parentElement?.innerText || '',
        })).slice(0, 3),
        selectedItems: [...document.querySelectorAll('.ant-select-selection-item, [class*="select-selection-item"]')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => (el.textContent || '').trim()).slice(0, 6),
        okButtons: [...document.querySelectorAll('button, [role="button"]')]
          .filter(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase())
          .map(el => ({ disabled: Boolean(el.disabled), ariaDisabled: el.getAttribute('aria-disabled') || '', className: el.className || '' })),
      }))()`).catch(() => '{}');
      console.log(`[auto-create] moonshot: project commit diagnostics ${JSON.stringify({ projectConfirmed, projectDebug })}`);
      throw new Error(`Kimi 默认项目未提交，未创建 API Key（诊断 ${projectDebug}）`);
    }
    }
    }
  }

  // Some management-key consoles expose a permission-policy selector during
  // AccessKey creation. When a platform explicitly requests a preset, select
  // it before the final confirmation and fail closed if the selector or policy
  // cannot be located. This is intentionally opt-in; ordinary API keys never
  // receive guessed permissions.
  if (platform.permissionDefaults) {
    const permissionConfig = platform.permissionDefaults;
    const permissionOpenRaw = await execJs(`(() => {
      const triggerTexts = ${JSON.stringify(permissionConfig.triggerTexts || [])};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const controls = [...document.querySelectorAll('button, [role="button"], [role="combobox"], input')].filter(visible);
      const target = controls.find(el => {
        const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' '));
        return triggerTexts.some(text => label === normalize(text) || label.includes(normalize(text)));
      });
      if (!target) return JSON.stringify({ error: 'permission-trigger-not-found' });
      target.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"error":"permission-trigger-failed"}');
    let permissionOpenState = {};
    try { permissionOpenState = JSON.parse(permissionOpenRaw || '{}'); } catch {}
    if (permissionOpenState.error) throw new Error('未找到火山引擎权限策略选择框，未创建 AK/SK');
    await sleep(350);
    const permissionSelectRaw = await execJs(`(() => {
      const optionTexts = ${JSON.stringify(permissionConfig.optionTexts || [])};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const options = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, label, button')].filter(visible);
      const target = options.find(el => {
        const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
        return optionTexts.some(text => label === normalize(text) || label.includes(normalize(text)));
      });
      if (!target) return JSON.stringify({ error: 'permission-option-not-found' });
      target.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"error":"permission-option-failed"}');
    let permissionSelectState = {};
    try { permissionSelectState = JSON.parse(permissionSelectRaw || '{}'); } catch {}
    if (permissionSelectState.error) throw new Error('未找到火山引擎 AdministratorAccess 权限策略，未创建 AK/SK');
    await sleep(350);
  }

	  await sleep(500);
	  if (platform.captureBeforeConfirm) {
	    await execJs(`(() => {
	      if (window.__okitPreConfirmCapture?.armed) return 'already-armed';
	      const state = window.__okitPreConfirmCapture = { armed: true, clipboard: '', dom: [], responses: [] };
	      const rememberDom = value => {
	        const text = String(value || '');
	        if (text && !state.dom.includes(text)) state.dom.push(text.slice(0, 20000));
	        if (state.dom.length > 30) state.dom.shift();
	      };
	      const scan = () => {
	        const root = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="modal"]')]
	          .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
	        if (!root) return;
	        for (const el of root.querySelectorAll('input, textarea, code, [data-clipboard-text], [data-key]')) {
	          rememberDom(el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || el.textContent || '');
	        }
	        rememberDom(root.innerText || '');
	      };
	      state.timer = setInterval(scan, 40);
	      setTimeout(() => clearInterval(state.timer), 15000);
	      try {
	        if (navigator.clipboard?.writeText) {
	          const original = navigator.clipboard.writeText.bind(navigator.clipboard);
	          const wrapped = text => { state.clipboard = String(text || ''); return original(text); };
	          try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
	        }
	      } catch {}
	      try {
	        const originalFetch = window.fetch.bind(window);
	        window.fetch = async (...args) => {
	          const response = await originalFetch(...args);
	          const request = args[0];
	          const url = typeof request === 'string' ? request : (request?.url || '');
	          const method = String(args[1]?.method || request?.method || 'GET').toUpperCase();
	          response.clone().text().then(body => {
	            state.responses.push({ url, method, status: response.status, body: body.slice(0, 250000) });
	          }).catch(() => {});
	          return response;
	        };
	      } catch {}
	      try {
	        const originalOpen = XMLHttpRequest.prototype.open;
	        const originalSend = XMLHttpRequest.prototype.send;
	        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
	          this.__okitMethod = String(method || 'GET').toUpperCase();
	          this.__okitUrl = String(url || '');
	          return originalOpen.call(this, method, url, ...rest);
	        };
	        XMLHttpRequest.prototype.send = function(...args) {
	          this.addEventListener('load', () => {
	            let body = '';
	            try { body = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''; } catch {}
	            state.responses.push({ url: this.__okitUrl || '', method: this.__okitMethod || 'GET', status: this.status, body: body.slice(0, 250000) });
	          }, { once: true });
	          return originalSend.apply(this, args);
	        };
	      } catch {}
	      scan();
	      return 'armed';
	    })()`).catch(() => 'capture-arm-failed');
	  }
	  if (!platform.creationActionOnly) {
    const confirmOptions = {
          phrases: platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'],
          allowGenericInsideScope: true,
          belowNameInputBonus: Boolean(platform.confirmAfterNameInput),
        };
        confirmCollection: for (;;) {
        const confirmCollectRaw = await execJs(`(() => {
          const confirmSelectors = ${JSON.stringify(platform.confirmSelectors || [])};
          const nameSelectors = ${JSON.stringify(platform.nameSelectors || [])};
          const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="sheet"]';
          const visible = el => {
            const r = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
          };
          const visibleEnabled = el => {
            if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            const className = typeof el.className === 'string' ? el.className : '';
            return !/(^|\s)(?:[^\s]*button[^\s]*disabled|disabled)(?:\s|$)/i.test(className);
          };
          const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();

          const nameInput = nameSelectors.map(selector => document.querySelector(selector)).find(visible);
          const nameRect = nameInput ? nameInput.getBoundingClientRect() : null;
          const actionPhrases = ${JSON.stringify(platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'])};
          const actionMatches = el => {
            const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
            return actionPhrases.some(phrase => {
              const expected = normalize(phrase);
              return expected && (label === expected || label.startsWith(expected));
            });
          };

          const securityDialog = [...document.querySelectorAll(dialogSelectors)]
            .filter(visible)
            .find(dialog => /身份验证|安全验证|短信验证码|微信扫码验证|MFA|使用其他校验方式/i.test(dialog.innerText || ''));
          if (securityDialog) {
            return JSON.stringify({ securityVerification: true, securityText: (securityDialog.innerText || '').trim().slice(0, 240) });
          }

          // Verified scope: the form around the name input, else the dialog holding
          // it, else a visible dialog. The whole document is only acceptable when
          // the platform ships explicit confirm selectors to pin the target down.
          let scope = null;
          if (nameInput) {
            scope = nameInput.closest(dialogSelectors) || nameInput.closest('form');
            let scopeControls = scope ? [...scope.querySelectorAll('button, [role="button"]')].filter(visibleEnabled) : [];
            const scopeHasAction = controls => controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
              try { return control.matches(selector); } catch { return false; }
            }));
            if (!scopeHasAction(scopeControls) && ${Boolean(platform.inlineFormScope)}) {
              for (let ancestor = nameInput.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                const ancestorControls = [...ancestor.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
                if (!scopeHasAction(ancestorControls)) continue;
                scope = ancestor;
                scopeControls = ancestorControls;
                break;
              }
            }
            if (!scopeHasAction(scopeControls)) scope = null;
          }
          if (!scope) {
            const dialogCandidates = [...document.querySelectorAll(dialogSelectors)].filter(visible);
            scope = dialogCandidates.find(dialog => {
              const controls = [...dialog.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
              return controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
                try { return control.matches(selector); } catch { return false; }
              }));
            }) || dialogCandidates[0] || null;
          }
          if (!scope && confirmSelectors.length) scope = document;
          const hasScope = Boolean(scope);

          const matchSelectors = [...confirmSelectors, 'button[type="submit"]'];
          const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
          const descriptors = controls.map((el, index) => {
            const rect = el.getBoundingClientRect();
            const inScope = hasScope && (scope === document || scope === el || scope.contains(el));
            let selectorMatch = false;
            for (const selector of matchSelectors) {
              try { if (el.matches(selector)) { selectorMatch = true; break; } } catch { /* unselectable selector */ }
            }
            selectorMatch = selectorMatch && inScope;
            return {
              index,
              text: (el.textContent || '').trim().slice(0, 120),
              ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
              title: (el.title || '').trim().slice(0, 120),
              inVerifiedScope: inScope,
              selectorMatch,
              belowNameInput: Boolean(nameRect && rect.top >= nameRect.bottom - 4),
            };
          });
          return JSON.stringify({
            hasScope,
            nameFound: Boolean(nameInput),
            descriptors,
            buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16),
          });
        })()`);
        let confirmCollect = {};
        try { confirmCollect = JSON.parse(confirmCollectRaw || '{}'); } catch { confirmCollect = {}; }

        if (confirmCollect.securityVerification) {
          if (!run) throw new Error(`${platform.label || platform.id} 创建密钥需要完成控制台安全验证，自动化已停止，未创建或保存密钥`);
          await waitForInteractiveVerification({ run, platform, stage: 'confirm-action' });
          continue confirmCollection;
        }

        // Fail closed unless a verified scope exists. Without a scope the browser
        // never guessed at a confirm target, so nothing may be clicked.
        if (!confirmCollect.hasScope) {
          throw new Error('创建对话框需要补充项目、计费或权限设置后再确认：没有定位到表单或弹窗作用域');
        }
        const scopedCandidates = (confirmCollect.descriptors || []).filter(d => d.inVerifiedScope);
        const confirmSelected = resolveActionCandidate(scopedCandidates, confirmOptions);
        if (!confirmSelected) {
          const diagnostics = scopedCandidates
            .map(c => ({ raw: (c.text || '').slice(0, 40), aria: (c.ariaLabel || '').slice(0, 40), selector: Boolean(c.selectorMatch), belowName: Boolean(c.belowNameInput), score: scoreActionCandidate(c, confirmOptions) }))
            .slice(-12);
          throw new Error(`创建对话框需要补充项目、计费或权限设置后再确认：${(confirmCollect.buttons || []).join('、') || '未找到可确认的目标'}（候选诊断 ${JSON.stringify(diagnostics)}）`);
        }

        // Re-find the same control within the verified scope by index only after
        // its normalized text/aria/title fingerprint is unchanged. The scope is
        // recomputed and must still exist and contain the target — document-wide
        // scope is acceptable only because explicit confirmSelectors exist. When
        // the Node-selected descriptor relied on selector evidence, the live
        // element must still match a configured confirm selector or
        // button[type=submit]. Any drift aborts without clicking.
        const confirmFingerprint = descriptorFingerprint(confirmSelected);
        const expectConfirmSelector = Boolean(confirmSelected.selectorMatch);
        const confirmClickRaw = await execJs(`(() => {
          const confirmSelectors = ${JSON.stringify(platform.confirmSelectors || [])};
          const nameSelectors = ${JSON.stringify(platform.nameSelectors || [])};
          const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="sheet"]';
          const visible = el => {
            const r = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
          };
          const visibleEnabled = el => {
            if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            const className = typeof el.className === 'string' ? el.className : '';
            return !/(^|\s)(?:[^\s]*button[^\s]*disabled|disabled)(?:\s|$)/i.test(className);
          };
          const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const slice = value => String(value == null ? '' : value).trim().slice(0, 120);
          const nameInput = nameSelectors.map(selector => document.querySelector(selector)).find(visible);
          const actionPhrases = ${JSON.stringify(platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'])};
          const actionMatches = el => {
            const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
            return actionPhrases.some(phrase => {
              const expected = normalize(phrase);
              return expected && (label === expected || label.startsWith(expected));
            });
          };
          let scope = null;
          if (nameInput) {
            scope = nameInput.closest(dialogSelectors) || nameInput.closest('form');
            let scopeControls = scope ? [...scope.querySelectorAll('button, [role="button"]')].filter(visibleEnabled) : [];
            const scopeHasAction = controls => controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
              try { return control.matches(selector); } catch { return false; }
            }));
            if (!scopeHasAction(scopeControls) && ${Boolean(platform.inlineFormScope)}) {
              for (let ancestor = nameInput.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                const ancestorControls = [...ancestor.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
                if (!scopeHasAction(ancestorControls)) continue;
                scope = ancestor;
                scopeControls = ancestorControls;
                break;
              }
            }
            if (!scopeHasAction(scopeControls)) scope = null;
          }
          if (!scope) {
            const dialogCandidates = [...document.querySelectorAll(dialogSelectors)].filter(visible);
            scope = dialogCandidates.find(dialog => {
              const controls = [...dialog.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
              return controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
                try { return control.matches(selector); } catch { return false; }
              }));
            }) || dialogCandidates[0] || null;
          }
          if (!scope && confirmSelectors.length) scope = document;
          // Abort unless a scope exists. document scope is only ever assigned
          // above when explicit confirmSelectors exist, which is the only case
          // where a document-wide click is acceptable.
          if (!scope) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-gone' });

          // Some controlled Ant buttons are rendered through more than one
          // portal while the project selector commits. In that state a global
          // button index can point at a stale portal even though the visible
          // form is ready. Platforms may opt into an exact, current-scope
          // lookup so the verified visible action itself receives the click.
          if (${Boolean(platform.confirmByExactText)}) {
            const currentScopes = [...document.querySelectorAll(dialogSelectors)]
              .filter(visible)
              .filter(candidate => {
                const hasName = nameSelectors.length === 0 || nameSelectors.some(selector => {
                  try { return [...candidate.querySelectorAll(selector)].some(visible); } catch { return false; }
                });
                const hasAction = [...candidate.querySelectorAll('button, [role="button"]')]
                  .some(control => visibleEnabled(control) && actionMatches(control));
                return hasName && hasAction;
              });
            // React may keep earlier portal nodes mounted while the newest
            // dialog is being committed. The last visible matching portal is
            // the one the user-facing UI exposes.
            const currentScope = currentScopes.at(-1) || scope;
            const container = currentScope === document ? document : currentScope;
            const compact = value => normalize(value).replace(/[\s\u3000]+/g, '');
            const exactCandidates = [...container.querySelectorAll('button, [role="button"]')]
              .filter(visibleEnabled)
              .filter(control => {
                const label = [control.textContent, control.getAttribute('aria-label'), control.getAttribute('title')]
                  .filter(Boolean).join(' ');
                return actionPhrases.some(phrase => {
                  const expected = compact(phrase);
                  const actual = compact(label);
                  return expected && (actual === expected || actual.startsWith(expected));
                });
              });
            if (exactCandidates.length !== 1) {
              return JSON.stringify({ error: 'confirm-mismatch', reason: 'exact-target-count', count: exactCandidates.length });
            }
            const target = exactCandidates[0];
            if (${Boolean(platform.confirmNeedsForeground)}) {
              const rect = target.getBoundingClientRect();
              return JSON.stringify({ ok: true, foreground: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }
            target.click();
            return JSON.stringify({ ok: true, foreground: false, exact: true });
          }

          const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
          const targetIndex = ${confirmSelected.index};
          const expected = ${JSON.stringify(confirmFingerprint)};
          const target = controls[targetIndex];
          if (!target) return JSON.stringify({ error: 'confirm-mismatch', reason: 'index-gone' });
          // The recomputed scope must still contain the approved target.
          if (scope !== document && !scope.contains(target)) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-changed' });
          const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
            .map(normalize).join('|');
          if (actual !== expected) return JSON.stringify({ error: 'confirm-mismatch', reason: 'fingerprint-changed' });
          // Selector evidence must still hold when it chose the target.
          if (${expectConfirmSelector}) {
            let stillMatches = false;
            for (const selector of [...confirmSelectors, 'button[type="submit"]']) {
              try { if (target.matches(selector)) { stillMatches = true; break; } } catch { /* unselectable selector */ }
            }
            if (!stillMatches) return JSON.stringify({ error: 'confirm-mismatch', reason: 'selector-gone' });
          }
          if (${Boolean(platform.confirmNeedsForeground)}) {
            const rect = target.getBoundingClientRect();
            return JSON.stringify({ ok: true, foreground: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }
          target.click();
          return JSON.stringify({ ok: true, foreground: false });
        })()`);
        let confirmState = {};
        try { confirmState = JSON.parse(confirmClickRaw || '{}'); } catch { confirmState = {}; }
        if (confirmState.error) throw new Error('创建对话框需要补充项目、计费或权限设置后再确认：确认按钮在点击前发生变化');
        if (confirmState.foreground) {
          const clicked = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
          if (!clicked) throw new Error('无法点击创建对话框中的确认按钮');
        }
        if (platform.confirmKeyboardFallback) {
          // Kimi's controlled Ant button can ignore a trusted mouse gesture
          // while its project field is committing. Only send Enter when the
          // same create form is still visibly open and no one-time result
          // field exists, which avoids submitting twice after a successful
          // click.
          await sleep(900);
          const formStillOpen = await execJs(`(() => {
            const confirmLabels = ${JSON.stringify(platform.confirmTexts || ['OK'])};
            const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
            const isConfirm = button => confirmLabels.some(label => normalize(button.textContent) === normalize(label));
            const result = [...document.querySelectorAll('input, textarea')]
              .some(input => /^sk-[A-Za-z0-9_-]{40,}$/.test(input.value || ''));
            const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
              .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (${Boolean(platform.confirmForceKeyboardFallback)} || el.querySelector('input[role="combobox"]')); })
              .at(-1);
            const ok = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
              .find(button => isConfirm(button) && !button.disabled);
            return Boolean(!result && ok);
          })()`).catch(() => false);
          if (formStillOpen === true || formStillOpen === 'true') {
            const focusButton = await execJs(`(() => {
              const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (${Boolean(platform.confirmForceKeyboardFallback)} || el.querySelector('input[role="combobox"]')); })
                .at(-1);
              const confirmLabels = ${JSON.stringify(platform.confirmTexts || ['OK'])};
              const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
              const button = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
                .find(candidate => confirmLabels.some(label => normalize(candidate.textContent) === normalize(label)) && !candidate.disabled);
              if (!button) return JSON.stringify({ ok: false });
              button.focus();
              return JSON.stringify({ ok: true });
            })()`).catch(() => '{"ok":false}');
            let focusButtonState = {};
            try { focusButtonState = JSON.parse(focusButton || '{}'); } catch {}
            if (focusButtonState.ok) {
              const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
              await sendCommand('cdp', {
                cdpMethod: 'Input.dispatchKeyEvent',
                cdpParams: enterParams,
                workspace: 'okit',
                ...(tabId ? { tabId } : {}),
              }, 5000);
              await sendCommand('cdp', {
                cdpMethod: 'Input.dispatchKeyEvent',
                cdpParams: { ...enterParams, type: 'keyUp' },
                workspace: 'okit',
                ...(tabId ? { tabId } : {}),
              }, 5000);
            }
          }
        }
        break confirmCollection;
        }
  }

	  if (platform.captureBeforeConfirm) {
	    await sleep(300);
	    const preCaptureRaw = await execJs(`(() => JSON.stringify(window.__okitPreConfirmCapture || {}))()`).catch(() => '{}');
	    let preCapture = {};
	    try { preCapture = JSON.parse(preCaptureRaw || '{}'); } catch {}
	    const clipboardKey = keyFromText(preCapture.clipboard || '', platform);
	    const domKey = keyFromText((preCapture.dom || []).join('\n'), platform);
	    const responseEntries = (preCapture.responses || []).map(item => ({
	      url: item.url,
	      method: item.method,
	      responseStatus: item.status,
	      responsePreview: item.body,
	    }));
	    const responseKey = keyFromText(extractKeyFromCaptures(responseEntries, platform.id), platform);
	    const capturedKey = clipboardKey || responseKey || domKey;
	    if (capturedKey) {
	      await closeAutomationWindow();
	      return { value: capturedKey, name: uniqueName };
	    }
	  }

	  // Some consoles (including Mistral) put the one-time secret directly into
  // an input in their success dialog. Read that short-lived field before the
  // potentially slow full network-capture read; otherwise the dialog can be
  // gone before we inspect its value.
  const readDomKey = async () => {
    const domText = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.postCreateKeySelectors || [])};
      const fields = selectors.length
        ? [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
        : [...document.querySelectorAll('input, textarea, [data-clipboard-text], [data-key]')];
      // Read values from input/textarea elements
      const values = fields
        .map(el => el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || '');
      // Also read textContent from selector-matched elements (some platforms
      // put the key in a span/code rather than an input)
      const textContents = selectors.length
        ? fields.map(el => (el.textContent || '').trim()).filter(Boolean)
        : [];
      // Always include the dialog/body innerText as fallback — some platforms
      // show the key in a success toast or notification, not in a form field.
      const dialogText = (document.querySelector('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="toast"], [class*="notification"]')?.innerText) || '';
      return [values.join('\\n'), textContents.join('\\n'), dialogText, selectors.length ? '' : (document.body.innerText || '')].join('\\n');
    })()`).catch(() => '');
    return keyFromText(domText, platform);
  };

  const domReadAttempts = Math.max(1, Number(platform.postCreateDomReadAttempts) || 1);
  let immediateDomKey = null;
  for (let attempt = 0; attempt < domReadAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 500 : 350);
    immediateDomKey = await readDomKey();
    if (immediateDomKey) break;
  }
  // A few consoles reveal the secret only after the user clicks Copy. Install
  // a capture hook before invoking only the explicitly verified post-create
  // Copy action below. The value is returned only to the vault flow and is
  // never logged.
  const hasPostCreateCopy = Boolean(platform.postCreateCopyTexts?.length || platform.postCreateRowCopySelector || platform.postCreateCopyByMaskedKeyPrefix);
  if (hasPostCreateCopy) {
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      window.__okitCopyCaptureInfo = { source: '', length: 0, clipboardHooked: false, clipboardWriteHooked: false, execHooked: false };
      const capture = (value, source) => {
        const text = String(value || '');
        if (!text) return;
        window.__okitCapturedKey = text;
        window.__okitCopyCaptureInfo.source = source;
        window.__okitCopyCaptureInfo.length = text.length;
      };
      const captureSelectedControl = (control, source) => {
        if (!control || typeof control.value !== 'string') return;
        const start = Number.isFinite(control.selectionStart) ? control.selectionStart : 0;
        const end = Number.isFinite(control.selectionEnd) ? control.selectionEnd : control.value.length;
        capture(control.value.slice(start, end) || control.value, source);
      };
      try {
        if (navigator.clipboard?.writeText) {
          const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
          const wrappedWriteText = function(text) {
            capture(text, 'clipboard.writeText');
            return originalWriteText(text);
          };
          // Most Chromium builds accept the instance override. Some expose a
          // non-writable instance slot, so fall back to the Clipboard
          // prototype without ever querying the system clipboard.
          try { navigator.clipboard.writeText = wrappedWriteText; } catch {}
          if (navigator.clipboard.writeText !== wrappedWriteText) {
            try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
          if (navigator.clipboard.writeText !== wrappedWriteText) {
            try { Object.defineProperty(Object.getPrototypeOf(navigator.clipboard), 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
          window.__okitCopyCaptureInfo.clipboardHooked = navigator.clipboard.writeText === wrappedWriteText;
        }
      } catch {}
      try {
        if (navigator.clipboard?.write) {
          const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
          const wrappedWrite = function(items) {
            // Clipboard.write may receive a ClipboardItem instead of a plain
            // string. Inspect only the text item supplied by this page action;
            // do not call Clipboard.read or Clipboard.readText.
            for (const item of (items || [])) {
              if (!item?.types?.includes?.('text/plain')) continue;
              item.getType('text/plain').then(blob => blob.text()).then(text => capture(text, 'clipboard.write')).catch(() => {});
            }
            return originalWrite(items);
          };
          try { navigator.clipboard.write = wrappedWrite; } catch {}
          if (navigator.clipboard.write !== wrappedWrite) {
            try { Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: wrappedWrite }); } catch {}
          }
          if (navigator.clipboard.write !== wrappedWrite) {
            try { Object.defineProperty(Object.getPrototypeOf(navigator.clipboard), 'write', { configurable: true, value: wrappedWrite }); } catch {}
          }
          window.__okitCopyCaptureInfo.clipboardWriteHooked = navigator.clipboard.write === wrappedWrite;
        }
      } catch {}
      try {
        const originalExecCommand = document.execCommand.bind(document);
        document.execCommand = function(command) {
          if (String(command).toLowerCase() === 'copy') {
            // Libraries that implement Copy with a temporary <input> or
            // <textarea> do not populate window.getSelection(). Read only the
            // selection that this page has just made, never the system
            // clipboard. This keeps the capture scoped to the provider action.
            const active = document.activeElement;
            const selected = window.getSelection()?.toString() || '';
            capture(selected, 'document-selection');
            if (!selected) captureSelectedControl(active, 'active-control');
          }
          return originalExecCommand(command);
        };
        window.__okitCopyCaptureInfo.execHooked = document.execCommand !== originalExecCommand;
      } catch {}
      // Copy-helper libraries commonly select a short-lived input
      // and invoke the browser's native copy routine. Record that value when
      // it is selected, rather than reading any external clipboard state.
      for (const Prototype of [window.HTMLInputElement?.prototype, window.HTMLTextAreaElement?.prototype]) {
        if (!Prototype?.select || Prototype.__okitCopyHooked) continue;
        try {
          const originalSelect = Prototype.select;
          Prototype.select = function(...args) {
            captureSelectedControl(this, 'control-select');
            return originalSelect.apply(this, args);
          };
          Object.defineProperty(Prototype, '__okitCopyHooked', { value: true });
        } catch {}
      }
      document.addEventListener('copy', () => {
        const selected = window.getSelection()?.toString() || '';
        capture(selected, 'copy-event-selection');
        if (!selected) captureSelectedControl(document.activeElement, 'copy-event-control');
      }, true);
      // Some UI libraries populate event.clipboardData in their own Copy
      // handler. Capture it during bubbling, after that handler has run. This
      // observes only the provider's current copy event and never reads the
      // system clipboard.
      document.addEventListener('copy', (event) => {
        capture(event.clipboardData?.getData('text/plain') || '', 'copy-event-data');
      });
      return 'capture-ready';
    })()`).catch(() => {});
  }

  const requiresCopyCapture = Boolean(platform.requirePostCreateCopy);
  if (immediateDomKey && !requiresCopyCapture) {
    await closeAutomationWindow();
    return { value: immediateDomKey, name: uniqueName };
  }

  const copyAttempts = Math.max(0, Number(platform.postCreateCopyAttempts) || 0);
  for (let attempt = 0; attempt < copyAttempts; attempt += 1) {
    const retryDelay = Math.max(100, Number(platform.postCreateCopyRetryMs) || 500);
    await sleep(attempt === 0 ? 350 : retryDelay);
    const copyResult = await execJs(`(() => {
      const texts = ${JSON.stringify(platform.postCreateCopyTexts || [])};
      const rowCopySelector = ${JSON.stringify(platform.postCreateRowCopySelector || '')};
      const maskedKeyPrefix = ${JSON.stringify(platform.postCreateCopyByMaskedKeyPrefix || '')};
      const createdName = ${JSON.stringify(uniqueName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      let copyAction = null;
      if (rowCopySelector) {
        // Z.AI masks the API key cell but exposes a verified SVG copy icon in
        // that same row. Scope the click to the name we just created so an
        // unrelated existing credential can never be copied or saved.
        const createdRow = [...document.querySelectorAll('tr')]
          .find(row => (row.innerText || '').includes(createdName));
        const copyIcon = createdRow?.querySelector(rowCopySelector);
        // Z.AI binds its handler directly to the SVG. Clicking its decorative
        // wrapping span produces a pointer event but does not invoke the
        // provider's copy action, leaving the old clipboard value in place.
        copyAction = copyIcon?.closest('button, a, [role="button"]') || copyIcon || null;
      } else if (maskedKeyPrefix) {
        // Xiaomi's Token Plan list shows the newly-created key in a masked
        // paragraph and exposes two icon-only buttons in the same row. Only
        // the row's classified Copy icon may be clicked; the Reset button must
        // never be clicked automatically, and an ambiguous or iconless row is
        // left untouched.
        // The configured prefix is a literal provider marker (currently
        // tp-), so it is intentionally not treated as a regular expression.
        const escapedPrefix = maskedKeyPrefix;
        const maskedPattern = new RegExp('^' + escapedPrefix + '[A-Za-z0-9_-]{2,}\\\\*{3,}[A-Za-z0-9_-]*$');
        const createdRow = [...document.querySelectorAll('tr, [role="row"]')]
          .find(row => (row.innerText || '').includes(createdName));
        const searchRoot = createdRow || document;
        const keyNode = [...searchRoot.querySelectorAll('p, span, div, td')]
          .filter(visible)
          .map(el => ({ el, text: (el.textContent || '').trim() }))
          .filter(item => maskedPattern.test(item.text))
          .sort((a, b) => a.text.length - b.text.length)[0]?.el;
        const classifyIcon = ${XIAOMI_ICON_CLASSIFY_JS};
        let row = keyNode;
        for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
          const buttons = [...row.querySelectorAll('button, a, [role="button"]')].filter(visible);
          if (!buttons.length) continue;
          const copyButtons = buttons.filter(btn => {
            const label = [btn.textContent, btn.getAttribute('aria-label'), btn.getAttribute('title')]
              .filter(Boolean).join(' ').trim().toLowerCase();
            const textCopy = ${JSON.stringify(platform.postCreateCopyTexts || [])}
              .some(text => label === String(text).toLowerCase() || label.includes(String(text).toLowerCase()));
            return textCopy || classifyIcon(btn) === 'copy';
          });
          if (copyButtons.length === 1) {
            copyAction = copyButtons[0];
            break;
          }
          if (copyButtons.length > 1) break;
        }
      } else {
        copyAction = [...document.querySelectorAll('button, a, [role="button"]')]
          .filter(visible)
          .sort((a, b) => Number(Boolean(b.closest('[role="dialog"], [role="alertdialog"]'))) - Number(Boolean(a.closest('[role="dialog"], [role="alertdialog"]'))))
          .find(el => {
            const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
              .filter(Boolean).join(' ').trim().toLowerCase();
            return texts.some(text => label === text.toLowerCase() || label.includes(text.toLowerCase()));
          });
      }
      if (!copyAction || !visible(copyAction)) {
        return JSON.stringify({ clicked: false, rowFound: Boolean(rowCopySelector && [...document.querySelectorAll('tr')].some(row => (row.innerText || '').includes(createdName))) });
      }
      if (rowCopySelector) {
        const rect = copyAction.getBoundingClientRect();
        // Z.AI's React handler is attached to the clickable wrapper around
        // the SVG. Invoke that verified same-row action once before the
        // foregrounded CDP pointer event below; the latter remains the
        // trusted-input fallback for builds that ignore synthetic clicks.
        const clickTarget = copyAction.parentElement || copyAction;
        try {
          clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          clickTarget.click?.();
        } catch {}
        return JSON.stringify({
          clicked: Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0,
          rowFound: true,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        });
      }
      const rect = copyAction.getBoundingClientRect();
      copyAction.click();
      return JSON.stringify({
        clicked: rect.width > 0 && rect.height > 0,
        rowFound: true,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    })()`).catch(() => '{}');
    let copyState = {};
    try { copyState = JSON.parse(copyResult || '{}'); } catch {}
    if (!copyState.clicked) {
      console.log(`[auto-create] ${platform.id}: created-row copy action not ready (row found: ${Boolean(copyState.rowFound)})`);
      continue;
    }
    if (platform.postCreateRowCopySelector) {
      // The Z.AI list copy icon handles only trusted user input. Dispatch real
      // DevTools mouse events instead of Element.click(), using coordinates
      // calculated from the exact row created by this attempt.
      const pointer = { x: Number(copyState.x), y: Number(copyState.y), button: 'left', buttons: 1, clickCount: 1 };
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
        console.log(`[auto-create] ${platform.id}: created-row copy control had no usable coordinates`);
        continue;
      }
      // Clipboard writes triggered by a real pointer event are permitted only
      // when the provider page's window is foregrounded. The automation window
      // deliberately stays in the background for normal navigation, so bring
      // it forward only for this exact verified Copy action.
      const focused = await sendCommand('focus-window', {
        workspace: 'okit',
      }, 5000).catch(() => ({ ok: false }));
      if (!focused.ok) {
        console.log(`[auto-create] ${platform.id}: could not foreground copy window`);
        continue;
      }
      await sleep(150);
      const pressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mousePressed' },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      const released = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      if (!pressed.ok || !released.ok) {
        console.log(`[auto-create] ${platform.id}: created-row copy pointer dispatch failed`);
        continue;
      }
    } else if (platform.postCreateCopyNeedsForeground) {
      const pointer = { x: Number(copyState.x), y: Number(copyState.y), button: 'left', buttons: 1, clickCount: 1 };
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) continue;
      const focused = await sendCommand('focus-window', { workspace: 'okit' }, 5000).catch(() => ({ ok: false }));
      if (!focused.ok) continue;
      await sleep(150);
      const pressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mousePressed' },
        workspace: 'okit', ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      const released = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit', ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      if (!pressed.ok || !released.ok) continue;
    }
    if (platform.allowExtensionClipboardRead) {
      // The copy UI may use Chrome's native clipboard path, which cannot be
      // observed from page JavaScript. The extension only returns the value
      // if the entire clipboard text matches this platform's key format.
      await sleep(500);
      const clipboardRead = await sendCommand('clipboard-read', {
        workspace: 'okit',
        clipboardPattern: platform.keyPatterns?.[0] || '',
        clipboardAllowSurrounding: platform.id === 'zai-global',
      }, 5000).catch((error) => ({ ok: false, data: {}, error: error?.message || String(error) }));
      const clipboardDiag = clipboardRead.ok
        ? { matched: Boolean(clipboardRead.data?.matched), length: Number(clipboardRead.data?.length) || 0 }
        : { matched: false, length: 0, error: String(clipboardRead.error || 'read-failed').slice(0, 120) };
      console.log(`[auto-create] ${platform.id}: extension clipboard ${JSON.stringify(clipboardDiag)}`);
      const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched
        ? clipboardRead.data.value
        : '';
      const clipboardKey = keyFromText(clipboardValue, platform);
      if (clipboardKey) {
        await closeAutomationWindow();
        return { value: clipboardKey, name: uniqueName };
      }
    }
    // Clipboard APIs are asynchronous in some consoles. The interceptor above
    // records only the text supplied by this explicit provider Copy action; it
    // never reads the user's system clipboard.
    await sleep(250);
    const copiedText = await execJs('window.__okitCapturedKey || ""').catch(() => '');
    const captureInfo = await execJs(`(() => JSON.stringify({
      source: window.__okitCopyCaptureInfo?.source || '',
      length: Number(window.__okitCopyCaptureInfo?.length) || 0,
      clipboardHooked: Boolean(window.__okitCopyCaptureInfo?.clipboardHooked),
      clipboardWriteHooked: Boolean(window.__okitCopyCaptureInfo?.clipboardWriteHooked),
      execHooked: Boolean(window.__okitCopyCaptureInfo?.execHooked),
    }))()`).catch(() => '{}');
    console.log(`[auto-create] ${platform.id}: created-row copy capture ${captureInfo}`);
    const copiedKey = keyFromText(copiedText, platform);
    if (copiedKey) {
      await closeAutomationWindow();
      return { value: copiedKey, name: uniqueName };
    }
    // A provider may mount the one-time result dialog only after its Copy
    // action has resolved. Re-read the exact configured result selectors here
    // instead of assuming the DOM was ready before the first copy click.
    const copiedDomKey = await readDomKey();
    if (copiedDomKey) {
      await closeAutomationWindow();
      return { value: copiedDomKey, name: uniqueName };
    }
    // A few copy controls request the secret from the provider and copy it
    // without using a patchable Clipboard API. The capture is armed before
    // creation, so inspect only the responses produced by this creation/copy
    // flow as a fallback. Validation still rejects masked values.
    const copyNetwork = await sendCommand('network-capture-read', {
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 10000).catch(() => ({ ok: false, data: [] }));
    const copyEntries = copyNetwork.ok ? (copyNetwork.data || []) : [];
    const networkKey = keyFromText(extractKeyFromCaptures(copyEntries, platform.id), platform);
    if (networkKey) {
      await closeAutomationWindow();
      return { value: networkKey, name: uniqueName };
    }
    if (copyEntries.length) {
      console.log(`[auto-create] ${platform.id}: created-row copy network responses ${copyEntries.length}`);
    }
  }
  if (requiresCopyCapture) {
    throw new Error(platform.postCreateCopyFailureMessage || '创建成功页未能通过 Copy 按钮读取一次性明文；为避免保存非密钥内容，已停止保存。');
  }

  // Some consoles create the credential first and render its one-time secret
  // a few seconds later. Keep reading the same creation attempt rather than
  // submitting again, which would create duplicate keys.
  // A provider config that omits an explicit retry budget must still tolerate
  // the shared CDP response-body race. Keep at least three reads for every
  // generic flow; a successful key returns immediately and no second create
  // action is ever submitted.
  const readAttempts = Math.max(3, Number(platform.postCreateReadAttempts) || 0);
  const entries = [];
  for (let attempt = 0; attempt < readAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 2500 : 1500);
    const read = await sendCommand('network-capture-read', { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || '无法读取创建结果');
    entries.push(...(read.data || []));

    const captured = extractKeyFromCaptures(entries, platform.id);
    const capturedKey = keyFromText(captured, platform);
    if (captured && !capturedKey) {
      // Do not log the candidate. Its length and validation result are enough
      // to diagnose a provider format change without leaking a credential.
      console.log(`[auto-create] ${platform.id}: captured key-shaped value rejected by platform pattern (length ${captured.length})`);
      if (platform.id === 'moonshot') {
        console.log(`[auto-create] moonshot: rejected candidate shape ${JSON.stringify({
          length: captured.length,
          startsWithSk: captured.startsWith('sk-'),
          hasSpace: /\s/.test(captured),
          hasMask: /[*…]|\.{3}/.test(captured),
          asciiOnly: /^[\x00-\x7F]+$/.test(captured),
        })}`);
        console.log(`[auto-create] moonshot: captured credential fields ${JSON.stringify(describeCapturedSecretFields(entries))}`);
      }
    }
    if (capturedKey) {
      await closeAutomationWindow();
      return { value: capturedKey, name: uniqueName };
    }

    const domKey = await readDomKey();
    if (domKey) {
      await closeAutomationWindow();
      return { value: domKey, name: uniqueName };
    }
  }

  const secretDiagnostics = describeCapturedSecretFields(entries);
  if (platform.maskedSecretMessage && capturesContainMaskedSecret(entries)) {
    throw new Error(platform.maskedSecretMessage);
  }
  if (secretDiagnostics.length) {
    console.log('[auto-create] safe secret-field diagnostics', JSON.stringify(secretDiagnostics));
  }
  // DOM 诊断:把当前页面的按钮、弹窗、URL 信息输出到错误信息里
  const diag = await execJs(`(() => {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const keyPatterns = ${JSON.stringify(platform.keyPatterns || [])};
    const redact = value => {
      let text = String(value || '');
      for (const source of keyPatterns) {
        try { text = text.replace(new RegExp(source, 'g'), '[REDACTED]'); } catch {}
      }
      return text;
    };
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible).map(el => (el.textContent || '').trim().slice(0, 50)).filter(Boolean).slice(0, 20);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]')].filter(visible).map(el => redact((el.textContent || '').trim()).slice(0, 200));
    const inputs = [...document.querySelectorAll('input')].filter(visible).map(el => ({ type: el.type, placeholder: el.placeholder, value: el.value ? '(has value)' : '(empty)' })).slice(0, 10);
    return JSON.stringify({ url: location.href.slice(-80), title: document.title.slice(0, 60), buttons, dialogs, inputs });
  })()`).catch(() => '{}');
  throw new Error(`密钥可能已创建，但未能读取一次性明文（已抓取 ${entries.length} 条请求）。页面诊断: ${diag}。请在自动化窗口复制密钥后手动保存。`);
}

async function createBrowserPlatformKey(platform, tokenName, run) {
  const ORCHESTRATORS = {
    zhipu: createZhipuKey,
    volcengine: createVolcengineKey,
    'volcengine-agent': (params) => createVolcengineKey({ ...params, url: VOLC_AGENT_PLAN_URL }),
    minimax: createMinimaxKey,
  };
  const orchestrator = ORCHESTRATORS[platform.id]
    || ((params) => createGenericBrowserKey({ ...params, platform }));
  return orchestrator({ tokenName, run });
}

/** Recover the newest already-created Z.AI key without creating another one. */
async function recoverLatestZaiGlobalKey() {
  const platform = AUTO_CREATE_PLATFORM_MAP.get('zai-global');
  if (!platform) throw new Error('Z.AI platform metadata unavailable');
  const nav = await sendCommand('navigate', { url: platform.url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开 Z.AI 密钥列表失败');
  const tabId = nav.data && nav.data.tabId;
  const capStart = await sendCommand('network-capture-start', {
    pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || '无法开始 Z.AI 复制接口抓取');
  await sleep(7000);
  const raw = await execJs(`(() => {
    const rows = [...document.querySelectorAll('tr')]
      .filter(row => /^ZAI_API_KEY-/i.test((row.innerText || '').trim()));
    const row = rows[rows.length - 1];
    const icon = row?.querySelector('svg.lucide-copy');
    if (!row || !icon) return JSON.stringify({ error: !row ? 'row-not-found' : 'copy-not-found' });
    const target = icon.parentElement || icon;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.click?.();
    const rect = icon.getBoundingClientRect();
    const parentRect = target.getBoundingClientRect();
    return JSON.stringify({
      name: (row.querySelector('td')?.innerText || '').trim(),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0,
      parentX: parentRect.x + parentRect.width / 2,
      parentY: parentRect.y + parentRect.height / 2,
    });
  })()`).catch(() => '{}');
  let meta = {};
  try { meta = JSON.parse(raw || '{}'); } catch {}
  if (meta.error) throw new Error(`Z.AI 最近已创建行不可恢复：${meta.error}`);
  if (!meta.visible || !Number.isFinite(meta.x) || !Number.isFinite(meta.y)) {
    throw new Error('Z.AI 最近已创建行的复制控件不可用');
  }
  await execJs(`(() => {
    window.__okitRecoveryCopied = '';
    if (window.__okitRecoveryCopyHooked) return 'already-hooked';
    const capture = value => { if (typeof value === 'string' && value) window.__okitRecoveryCopied = value; };
    try {
      if (navigator.clipboard?.writeText) {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        const wrapped = text => { capture(String(text || '')); return original(text); };
        try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
      }
    } catch {}
    document.addEventListener('copy', event => {
      capture(event.clipboardData?.getData('text/plain') || '');
      const selected = window.getSelection()?.toString() || '';
      capture(selected);
    });
    window.__okitRecoveryCopyHooked = true;
    return 'hooked';
  })()`).catch(() => 'hook-failed');
  const focused = await sendCommand('focus-window', { workspace: 'okit' }, 5000);
  if (!focused.ok) throw new Error('无法将 Z.AI 复制窗口置前');
  await sleep(150);
  const pointer = { x: meta.x, y: meta.y, button: 'left', buttons: 1, clickCount: 1 };
  const pressed = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mousePressed' },
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 5000);
  const released = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 5000);
  if (!pressed.ok || !released.ok) throw new Error('Z.AI 最近已创建行复制点击失败');
  await sleep(500);
  const copiedNetwork = await sendCommand('network-capture-read', {
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 10000).catch(() => ({ ok: false, data: [] }));
  const copiedNetworkKey = copiedNetwork.ok
    ? keyFromText(extractKeyFromCaptures(copiedNetwork.data || [], 'zai-global'), platform)
    : null;
  if (copiedNetworkKey) {
    const { VaultStore } = require('../../vault/store');
    const vault = new VaultStore();
    await vault.set(platform.keyHint, copiedNetworkKey, platform.groupHint);
    await closeAutomationWindow();
    return { name: meta.name || 'latest', valueLength: copiedNetworkKey.length };
  }
  if (copiedNetwork.ok) {
    console.log('[auto-create] zai recovery copy response shapes', JSON.stringify({
      entries: describeCapturedResponses(copiedNetwork.data || []),
      secretFields: describeCapturedSecretFields(copiedNetwork.data || []),
    }));
  }
  const pageCopied = await execJs('window.__okitRecoveryCopied || ""').catch(() => '');
  const pageKey = keyFromText(pageCopied, platform);
  if (pageKey) {
    const { VaultStore } = require('../../vault/store');
    const vault = new VaultStore();
    await vault.set(platform.keyHint, pageKey, platform.groupHint);
    await closeAutomationWindow();
    return { name: meta.name || 'latest', valueLength: pageKey.length };
  }
  // A few React builds attach the handler to the icon wrapper rather than the
  // SVG node. Retry that exact same existing row once at the parent center.
  if (Number.isFinite(meta.parentX) && Number.isFinite(meta.parentY)) {
    const parentPointer = { x: meta.parentX, y: meta.parentY, button: 'left', buttons: 1, clickCount: 1 };
    await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchMouseEvent',
      cdpParams: { ...parentPointer, type: 'mousePressed' },
      workspace: 'okit', ...(tabId ? { tabId } : {}),
    }, 5000);
    await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchMouseEvent',
      cdpParams: { ...parentPointer, type: 'mouseReleased', buttons: 0 },
      workspace: 'okit', ...(tabId ? { tabId } : {}),
    }, 5000);
    await sleep(500);
    const parentCopied = await execJs('window.__okitRecoveryCopied || ""').catch(() => '');
    const parentKey = keyFromText(parentCopied, platform);
    if (parentKey) {
      const { VaultStore } = require('../../vault/store');
      const vault = new VaultStore();
      await vault.set(platform.keyHint, parentKey, platform.groupHint);
      await closeAutomationWindow();
      return { name: meta.name || 'latest', valueLength: parentKey.length };
    }
  }
  const clipboardRead = await sendCommand('clipboard-read', {
    workspace: 'okit', clipboardPattern: platform.keyPatterns[0], clipboardAllowSurrounding: true,
  }, 5000);
  const value = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
  const key = keyFromText(value, platform);
  if (!key) throw new Error(`Z.AI 最近已创建行复制内容无法通过格式校验（长度 ${Number(clipboardRead.data?.length) || 0}）`);
  const { VaultStore } = require('../../vault/store');
  const vault = new VaultStore();
  await vault.set(platform.keyHint, key, platform.groupHint);
  await closeAutomationWindow();
  return { name: meta.name || 'latest', valueLength: key.length };
}

function listAutoCreatePlatforms(_req, res) {
  // Do not expose selectors or implementation details to the browser.
  res.json({
    platforms: AUTO_CREATE_PLATFORMS.map(({ id, label, keyHint, defaultKeyName, groupHint, mode, permissionNote, keyLimits }) => ({
      id, label, keyHint, ...(defaultKeyName ? { defaultKeyName } : {}), groupHint, mode,
      ...(permissionNote ? { permissionNote } : {}),
      ...(keyLimits ? { keyLimits } : {}),
    })),
  });
}

/**
 * Open every currently unverified provider console in the dedicated automation
 * Chrome window. This never creates a key or reads credentials; it only gives
 * the user one place to finish each official login before verification runs.
 */
async function openVerificationLoginTabs(_req, res) {
  if (!isExtensionConnected()) {
    return res.status(503).json({ error: 'OKIT Chrome 扩展未连接。' });
  }
  try {
    const [first, ...remaining] = BROWSER_LOGIN_VERIFICATION_PLATFORMS;
    if (!first) return res.json({ opened: [], browserFocused: false });

    const initial = await sendCommand('navigate', { url: first.url, workspace: 'okit' }, 30000);
    if (!initial.ok) throw new Error(initial.error || `无法打开 ${first.label}`);

    for (const platform of remaining) {
      const opened = await sendCommand('tabs', { op: 'new', url: platform.url, workspace: 'okit' }, 15000);
      if (!opened.ok) throw new Error(opened.error || `无法打开 ${platform.label}`);
    }

    const browserFocused = await focusAutomationWindow();
    return res.json({
      opened: BROWSER_LOGIN_VERIFICATION_PLATFORMS.map(({ id, label }) => ({ id, label })),
      browserFocused,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

// ─── Routes ────────────────────────────────────────────────────────

const SUPPORTED = AUTO_CREATE_PLATFORMS.map(platform => platform.id);

async function autoCreateKey(req, res) {
  try {
    const { platform, tokenName, parentToken, interactive } = req.body;
    if (!platform || !tokenName) return res.status(400).json({ error: 'platform and tokenName are required' });
    if (!SUPPORTED.includes(platform)) return res.status(400).json({ error: `Unknown platform: ${platform}` });
    const platformConfig = AUTO_CREATE_PLATFORM_MAP.get(platform);

    // Cloudflare: API direct
    if (platform === 'cloudflare') {
      if (!parentToken) return res.status(400).json({ error: 'Cloudflare requires a parent token.' });
      const result = await createCloudflareToken({ parentToken, tokenName });
      return res.json({ success: true, ...result });
    }

    // Browser platforms: use Chrome Extension (no login needed — shares cookies)
    if (!isExtensionConnected()) {
      return res.status(503).json({
        success: false,
        error: 'OKIT Chrome 扩展未连接。请先安装扩展：chrome://extensions → 加载已解压的扩展程序 → 选择 okit/extension 目录',
      });
    }

    // The Vault UI opts into a resumable run. The HTTP request returns before
    // the provider page reaches a possible CAPTCHA so the UI can show the
    // handoff and poll this same run instead of starting a second creation.
    if (interactive === true) {
      const run = createAutoCreateRun({ platformConfig, tokenName });
      void executeAutoCreateRun(run);
      return res.status(202).json({
        success: true,
        pending: true,
        runId: run.id,
        status: run.status,
        platform,
        platformLabel: platformConfig.label || platform,
      });
    }

    try {
      const result = await createBrowserPlatformKey(platformConfig, tokenName);
      if (isAssetData(result.value)) {
        return res.status(500).json({ success: false, error: 'Extracted asset data, not API key.' });
      }
      return res.json({
        success: true,
        value: result.value,
        name: result.name,
        platform,
        ...(result.reusedExisting ? {
          reusedExisting: true,
          sourceKey: result.sourceKey,
        } : {}),
        ...(platformConfig.readyAfterMs ? { readyAfterMs: platformConfig.readyAfterMs } : {}),
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/not connected|disconnected|timed out/i.test(msg)) {
        return res.status(503).json({ success: false, error: msg });
      }
      const loginState = await detectLoginRequired(platformConfig);
      if (isLoginFailure(msg) || loginState.loginRequired) {
        const browserFocused = await focusAutomationWindow();
        const label = platformConfig?.label || platform;
        return res.status(401).json({
          success: false,
          loginRequired: true,
          browserFocused,
          loginUrl: loginState.url || platformConfig?.url,
          error: browserFocused
            ? `需要登录 ${label}。已将自动化浏览器窗口置前，请完成登录后回到 OKIT 重试。`
            : `需要登录 ${label}。请在 OKIT 自动化浏览器窗口完成登录后重试。`,
        });
      }
      const keyLimitError = classifyKeyCreationLimitFailure(msg, platformConfig?.label || platform, platformConfig?.keyLimits);
      if (keyLimitError) {
        return res.status(409).json({ success: false, error: keyLimitError, errorKind: 'platform_key_limit' });
      }
      return res.status(500).json({ success: false, error: `${platform} auto-create failed: ${msg}` });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Delete only a credential whose exact test name was returned by the create
// flow. This is deliberately separate from Vault deletion: the scheduled
// checker must revoke the provider-side credential, not merely remove a local
// reference. If the row or delete action is ambiguous, it fails closed.
async function deleteAnthropicBrowserKey({ createdName, tabId }) {
  const dispatchClick = (el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  let opened = false;
  for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
    const raw = await execJs(`(() => {
      const targetName = ${JSON.stringify(createdName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const rows = [...document.querySelectorAll('tr, [role="row"]')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
      const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(button => /more actions|更多操作|更多/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].filter(Boolean).join(' ')));
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      (${dispatchClick.toString()})(buttons[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    opened = Boolean(state.ok);
    if (!opened) await sleep(500);
  }
  if (!opened) throw new Error(`Anthropic 测试密钥菜单未打开：${createdName}`);

  let deleteItemClicked = false;
  for (let attempt = 0; attempt < 12 && !deleteItemClicked; attempt += 1) {
    const raw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, a')]
        .filter(visible)
        .filter(el => /delete api key|删除 API key|删除密钥/i.test(label(el)));
      if (items.length !== 1) return JSON.stringify({ ok: false, items: items.length });
      (${dispatchClick.toString()})(items[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    deleteItemClicked = Boolean(state.ok);
    if (!deleteItemClicked) await sleep(350);
  }
  if (!deleteItemClicked) throw new Error(`Anthropic 测试密钥删除菜单项未找到：${createdName}`);

  let confirmed = false;
  for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
    const raw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const dialogs = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].filter(visible);
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const controls = dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
        .filter(visible)
        .filter(el => /delete|删除/i.test(label(el)) && !/cancel|取消/i.test(label(el)));
      if (controls.length !== 1) return JSON.stringify({ ok: false, controls: controls.length });
      (${dispatchClick.toString()})(controls[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    confirmed = Boolean(state.ok);
    if (!confirmed) await sleep(350);
  }
  if (!confirmed) throw new Error(`Anthropic 测试密钥删除确认未找到：${createdName}`);

  let remaining = true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const targetName = ${JSON.stringify(createdName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('tr, [role="row"], body *')]
        .some(el => visible(el) && (el.innerText || '').trim() === targetName);
    })()`).catch(() => true);
    if (!remaining) break;
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`Anthropic 删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'anthropic', name: createdName };
}

async function deleteZhipuBrowserKey({ createdName, tabId }) {
  await sleep(2500);
  const rowStateRaw = await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
    if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
    const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter(button => String(button.innerText || button.getAttribute('aria-label') || '').trim() === '删除');
    if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
    const rect = buttons[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`).catch(() => '{"ok":false}');
  let rowState = {};
  try { rowState = JSON.parse(rowStateRaw || '{}'); } catch {}
  if (!rowState.ok) throw new Error(`智谱测试密钥删除行不唯一：${createdName}（${rowState.rows ?? rowState.buttons ?? 0}）`);
  let clicked = (await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      const row = [...document.querySelectorAll('tr, [role="row"]')].find(el => (el.innerText || '').includes(target));
      const button = row && [...row.querySelectorAll('button, [role="button"]')].find(el => String(el.innerText || el.getAttribute('aria-label') || '').trim() === '删除');
      if (!button) return false;
      button.click();
      return true;
    })()`).catch(() => false)) === true;
  if (!clicked) clicked = await foregroundClick({ x: rowState.x, y: rowState.y, tabId });
  if (!clicked) throw new Error(`智谱测试密钥删除按钮无法点击：${createdName}`);
  await sleep(500);

  let confirmed = false;
  for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
    const confirmRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], .el-message-box__wrapper')].filter(visible);
      const dialog = dialogs.find(el => (el.innerText || '').includes('此操作将永久删除该行数据')) || dialogs[0];
      if (!dialog) return JSON.stringify({ ok: false, dialogs: 0 });
      const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => String(button.innerText || button.getAttribute('aria-label') || '').trim() === '确定');
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      const rect = buttons[0].getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let confirmState = {};
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch {}
    if (confirmState.ok) {
      confirmed = (await execJs(`(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"], .el-message-box__wrapper')].find(el => (el.innerText || '').includes('此操作将永久删除该行数据'));
          const button = dialog && [...dialog.querySelectorAll('button, [role="button"]')].find(el => String(el.innerText || el.getAttribute('aria-label') || '').trim() === '确定');
          if (!button) return false;
          button.click();
          return true;
        })()`).catch(() => false)) === true;
      if (!confirmed) confirmed = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
    } else if (attempt < 11) {
      await sleep(400);
    }
  }
  if (!confirmed) throw new Error(`智谱测试密钥删除确认未找到：${createdName}`);
  let remaining = true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      return [...document.querySelectorAll('tr, [role="row"], body *')].some(el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && String(el.innerText || '').trim() === target);
      });
    })()`).catch(() => true);
    if (!remaining) break;
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`智谱删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'zhipu', name: createdName };
}

async function deleteMoonshotBrowserKey({ createdName, tabId }) {
  let rowState = {};
  for (let attempt = 0; attempt < 12 && !rowState.ok; attempt += 1) {
    const rowRaw = await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
    if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
    const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
      .filter(button => visible(button) && (button.textContent || '').trim() === 'Delete');
    if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
    const rect = buttons[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { rowState = JSON.parse(rowRaw || '{}'); } catch { rowState = {}; }
    if (!rowState.ok) await sleep(500);
  }
  if (!rowState.ok) throw new Error(`Kimi 测试密钥删除行不唯一：${createdName}（${rowState.rows ?? rowState.buttons ?? 0}）`);
  let opened = (await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const row = [...document.querySelectorAll('tr, [role="row"]')].find(el => visible(el) && (el.innerText || '').includes(target));
    const button = row && [...row.querySelectorAll('button, [role="button"]')]
      .find(el => visible(el) && (el.textContent || '').trim() === 'Delete');
    if (!button) return false;
    button.click();
    return true;
  })()`).catch(() => false)) === true;
  if (!opened) opened = await foregroundClick({ x: rowState.x, y: rowState.y, tabId });
  if (!opened) throw new Error(`Kimi 测试密钥删除按钮无法点击：${createdName}`);
  await sleep(500);

  let confirmState = {};
  for (let attempt = 0; attempt < 15 && !confirmState.ok; attempt += 1) {
    const confirmRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(button => visible(button) && (button.textContent || '').trim() === 'Confirm');
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      const rect = buttons[0].getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch { confirmState = {}; }
    if (!confirmState.ok) await sleep(350);
  }
  if (!confirmState.ok) throw new Error(`Kimi 删除确认按钮未找到：${createdName}（候选 ${Number(confirmState.buttons) || 0} 个）`);

  let confirmed = (await execJs(`(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(button => { const r = button.getBoundingClientRect(); const s = getComputedStyle(button); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !button.disabled && (button.textContent || '').trim() === 'Confirm'; });
    if (buttons.length !== 1) return false;
    buttons[0].click();
    return true;
  })()`).catch(() => false)) === true;
  if (!confirmed) confirmed = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
  await sleep(800);

  let remaining = true;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    remaining = await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      return [...document.querySelectorAll('tr, [role="row"]')].some(row => {
        const r = row.getBoundingClientRect(); const s = getComputedStyle(row);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && (row.innerText || '').includes(target);
      });
    })()`).catch(() => true);
    if (!remaining) break;
    await sleep(500);
  }
  // The provider can acknowledge the click without dispatching its controlled
  // form action. Retry only while the exact row remains, using the same unique
  // Confirm control and then Enter on that focused control.
  if (remaining) {
    const retryFocus = await execJs(`(() => {
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled && (el.textContent || '').trim() === 'Confirm'; });
      if (!button) return false;
      button.focus();
      return true;
    })()`).catch(() => false);
    if (retryFocus === true || retryFocus === 'true') {
      const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await sendCommand('cdp', { cdpMethod: 'Input.dispatchKeyEvent', cdpParams: enterParams, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => {});
      await sendCommand('cdp', { cdpMethod: 'Input.dispatchKeyEvent', cdpParams: { ...enterParams, type: 'keyUp' }, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => {});
      await sleep(800);
      remaining = await execJs(`(() => {
        const target = ${JSON.stringify(createdName)};
        return [...document.querySelectorAll('tr, [role="row"]')].some(row => (row.innerText || '').includes(target));
      })()`).catch(() => true);
    }
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`Kimi 删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'moonshot', name: createdName };
}

async function deleteCreatedBrowserKey({ platform, createdName, run = null }) {
  if (!platform || !createdName) throw new Error('删除测试密钥需要 platform 和 createdName');
  if (platform.cleanupMode === 'never') {
    throw new Error(`${platform.label || platform.id} 的自动创建流程复用或生成订阅密钥，禁止自动删除`);
  }
  const url = platform.deleteUrl || getBrowserPlatformUrl(platform);
  if (!url) throw new Error(`${platform.label || platform.id} 没有可用的删除控制台地址`);

  const nav = await sendCommand('navigate', { url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开删除密钥页面失败');
  const tabId = nav.data?.tabId;
  if (isLoginUrl(nav.data?.url)) throw new Error(`${platform.label || platform.id} 删除前需要登录`);
  // Anthropic's settings SPA acknowledges navigation before the workspace key
  // table has mounted. Give the route one render window before the exact-row
  // cleanup loop starts; the loop still fails closed if the row/action remains
  // ambiguous.
  if (platform.id === 'anthropic') {
    await sleep(1800);
    return deleteAnthropicBrowserKey({ createdName, tabId });
  }
  if (platform.id === 'zhipu') return deleteZhipuBrowserKey({ createdName, tabId });
  if (platform.id === 'moonshot') return deleteMoonshotBrowserKey({ createdName, tabId });
  if (platform.deleteReload) {
    // Some same-URL SPAs preserve the pre-create list in memory after the
    // navigation command. Reload only the configured provider page so the
    // exact newly-created test row becomes observable before deletion.
    await execJs('location.reload(); "reloading"').catch(() => {});
    await sleep(Math.max(500, Number(platform.deleteReloadWaitMs) || 1500));
  }
  if (platform.deletePreDismissTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.deletePreDismissTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const target = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => texts.includes((el.textContent || '').trim()));
      if (target) target.click();
      return target ? 'dismissed' : 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(350);
  }
  const lookupName = platform.deleteDisplayNameLength
    ? createdName.slice(0, Number(platform.deleteDisplayNameLength))
    : createdName;
  if (platform.deletePreNavigationTexts?.length) {
    let preNavigated = false;
    for (let attempt = 0; attempt < 8 && !preNavigated; attempt += 1) {
      const raw = await execJs(`(() => {
        const texts = ${JSON.stringify(platform.deletePreNavigationTexts)};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const candidates = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')]
          .filter(visible)
          .filter(el => texts.some(text => (el.textContent || '').trim() === text));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        const rect = candidates[0].getBoundingClientRect();
        return JSON.stringify({
          ok: true,
          href: candidates[0].getAttribute('href') || candidates[0].closest('a')?.getAttribute('href') || '',
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      })()`).catch(() => '{"ok":false}');
      let state = {};
      try { state = JSON.parse(raw || '{}'); } catch {}
      if (state.ok && platform.deletePreNavigationUseHref && state.href) {
        const exactUrl = new URL(state.href, url).href;
        const directNav = await sendCommand('navigate', { url: exactUrl, workspace: 'okit' }, 30000);
        preNavigated = Boolean(directNav.ok);
      } else if (state.ok && platform.deletePreNavigationUseHref && Number.isFinite(state.x) && Number.isFinite(state.y)) {
        preNavigated = await foregroundClick({ x: state.x, y: state.y, tabId });
      } else {
        preNavigated = Boolean(state.ok);
      }
      if (!preNavigated) await sleep(700);
    }
    if (!preNavigated) throw new Error(`${platform.label || platform.id} 删除前未找到导航入口：${platform.deletePreNavigationTexts.join('、')}`);
    await sleep(1000);
  }
  if (platform.deleteReadyAttempts) {
    let ready = false;
    for (let attempt = 0; attempt < Number(platform.deleteReadyAttempts) && !ready; attempt += 1) {
      const readyRaw = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const selector = ${JSON.stringify(platform.deleteButtonSelector || '')};
        const bodyText = document.body?.innerText || '';
        const hasTarget = bodyText.includes(targetName);
        const hasAction = !selector || Boolean(document.querySelector(selector));
        return JSON.stringify({ ready: hasTarget && hasAction, hasTarget, hasAction, loading: /Loading\\.\\.\\./i.test(bodyText) });
      })()`).catch(() => '{"ready":false}');
      let readyState = {};
      try { readyState = JSON.parse(readyRaw || '{}'); } catch {}
      ready = Boolean(readyState.ready);
      if (!ready) await sleep(1000);
    }
    if (!ready) throw new Error(`${platform.label || platform.id} 删除页面加载超时，未找到名称完全匹配的测试密钥：${createdName}`);
  }

  const deleteTexts = platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'];
  const deleteMenuTexts = platform.deleteMenuTexts || ['更多操作', 'More actions', '更多', 'More', '⋯', '…'];
  let clickState = null;
  for (let attempt = 0; attempt < 12 && !clickState?.ok; attempt += 1) {
    const raw = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(deleteTexts)};
      const deleteMenuTexts = ${JSON.stringify(deleteMenuTexts)};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const labelOf = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').trim();
      const matchesDelete = el => {
        const label = normalize(labelOf(el));
        return deleteTexts.some(text => {
          const expected = normalize(text);
          return label === expected || label.includes(expected);
        }) && !/cancel|取消|close|关闭/i.test(label);
      };
      const matchesMenu = el => {
        const label = normalize(labelOf(el));
        return deleteMenuTexts.some(text => {
          const expected = normalize(text);
          return label === expected || label.includes(expected);
        }) && !/cancel|取消|close|关闭/i.test(label);
      };
      const clickTarget = (el, extra = {}) => {
        const rect = el.getBoundingClientRect();
        return { ...extra, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, action: labelOf(el).slice(0, 100) };
      };
      const exactRowMenus = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(el => visible(el)
          && normalize(labelOf(el)).includes(normalize(targetName))
          && (/more actions|更多操作|更多|more|⋯|…/i.test(labelOf(el)) || matchesMenu(el)));
      if (exactRowMenus.length === 1) {
        exactRowMenus[0].click();
        return JSON.stringify({ ok: false, menu: true, domClicked: true, action: labelOf(exactRowMenus[0]).slice(0, 100) });
      }
      const configuredSelector = ${JSON.stringify(platform.deleteButtonSelector || '')};
      const deleteTextSelector = ${JSON.stringify(platform.deleteTextSelector || '')};
      const containers = [...document.querySelectorAll('tr, [role="row"], li, article, section, [data-testid], div')]
        .filter(el => visible(el) && (el.innerText || '').includes(targetName))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      // A row-action menu can already be open from the previous retry. Consume
      // its exact destructive action before clicking the row trigger again;
      // otherwise menu-based consoles (for example OpenRouter) just toggle the
      // menu closed and never reach the delete item.
      const activeMenus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')]
        .filter(visible);
      for (const menu of activeMenus) {
        const actions = [...menu.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(el => visible(el) && matchesDelete(el));
        if (actions.length === 1) return JSON.stringify(clickTarget(actions[0], { ok: true, fromMenu: true }));
      }
      for (const container of containers) {
        const controls = [...container.querySelectorAll('button, a, [role="button"]' + (deleteTextSelector ? ', ' + deleteTextSelector : ''))].filter(visible);
        const configuredIndex = Number.isInteger(${JSON.stringify(platform.deleteButtonIndex)})
          ? ${JSON.stringify(platform.deleteButtonIndex)}
          : null;
        if (configuredIndex !== null && configuredIndex >= 0 && controls.length > configuredIndex) {
          return JSON.stringify(clickTarget(controls[configuredIndex], { ok: true, configuredIndex }));
        }
        if (configuredSelector) {
          const configured = [...container.querySelectorAll(configuredSelector)].filter(visible);
          if (configured.length === 1) return JSON.stringify(clickTarget(configured[0], { ok: true }));
        }
        if (${platform.deleteTextOnly ? 'true' : 'false'}) {
          const textActions = [...container.querySelectorAll('*')]
            .filter(visible)
            .filter(el => !el.children.length && matchesDelete(el));
          if (textActions.length === 1) return JSON.stringify(clickTarget(textActions[0], { ok: true, textOnly: true }));
        }
        const actions = controls.filter(matchesDelete);
        if (actions.length !== 1) continue;
        return JSON.stringify(clickTarget(actions[0], { ok: true }));
      }
      // Some consoles, including Claude Platform, keep destructive actions
      // behind a row-specific "More actions" menu. Open only the menu in the
      // exact row, then look for the delete item in the visible menu.
      for (const container of containers) {
        const menus = [...container.querySelectorAll('button, a, [role="button"]')].filter(el => visible(el) && matchesMenu(el));
        if (menus.length !== 1) continue;
        return JSON.stringify(clickTarget(menus[0], { ok: false, menu: true }));
      }
      const visibleMenus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')]
        .filter(visible)
        .filter(menu => ${platform.deleteMenuGlobal ? 'true' : `normalize(String(menu.innerText || '') + ' ' + labelOf(menu)).includes(normalize(targetName))`});
      for (const menu of visibleMenus) {
        const actions = [...menu.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(el => visible(el) && matchesDelete(el));
        if (actions.length === 1) return JSON.stringify(clickTarget(actions[0], { ok: true, fromMenu: true }));
      }
      return JSON.stringify({ ok: false, foundName: containers.length > 0 });
    })()`).catch(() => '{"ok":false}');
    try { clickState = JSON.parse(raw || '{}'); } catch { clickState = { ok: false }; }
    if (clickState?.menu) {
      if (!clickState.domClicked && !await foregroundClick({ x: clickState.x, y: clickState.y, tabId })) {
        await closeAutomationWindow();
        throw new Error(`无法打开测试密钥操作菜单：${createdName}`);
      }
      clickState = null;
      await sleep(350);
      continue;
    }
    if (!clickState.ok) await sleep(800);
  }
  // Last-resort exact-row fallback for consoles that expose the row action
  // through an accessible label but do not make the surrounding row stable
  // enough for the generic container scan. It still requires the full test
  // name, then resolves exactly one destructive item from the opened menu.
  if (!clickState?.ok) {
    const fallbackOpen = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .filter(el => {
          const value = label(el).toLowerCase();
          return value.includes(targetName.toLowerCase()) && /more actions|更多操作|更多/.test(value);
        });
      if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
      candidates[0].click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let fallbackState = {};
    try { fallbackState = JSON.parse(fallbackOpen || '{}'); } catch {}
    if (fallbackState.ok) {
      await sleep(350);
      const fallbackDelete = await execJs(`(() => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
        const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')].filter(visible);
        const scope = menus.length ? menus : [document];
        const candidates = scope.flatMap(root => [...root.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')])
          .filter(visible)
          .filter(el => /delete|revoke|remove|删除|撤销/i.test(label(el)) && !/cancel|取消|close|关闭/i.test(label(el)));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true, domClicked: true });
      })()`).catch(() => '{"ok":false}');
      let fallbackDeleteState = {};
      try { fallbackDeleteState = JSON.parse(fallbackDelete || '{}'); } catch {}
      if (fallbackDeleteState.ok && fallbackDeleteState.domClicked) {
        clickState = { ok: true };
      }
    }
  }
  if (!clickState?.ok) {
    const diagnostic = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const redact = value => String(value || '')
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
        .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
      const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').trim().slice(0, 120);
      const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')]
        .filter(visible).map(label).filter(Boolean).slice(-30);
      const exactLabels = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .map(el => ({ value: label(el).slice(0, 160), target: label(el).toLowerCase().includes(${JSON.stringify(lookupName.toLowerCase())}), more: /more actions|更多操作|更多/i.test(label(el)) }))
        .filter(item => item.target);
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(visible).map(el => redact((el.innerText || '').trim()).slice(0, 240)).filter(Boolean).slice(-12);
      return JSON.stringify({ url: location.href.slice(-160), title: document.title.slice(0, 80), controls, exactLabels, rows });
    })()`).catch(() => '{}');
    await closeAutomationWindow();
    throw new Error(`未找到名称完全匹配的删除操作：${createdName}。页面诊断：${diagnostic}`);
  }

  let deleteClicked = false;
  if (platform.deleteDomFirst) {
    const domDeleteRaw = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'])};
      const deleteTextSelector = ${JSON.stringify(platform.deleteTextSelector || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return JSON.stringify({ ok: false, reason: 'row-count', count: rows.length });
      const controls = [...rows[0].querySelectorAll('button, a, [role="button"]' + (deleteTextSelector ? ', ' + deleteTextSelector : ''))]
        .filter(visible)
        .filter(control => deleteTexts.some(text => normalize(label(control)) === normalize(text)));
      if (controls.length !== 1) return JSON.stringify({ ok: false, reason: 'control-count', count: controls.length });
      controls[0].click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    try { deleteClicked = Boolean(JSON.parse(domDeleteRaw || '{}').ok); } catch { deleteClicked = false; }
    if (deleteClicked) {
      await sleep(350);
      const dialogVisible = await execJs(`(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')].some(dialog => {
        const rect = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }))()`).catch(() => false);
      if (dialogVisible !== true && dialogVisible !== 'true') deleteClicked = false;
    }
  }
  if (!deleteClicked) deleteClicked = await foregroundClick({ x: clickState.x, y: clickState.y, tabId });
  if (!deleteClicked) {
    for (let attempt = 0; attempt < 5 && !deleteClicked; attempt += 1) {
      const domDeleteRaw = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const configuredSelector = ${JSON.stringify(platform.deleteButtonSelector || '')};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
        const candidates = [...document.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(visible)
          .filter(el => (configuredSelector && el.matches(configuredSelector))
            || (/delete api key|删除 API key|删除密钥|delete key/i.test(label(el))
              && !/cancel|取消|close|关闭/i.test(label(el))));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"ok":false}');
      let domDeleteState = {};
      try { domDeleteState = JSON.parse(domDeleteRaw || '{}'); } catch {}
      deleteClicked = Boolean(domDeleteState.ok);
      if (!deleteClicked) await sleep(350);
    }
  }
  if (!deleteClicked) {
    await closeAutomationWindow();
    throw new Error(`无法点击测试密钥删除操作：${createdName}`);
  }
  await sleep(500);
  // Some provider consoles replace the normal delete confirmation with an
  // account-level security challenge immediately after the row action. Detect
  // that state before looking for a confirmation button; otherwise the
  // challenge's unrelated buttons are reported as an ambiguous delete
  // confirmation and the exact-row cleanup is stopped too early.
  if (platform.deleteSecurityVerificationTexts?.length) {
    const earlySecurityRaw = await execJs(`(() => {
      const phrases = ${JSON.stringify(platform.deleteSecurityVerificationTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
      const match = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .find(dialog => phrases.some(phrase => normalize(dialog.innerText || '').includes(normalize(phrase))));
      return JSON.stringify(match ? { matched: true, text: String(match.innerText || '').trim().slice(0, 180) } : { matched: false });
    })()`).catch(() => '{"matched":false}');
    let earlySecurityState = {};
    try { earlySecurityState = JSON.parse(earlySecurityRaw || '{}'); } catch {}
    if (earlySecurityState.matched) {
      if (run) {
        await waitForInteractiveVerification({ run, platform, stage: 'delete-security-verification' });
      } else {
        await waitForSecurityVerificationToClear({ platform, stage: 'delete' });
      }
      const remainingAfterSecurity = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        return [...document.querySelectorAll('tr, [role="row"], li, article')]
          .some(row => (row.innerText || '').includes(targetName));
      })()`).catch(() => true);
      if (!remainingAfterSecurity) {
        await closeAutomationWindow();
        return { success: true, platform: platform.id, name: createdName };
      }
    }
  }
  if (platform.deleteAllowMissingAfterClick) {
    const postClickStateRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const bodyText = document.body?.innerText || '';
      const exactRowPresent = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .some(row => visible(row) && (row.innerText || '').includes(${JSON.stringify(lookupName)}));
      const securityVisible = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .some(dialog => visible(dialog) && /安全验证|短信验证码|MFA|身份验证/i.test(dialog.innerText || ''));
      const expectedPage = location.hash === '#/iam/apikey/list'
        && /API Key/.test(bodyText)
        && (bodyText.includes('暂无数据') || bodyText.includes('总共') || bodyText.includes('已创建') || bodyText.includes('名称'));
      return JSON.stringify({ exactRowPresent, securityVisible, expectedPage });
    })()`).catch(() => '{}');
    let postClickState = {};
    try { postClickState = JSON.parse(postClickStateRaw || '{}'); } catch {}
    if (postClickState.expectedPage && !postClickState.exactRowPresent && !postClickState.securityVisible) {
      await closeAutomationWindow();
      return { success: true, platform: platform.id, name: createdName };
    }
  }
  if (platform.deleteConfirmInputText) {
    const confirmInputResult = await execJs(`(() => {
      const selector = ${JSON.stringify(platform.deleteConfirmInputSelector || 'input, textarea')};
      const expected = ${JSON.stringify(platform.deleteConfirmInputText)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      // Some Ant Design dialogs are exposed through the accessibility tree
      // before their wrapper is discoverable from the extension's execution
      // context. The configured selector is exact, so scan the document and
      // still require a single visible match rather than trusting the wrapper.
      const scopes = [document];
      const inputs = scopes.flatMap(scope => [...scope.querySelectorAll(selector)]).filter(visible);
      if (inputs.length !== 1) return 'input-count:' + inputs.length;
      const input = inputs[0];
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, expected);
      else input.value = expected;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value === expected ? 'filled' : 'value-mismatch';
    })()`).catch(error => `error:${error.message || error}`);
    if (confirmInputResult !== 'filled') {
      await closeAutomationWindow();
      throw new Error(`删除确认文本输入失败（${confirmInputResult}）：${createdName}`);
    }
    await sleep(300);
  }
  if (platform.deleteConfirmInputFromDialog) {
    let dynamicConfirmInput = 'not-found';
    for (let attempt = 0; attempt < 10 && dynamicConfirmInput !== 'filled'; attempt += 1) {
      dynamicConfirmInput = await execJs(`(() => {
      const hint = ${JSON.stringify(platform.deleteDialogText || '')}.replace(/[\\s\\u3000]+/g, '');
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .filter(dialog => !hint || String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '').includes(hint))
        .filter(dialog => [...dialog.querySelectorAll('input, textarea')].some(visible));
      const hintedDialogs = [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter(dialog => !hint || String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '').includes(hint))
        .filter(dialog => [...dialog.querySelectorAll('input, textarea')].some(visible))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const dialogs = (semanticDialogs.length ? semanticDialogs : hintedDialogs)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      if (!dialogs.length) return 'dialog-count:0';
      const dialog = dialogs[0];
      const inputs = [...dialog.querySelectorAll('input, textarea')].filter(visible);
      if (inputs.length !== 1) return 'input-count:' + inputs.length;
      const compactText = String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '');
      const match = compactText.match(/请输入([A-Za-z0-9_-]{4,32})确认删除/);
      if (!match) return 'confirmation-code-not-found';
      const input = inputs[0];
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, match[1]); else input.value = match[1];
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: match[1] }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value === match[1] ? 'filled' : 'value-mismatch';
      })()`).catch(error => `error:${error.message || error}`);
      if (dynamicConfirmInput !== 'filled') await sleep(400);
    }
    if (dynamicConfirmInput !== 'filled') {
      await closeAutomationWindow();
      throw new Error(`删除确认动态文本输入失败（${dynamicConfirmInput}）：${createdName}`);
    }
    await sleep(300);
  }
  if (platform.deleteDomRetry) {
    await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'])};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"]')].filter(visible);
      if (dialogs.length) return 'dialog-present';
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return 'row-count:' + rows.length;
      const controls = [...rows[0].querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .filter(el => deleteTexts.some(text => normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ')) === normalize(text)));
      if (controls.length !== 1) return 'control-count:' + controls.length;
      controls[0].click();
      return 'clicked';
    })()`).catch(() => 'failed');
    await sleep(500);
  }
  if (platform.deleteNoConfirm) {
    if (platform.deleteNoConfirmDomRetry) {
      await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const deleteTexts = ${JSON.stringify(platform.deleteTexts || [])};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
        const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
        const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
          .filter(row => visible(row) && (row.innerText || '').includes(targetName));
        if (rows.length !== 1) return 'row-count:' + rows.length;
        const controls = [...rows[0].querySelectorAll('button, a, [role="button"]')]
          .filter(visible)
          .filter(el => deleteTexts.some(text => normalize(label(el)) === normalize(text)));
        if (controls.length !== 1) return 'control-count:' + controls.length;
        controls[0].click();
        return 'clicked';
      })()`).catch(() => 'failed');
      await sleep(500);
    }
    if (platform.deleteNoConfirmReload) {
      await execJs('location.reload(); "reloading"').catch(() => {});
      await sleep(Math.max(500, Number(platform.deleteNoConfirmReloadWaitMs) || 1200));
    }
    let remaining = true;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(500);
      remaining = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        return [...document.querySelectorAll('body *')].some(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
        });
      })()`).catch(() => true);
      if (!remaining) break;
    }
    await closeAutomationWindow();
    if (remaining) throw new Error(`删除后仍能看到测试密钥：${createdName}`);
    return { success: true, platform: platform.id, name: createdName };
  }

  let confirmRaw = '{"ok":false}';
  let confirmState = {};
  const confirmAttempts = Math.max(1, Number(platform.deleteConfirmWaitAttempts) || 1);
  for (let attempt = 0; attempt < confirmAttempts && !confirmState.ok; attempt += 1) {
    confirmRaw = await execJs(`(() => {
    const configuredConfirmTexts = ${JSON.stringify(platform.deleteConfirmTexts || [])};
    const dialogTextHint = ${JSON.stringify(platform.deleteDialogText || '')};
    const configuredConfirmSelector = ${JSON.stringify(platform.deleteConfirmSelector || '')};
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
    };
    const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
    const hintedDialogs = dialogTextHint
      ? [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter(el => String(el.innerText || '').replace(/[\s\u3000]+/g, '').includes(dialogTextHint.replace(/[\s\u3000]+/g, '')))
        .filter(el => [...el.querySelectorAll('button, [role="button"]')].some(visible))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
      : [];
    const dialogs = hintedDialogs.length
      ? [hintedDialogs[0]]
      : (semanticDialogs.length ? semanticDialogs : [...document.querySelectorAll('.modal, [class*="dialog"], [class*="modal"]')].filter(visible));
    const controls = (dialogs.length
      ? dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
      : [...document.querySelectorAll('button, [role="button"]')]).filter(visible);
    if (configuredConfirmSelector) {
      const selectorCandidates = [...document.querySelectorAll(configuredConfirmSelector)].filter(visible);
      if (selectorCandidates.length === 1) {
        const rect = selectorCandidates[0].getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
    }
    const candidates = controls.filter(el => {
      const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
      const compact = label.replace(/[\s\u3000]+/g, '');
      const matchesConfigured = configuredConfirmTexts.length > 0
        && configuredConfirmTexts.some(text => compact.includes(String(text).replace(/[\s\u3000]+/g, '')));
      if (configuredConfirmTexts.length > 0) return matchesConfigured;
      return /delete|revoke|remove|confirm|确定|确认|删除|撤销/i.test(compact) && !/cancel|取消|close|关闭/i.test(compact);
    });
    if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
    const rect = candidates[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch { confirmState = {}; }
    if (!confirmState.ok && attempt + 1 < confirmAttempts) await sleep(500);
  }
  if (!confirmState.ok) {
    await closeAutomationWindow();
    throw new Error(`删除确认按钮不唯一（候选 ${Number(confirmState.count) || 0} 个），已停止以避免误删：${createdName}`);
  }
  let confirmClicked = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
  if (!confirmClicked) {
    const domConfirm = await execJs(`(() => {
      const configuredConfirmTexts = ${JSON.stringify(platform.deleteConfirmTexts || [])};
      const dialogTextHint = ${JSON.stringify(platform.deleteDialogText || '')};
      const configuredConfirmSelector = ${JSON.stringify(platform.deleteConfirmSelector || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
      const hintedDialogs = dialogTextHint
        ? [...document.querySelectorAll('body *')]
          .filter(visible)
          .filter(el => String(el.innerText || '').replace(/[\s\u3000]+/g, '').includes(dialogTextHint.replace(/[\s\u3000]+/g, '')))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        : [];
      const dialogs = hintedDialogs.length
        ? [hintedDialogs[0]]
        : (semanticDialogs.length ? semanticDialogs : [...document.querySelectorAll('.modal, [class*="dialog"], [class*="modal"]')].filter(visible));
      const candidates = (dialogs.length
        ? dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
        : [...document.querySelectorAll('button, [role="button"]')])
        .filter(visible)
        .filter(el => {
          const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
          const compact = label.replace(/[\s\u3000]+/g, '');
          const matchesConfigured = configuredConfirmTexts.length > 0
            && configuredConfirmTexts.some(text => compact.includes(String(text).replace(/[\s\u3000]+/g, '')));
          if (configuredConfirmTexts.length > 0) return matchesConfigured;
          return /delete|revoke|remove|confirm|确定|确认|删除|撤销/i.test(compact)
            && !/cancel|取消|close|关闭/i.test(compact);
        });
      if (configuredConfirmSelector) {
        const selectorCandidates = [...document.querySelectorAll(configuredConfirmSelector)].filter(visible);
        if (selectorCandidates.length === 1) {
          selectorCandidates[0].click();
          return true;
        }
      }
      if (candidates.length !== 1) return false;
      candidates[0].click();
      return true;
    })()`).catch(() => false);
    confirmClicked = domConfirm === true || domConfirm === 'true';
  }
  if (!confirmClicked) {
    await closeAutomationWindow();
    throw new Error(`无法确认删除测试密钥：${createdName}`);
  }

  if (platform.deleteSecurityVerificationTexts?.length) {
    const securityRaw = await execJs(`(() => {
      const phrases = ${JSON.stringify(platform.deleteSecurityVerificationTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
      const match = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .find(dialog => phrases.some(phrase => normalize(dialog.innerText || '').includes(normalize(phrase))));
      return JSON.stringify(match ? { matched: true, text: String(match.innerText || '').trim().slice(0, 180) } : { matched: false });
    })()`).catch(() => '{"matched":false}');
    let securityState = {};
    try { securityState = JSON.parse(securityRaw || '{}'); } catch {}
    if (securityState.matched) {
      if (run) {
        await waitForInteractiveVerification({ run, platform, stage: 'delete-security-verification' });
      } else {
        await waitForSecurityVerificationToClear({ platform, stage: 'delete' });
      }
    }
  }

  let remaining = true;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      return [...document.querySelectorAll('body *')].some(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
      });
    })()`).catch(() => true);
    if (!remaining) break;
  }
  if (remaining && platform.deleteConfirmDomRetry) {
    const retryDelete = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(button => (button.textContent || '').trim() === 'Confirm');
      if (buttons.length !== 1) return false;
      buttons[0].click();
      return true;
    })()`).catch(() => false);
    if (retryDelete === true || retryDelete === 'true') {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await sleep(500);
        remaining = await execJs(`(() => {
          const targetName = ${JSON.stringify(lookupName)};
          return [...document.querySelectorAll('body *')].some(el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
          });
        })()`).catch(() => true);
        if (!remaining) break;
      }
    }
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: platform.id, name: createdName };
}

async function deleteAutoCreateKey(req, res) {
  try {
    const { platform, createdName, parentToken, tokenId } = req.body || {};
    if (!platform || !createdName) return res.status(400).json({ success: false, error: 'platform and createdName are required' });
    if (platform === 'cloudflare') {
      await deleteCloudflareToken({ parentToken, tokenId });
      return res.json({ success: true, platform, name: createdName });
    }
    const platformConfig = AUTO_CREATE_PLATFORM_MAP.get(platform);
    if (!platformConfig) return res.status(400).json({ success: false, error: `Unknown platform: ${platform}` });
    if (!isExtensionConnected()) return res.status(503).json({ success: false, error: 'OKIT Chrome 扩展未连接' });
    return res.json(await deleteCreatedBrowserKey({ platform: platformConfig, createdName }));
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// ─── Server-side key extraction ──────────────────────────────────

function isAssetData(v) {
  if (!v) return true;
  if (v.startsWith('iVBOR') || v.startsWith('/9j/') || v.startsWith('R0lGOD')) return true;
  if (v.startsWith('AAEA') || v.startsWith('d09G') || v.startsWith('T1Rc')) return true;
  if (/^\d+\.\d/.test(v)) return true;
  if (v.includes('h117.') || v.includes('V296.')) return true;
  // Asterisks and bullets are provider-side masking, never valid credential
  // characters. Treat them as unavailable instead of storing a broken key.
  if (/[＊*•]/.test(v)) return true;
  if (v.includes(' ')) return true; // CSS class names, human text — not keys
  if (v.includes('flex') || v.includes('gap-') || v.includes('pointer') || v.includes('globalRuntime')) return true;
  return false;
}

function extractKeyFromHtml(html, platform) {
  if (!html) return null;
  const tokens = html.match(/[A-Za-z0-9+/=_-]{50,}/g) || [];
  const filtered = tokens
    .filter(g => !isAssetData(g))
    .filter(g => /[A-Z]/.test(g) && /[a-z]/.test(g) && /\d/.test(g))
    .filter(g => !g.includes('ant-') && !g.includes('css-') && !g.includes('-btn') && !g.includes('http'))
    .filter(g => !g.includes('/') || g.split('/').every(s => s.length < 40)) // filter file paths
    .filter(g => !g.includes('_next') && !g.includes('_buildManifest') && !g.includes('chunk'))
    .filter(g => g.length < 2000)
    .sort((a, b) => b.length - a.length);
  return filtered[0] || null;
}

// ─── Bilingual action resolution ────────────────────────────────────
// Pure, side-effect-free helpers that pick the safest "create credential"
// control from a set of DOM candidates. English and Simplified Chinese only.

const CREATE_ACTION_STRONG_PHRASES = [
  'create api key', 'create key', 'add', 'new api key',
  '创建 api 密钥', '新建 api key', '确定',
];

const CREATE_ACTION_GENERIC_PHRASES = ['create', 'new', '创建', '新建'];

// These must never be chosen as a create action, even when a strong create
// phrase also appears (e.g. "确定重置" or "Delete API key").
const CREATE_ACTION_REJECT_PHRASES = [
  'delete', 'remove', 'revoke', 'reset', 'regenerate',
  '删除', '移除', '撤销', '重置', '重新生成',
];

const CREATE_ACTION_SCORE_THRESHOLD = 70;
const CREATE_ACTION_SAFETY_MARGIN = 10;
const CREATE_ACTION_SELECTOR_BONUS = 12;
const CREATE_ACTION_BELOW_NAME_BONUS = 10;
// Safe base for a candidate chosen purely by verified selector evidence
// (button[type=submit] or a configured confirm selector) with no phrase text.
// Two such candidates stay ambiguous through the safety margin above.
const CREATE_ACTION_SELECTOR_ONLY_SCORE = 90;

/** Normalize action text for match purposes (lowercase, single spaces). */
function normalizeActionText(text) {
  return String(text == null ? '' : text)
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when `source` contains `phrase`. ASCII phrases need word boundaries
 *  so "create" never matches inside "creates"; CJK is matched literally. */
function textHasPhrase(source, phrase) {
  if (!source || !phrase) return false;
  if (/^[\u4e00-\u9fff]/.test(phrase)) return source.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(source);
}

/** Match strength of a normalized source against one phrase:
 *  2 = exact phrase, 1 = contains the phrase, 0 = no match. */
function phraseMatchStrength(source, phrase) {
  if (!source || !phrase) return 0;
  if (source === phrase) return 2;
  if (source.includes(phrase)) return 1;
  return 0;
}

/** Score a single action candidate. Candidate fields:
 *  text, ariaLabel, title, selectorMatch, inVerifiedScope, belowNameInput,
 *  visible, disabled. Options:
 *   phrases — the platform's exact configured phrases (defaults to the safe
 *             built-in strong list). A generic Create/New/创建/新建 phrase
 *             configured here only scores at all when options.
 *             allowGenericInsideScope is set AND the candidate is inside a
 *             verified form/dialog (inVerifiedScope) or matched a selector.
 *   belowNameInputBonus — award a fixed bonus to candidates flagged
 *             belowNameInput; preserves platform.confirmAfterNameInput without
 *             resorting to first/last matching hacks.
 *  Returns 0 when the candidate must never be chosen. */
function scoreActionCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') return 0;
  if (candidate.disabled || candidate.visible === false) return 0;

  const phrases = Array.isArray(options.phrases) && options.phrases.length
    ? options.phrases
    : CREATE_ACTION_STRONG_PHRASES;
  const allowGenericInsideScope = Boolean(options.allowGenericInsideScope);

  const text = normalizeActionText(candidate.text);
  const aria = normalizeActionText(candidate.ariaLabel);
  const title = normalizeActionText(candidate.title);
  const sources = [text, aria, title];

  // Destructive labels must never be read as create/confirm actions, even when
  // a strong phrase also appears (e.g. "确定重置" or "Delete API key").
  for (const phrase of CREATE_ACTION_REJECT_PHRASES) {
    for (const source of sources) {
      if (source && textHasPhrase(source, phrase)) return 0;
    }
  }

  const inVerifiedScope = Boolean(candidate.inVerifiedScope || candidate.selectorMatch);

  let score = 0;
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeActionText(phrase);
    if (!normalizedPhrase) continue;
    // Generic Create/New/创建/新建 never stand alone: they only score when the
    // platform explicitly configured them AND the candidate is inside a
    // verified form/dialog or matched a selector.
    const isGeneric = CREATE_ACTION_GENERIC_PHRASES.includes(normalizedPhrase);
    if (isGeneric && !(allowGenericInsideScope && inVerifiedScope)) continue;

    for (let i = 0; i < sources.length; i += 1) {
      const strength = phraseMatchStrength(sources[i], normalizedPhrase);
      if (!strength) continue;
      // Visible text carries full weight; aria/title are weaker supporting
      // evidence. An exact configured phrase must score; a phrase merely
      // contained in a longer label always scores lower.
      const weight = i === 0 ? 1 : 0.75;
      const base = isGeneric ? 85 : 100;
      const value = (strength === 2 ? base : base - 25) * weight;
      if (value > score) score = value;
    }
  }
  const hadPhraseScore = score > 0;

  // Stable selector evidence: a visible, enabled, non-dangerous candidate that
  // matched a verified selector (button[type=submit] or a configured confirm
  // selector) establishes a safe base score even with no phrase text. Several
  // such candidates stay ambiguous because resolveActionCandidate requires the
  // safety margin. The reject loop above already zeroed destructive labels.
  if (!hadPhraseScore && candidate.selectorMatch) {
    score = CREATE_ACTION_SELECTOR_ONLY_SCORE;
  }

  // A verified selector match, or a candidate below the name input when the
  // platform gates confirmation on it (confirmAfterNameInput), each add a
  // modest confidence bonus on top of a phrase score. Selector-only candidates
  // already carry their full safe base score, so no bonus stacks on top and
  // multiple selector-only candidates remain ambiguous via the safety margin.
  if (hadPhraseScore && candidate.selectorMatch) score += CREATE_ACTION_SELECTOR_BONUS;
  if (score > 0 && options.belowNameInputBonus && candidate.belowNameInput) score += CREATE_ACTION_BELOW_NAME_BONUS;

  return Math.round(score);
}

/** Stable fingerprint of a candidate's text/aria/title so a later re-scan can
 *  verify the same control is still at the same index before any click. */
function descriptorFingerprint(candidate) {
  return [candidate.text, candidate.ariaLabel, candidate.title]
    .map(normalizeActionText)
    .join('|');
}

/** Choose the best action candidate, or null when every candidate is too weak
 *  or the top two scored candidates are too close (ambiguous — never click).
 *  options.threshold and options.margin may override the safe defaults. */
function resolveActionCandidate(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : CREATE_ACTION_SCORE_THRESHOLD;
  const margin = Number.isFinite(Number(options.margin))
    ? Number(options.margin)
    : CREATE_ACTION_SAFETY_MARGIN;

  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, score: scoreActionCandidate(candidate, options) }))
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (ranked.length === 0) return null;
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (runnerUp && top.score - runnerUp.score < margin) return null;
  return top.candidate;
}

/** GET /api/vault/cdp-status — check if Chrome Extension is connected */
async function cdpStatus(req, res) {
  const { getExtensionVersion, getExtensionProtocol } = require('./ws-extension');
  return res.json({
    available: isExtensionConnected(),
    version: getExtensionVersion(),
    protocol: getExtensionProtocol(),
  });
}

module.exports = {
  autoCreateKey,
  autoCreateRunStatus,
  resumeAutoCreateRun,
  deleteAutoCreateKey,
  createCloudflareToken,
  deleteCloudflareToken,
  deleteCreatedBrowserKey,
  recoverLatestZaiGlobalKey,
  cdpStatus,
  listAutoCreatePlatforms,
  openVerificationLoginTabs,
  AUTO_CREATE_PLATFORMS,
  BROWSER_LOGIN_VERIFICATION_PLATFORMS,
  isLoginFailure,
  classifyKeyCreationLimitFailure,
  isLoginUrl,
  classifyInteractiveVerificationState,
  isOpenRouterPublicPage,
  hasOpenRouterPublicNavigation,
  extractKeyFromCaptures,
  describeCapturedSecretFields,
  capturesContainMaskedSecret,
  isAssetData,
  normalizeActionText,
  scoreActionCandidate,
  resolveActionCandidate,
  isValidZhipuApiKey,
  classifyXiaomiTokenPlanIcon,
  serializeCredentialPair,
  ZHIPU_CREATE_TEXTS,
  ZHIPU_CONFIRM_TEXTS,
};
