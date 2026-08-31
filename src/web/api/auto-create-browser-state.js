// Read-only login/security state probes and browser handoff helpers.
function createAutoCreateBrowserState(deps) {
  const { execJs, sendCommand, focusAutomationWindow, sleep, verificationTimeoutMs } = deps;
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
  return { isLoginFailure, classifyKeyCreationLimitFailure, isLoginUrl, detectLoginRequired, classifyInteractiveVerificationState, detectInteractiveVerification, waitForSecurityVerificationToClear, isOpenRouterPublicPage, hasOpenRouterPublicNavigation, redirectOpenRouterToLogin, handoffOpenRouterLoginIfNeeded, detectVolcengineLoginSurface };
}

module.exports = { createAutoCreateBrowserState };
