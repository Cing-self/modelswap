// Read-only page probe for guest/auth-verification.
//
// The probe is a single injected JS expression executed through CDP
// Runtime.evaluate. It may only READ the DOM: it never accesses
// cookies/storage, never reads input values, and never triggers events.
// buildProbeScript self-checks its own output against the forbidden-token
// list in safety.mjs, so an edit that breaks read-only-ness fails loudly.

import { assertProbeScriptReadOnly } from './safety.mjs';

// Interactive-verification phrase profiles, kept in sync with
// INTERACTIVE_VERIFICATION_PROFILES in src/web/api/auto-create-browser-state.js.
// zhipu is special-cased there because its signed-in page can mention
// account-security copy outside an active challenge; mirror that exactly.
const VERIFICATION_PROFILES = {
  default: {
    dialogPattern: '安全验证|身份验证|短信验证码|微信扫码验证|拖动下方滑块|完成拼图|MFA|使用其他校验方式|CAPTCHA|Turnstile|security verification',
    pagePattern: '需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|请验证后(?:继续|操作)|请(?:输入|填写)(?:短信)?验证码|拖动下方滑块|完成拼图|captcha challenge|security verification required',
    challengeSelectorPattern: 'captcha|turnstile|slider|security-check|security_check|verify-code|verification-code',
  },
  zhipu: {
    dialogPattern: '安全验证|身份验证|短信验证码|微信扫码验证|拖动下方滑块|完成拼图|MFA|使用其他校验方式|图形验证码|验证码',
    pagePattern: '需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|请验证后(?:继续|操作)|请(?:输入|填写)(?:短信)?验证码|拖动下方滑块|完成拼图|图形验证码|captcha challenge|security verification required',
    challengeSelectorPattern: 'captcha|turnstile|slider|security-check|security_check|verify-code|verification-code|安全验证|验证码',
  },
};

function verificationProfile(platformId) {
  return VERIFICATION_PROFILES[platformId] || VERIFICATION_PROFILES.default;
}

export function buildProbeScript({ expectedTexts = [], maskedPrefix = '', platformId = '' } = {}) {
  const profile = verificationProfile(platformId);
  const source = `(() => {
  const visible = (el) => {
    const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const style = el ? getComputedStyle(el) : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style && style.display !== 'none' && style.visibility !== 'hidden');
  };
  const norm = (text) => String(text || '').replace(/\\s+/g, '').toLowerCase();
  const squash = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 48);
  const labelOf = (el) => squash(el.textContent) || squash(el.getAttribute('aria-label')) || squash(el.getAttribute('title'));
  const url = location.origin + location.pathname;
  const pathOnly = location.pathname || '/';
  const loginRoute = /(?:login|signin|sign-in|auth|servicelogin|identifier\\/show|oauth\\/v2)(?:[/?]|$)/i.test(pathOnly);
  const hostIsLoginPage = /(^|\\.)login\\.|^accounts\\.|^passport\\.|login\\.microsoftonline\\.com$|^account\\.xiaomi\\.com$/i.test(location.hostname);
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwordFields = inputs.filter((el) => el.type === 'password' || el.getAttribute('autocomplete') === 'current-password').length;
  const hasLoginInput = inputs.some((el) => /账号名|账号ID|用户名|邮箱|手机号|手机号码|phone|password|密码/i.test(
    String(el.getAttribute('placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || '')
  ));
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 16000);
  const hasLoginPrompt = /请(?:先)?登录|登录后(?:继续|使用)|请登录(?:后)?|sign in to continue|log in to continue|please sign in|authentication required/i.test(bodyText);
  const actionEls = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
  const navEls = [...document.querySelectorAll('a')].filter(visible);
  const actionTexts = actionEls.map(labelOf).filter(Boolean);
  const navTexts = navEls.map(labelOf).filter(Boolean);
  const hasLoginAction = actionTexts.some((text) => /(?:登录|登入|sign in|log in)/i.test(text));
  const hasSmsLoginSurface = actionTexts.some((text) => /获取验证码|发送验证码/i.test(text))
    && actionTexts.some((text) => /登录\\s*\\/\\s*注册|登录|注册/i.test(text));
  const publicRootLoginSurface = ${JSON.stringify(platformId === 'kimi-coding-plan')}
    && /^https:\\/\\/www\\.kimi\\.com\\/(?:zh\\/)?$/.test(url)
    && hasLoginAction;
  const dialogPattern = ${JSON.stringify(profile.dialogPattern)};
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .el-dialog, .modal, [class*="dialog"], [class*="modal"]')]
    .filter(visible)
    .map((dialog) => squash(dialog.textContent));
  const verificationDialog = dialogs.some((text) => new RegExp(dialogPattern, 'i').test(String(text)));
  const pagePattern = ${JSON.stringify(profile.pagePattern)};
  const verificationPage = new RegExp(pagePattern, 'i').test(bodyText);
  const strongPageVerification = /拖动下方滑块|完成拼图|需要(?:完成|进行)?安全验证|请(?:先)?完成安全验证|security verification required/i.test(bodyText);
  const challengeIframe = [...document.querySelectorAll('iframe')].some((frame) => visible(frame) && /captcha|verify|security/i.test(
    String(frame.src || '') + ' ' + String(frame.title || '')
  ));
  const challengeSelectorPattern = ${JSON.stringify(profile.challengeSelectorPattern)};
  const challengeNode = [...document.querySelectorAll('body *')].some((el) => {
    if (!visible(el)) return false;
    const identity = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.getAttribute('title')]
      .filter((value) => typeof value === 'string').join(' ');
    return new RegExp(challengeSelectorPattern, 'i').test(identity);
  });
  const challengeControl = [...document.querySelectorAll('input, textarea, button, [role="button"]')].some((el) => {
    if (!visible(el)) return false;
    const identity = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('title'), el.textContent]
      .filter((value) => typeof value === 'string').join(' ');
    return /验证码|图形验证|安全码|verification code|security code|captcha|滑块|slider/i.test(identity);
  });
  const expected = ${JSON.stringify((expectedTexts || []).map((text) => String(text)))};
  const collected = [...actionTexts, ...navTexts].map(norm);
  const matchedExpected = expected.filter((text) => {
    const wanted = norm(text);
    return wanted.length >= 2 && collected.some((item) => item === wanted || item.includes(wanted));
  });
  const maskedPrefix = ${JSON.stringify(maskedPrefix)};
  // Boolean only: the matched secret text itself never crosses the boundary.
  const maskedPrefixFound = Boolean(maskedPrefix) && bodyText.indexOf(maskedPrefix) !== -1;
  const consoleSurface = /api\\s*key|api keys|密钥管理|密钥列表|api 密钥|access key|management key|credential|调用凭证|token plan|订阅/i.test(bodyText);
  const unique = (list) => [...new Set(list)];
  return JSON.stringify({
    url,
    title: String(document.title || '').slice(0, 120),
    readyState: document.readyState,
    bodyChars: bodyText.length,
    loginRoute,
    hostIsLoginPage,
    passwordFields,
    hasLoginInput,
    hasLoginPrompt,
    hasLoginAction,
    hasSmsLoginSurface,
    publicRootLoginSurface,
    verificationDialog,
    verificationPage,
    strongPageVerification,
    challengeIframe,
    challengeNode,
    challengeControl,
    buttons: unique(actionTexts).slice(0, 30),
    links: unique(navTexts).slice(0, 20),
    matchedExpected,
    maskedPrefixFound,
    consoleSurface,
  });
})()`;
  assertProbeScriptReadOnly(source);
  return source;
}

// Mirror of classifyLoginRequiredState in auto-create-browser-state.js, plus
// the OAuth host signal (accounts.google.com, passport.baidu.com, ...) that
// guest sessions hit before any password field renders.
export function classifyLoginState(state = {}) {
  return Boolean(
    state.loginRoute
    || state.hostIsLoginPage
    || state.passwordFields > 0
    || (state.hasLoginInput && state.hasLoginAction)
    || (state.hasLoginPrompt && state.hasLoginAction)
    || state.hasSmsLoginSurface
    || state.publicRootLoginSurface,
  );
}

// Mirror of classifyInteractiveVerificationState's matched semantics.
export function classifyVerification(state = {}) {
  const challengeSurface = Boolean(state.challengeIframe || state.challengeNode || state.challengeControl);
  return Boolean(
    state.verificationDialog
    || (state.verificationPage && (challengeSurface || state.strongPageVerification)),
  );
}
