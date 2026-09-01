/**
 * Auto-create API keys for supported platforms.
 * Cloudflare: REST API (POST /client/v4/user/tokens)
 * Volcengine / Zhipu / MiniMax: Chrome Extension browser automation
 */

const https = require('https');
const crypto = require('crypto');
const { sendCommand, sendToExtension, isExtensionConnected } = require('./ws-extension');
const { createAutoCreateRunService } = require('../../application/auto-create-run-service');
const { createCloudflareKeyService } = require('../../application/auto-create-cloudflare-service');
const { createAutoCreateKeyParser } = require('../../application/auto-create-key-parser');
const { listPlatformDirectory } = require('../../application/auto-create-platform-directory');
const extraction = require('../../application/auto-create-extraction');
const actionResolution = require('../../application/auto-create-action-resolution');
const { createAutoCreateRuntime } = require('./auto-create-runtime');
const { createVolcengineMinimaxStrategy } = require('./auto-create-volcengine-minimax-strategy');
const { createZhipuStrategy } = require('./auto-create-zhipu-strategy');
const { createSpecialDeleteStrategies } = require('./auto-create-delete-special-strategy');
const { createBrowserDeleteStrategy } = require('./auto-create-delete-browser-strategy');
const { createGenericNavigationStrategy } = require('./auto-create-generic-navigation-strategy');
const { createGenericFormStrategy } = require('./auto-create-generic-form-strategy');
const { createGenericResultStrategy } = require('./auto-create-generic-result-strategy');
const { createAutoCreatePlatforms } = require('../../application/auto-create-platforms');
const { createCaptureExtractor } = require('../../application/auto-create-capture-extraction');
const { createAutoCreateBrowserState } = require('./auto-create-browser-state');
const { createBrowserOrchestrator } = require('./auto-create-browser-orchestrator');
const {
  isAssetData, isValidZhipuApiKey, isValidExtractionForPlatform,
  normalizeCredentialFieldName, findCredentialPair, serializeCredentialPair,
  parseCredentialPairText,
} = extraction;
const {
  normalizeActionText, textHasPhrase, phraseMatchStrength, scoreActionCandidate,
  descriptorFingerprint, resolveActionCandidate,
} = actionResolution;

let deleteAnthropicBrowserKey;
let deleteZhipuBrowserKey;
let deleteMoonshotBrowserKey;
let deleteCreatedBrowserKey;
let autoCreateRunService;
let beginGenericBrowserCreate;
let submitGenericBrowserCreate;
let readGenericBrowserCreateResult;
let createBrowserPlatformKey;
let recoverLatestZaiGlobalKey;
let browserOrchestrator;
const waitForInteractiveVerification = (args) => autoCreateRunService.pauseForVerification(args);

// Interactive browser runs need a small amount of server-side state so a
// security gate can pause the exact in-flight browser flow. Re-running the
// create endpoint after a CAPTCHA is unsafe: it can create duplicate keys.
const AUTO_CREATE_RUNS = new Map();
const AUTO_CREATE_VERIFICATION_TIMEOUT_MS = 30 * 60 * 1000;
const AUTO_CREATE_RUN_RESULT_TTL_MS = 10 * 60 * 1000;
const { createCloudflareToken, deleteCloudflareToken } = createCloudflareKeyService({ https });

const autoCreateRuntime = createAutoCreateRuntime({ sendCommand, sendToExtension, isExtensionConnected });
const { sleep, execJs, closeAutomationWindow, focusAutomationWindow, foregroundClick } = autoCreateRuntime;
const browserState = createAutoCreateBrowserState({
  execJs, sendCommand, focusAutomationWindow, sleep,
  verificationTimeoutMs: AUTO_CREATE_VERIFICATION_TIMEOUT_MS,
});
const {
  isLoginFailure, classifyKeyCreationLimitFailure, isLoginUrl, detectLoginRequired,
  classifyInteractiveVerificationState, detectInteractiveVerification,
  waitForSecurityVerificationToClear, isOpenRouterPublicPage,
  hasOpenRouterPublicNavigation, redirectOpenRouterToLogin, handoffOpenRouterLoginIfNeeded,
  detectVolcengineLoginSurface,
} = browserState;

// ─── Cloudflare REST API ───────────────────────────────────────────

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
const CREDENTIAL_PAIR_PLATFORMS = new Set();
const keyFromText = createAutoCreateKeyParser({
  credentialPairPlatforms: CREDENTIAL_PAIR_PLATFORMS,
  serializeCredentialPair, parseCredentialPairText, isAssetData,
});

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
async function autoCreateRunStatus(req, res) {
  try {
    return res.json(autoCreateRunService.status(req.params.runId));
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
}

async function resumeAutoCreateRun(req, res) {
  try {
    return res.json(autoCreateRunService.resume(req.params.runId));
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
}

const VOLC_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey';
// Agent Plan credentials are managed in the subscription console's dedicated
// key section. Generic Ark API keys are not accepted by /api/plan.
const VOLC_AGENT_PLAN_URL = 'https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan';
const VOLC_CREATE_TEXTS = ['创建 API Key'];
const MINIMAX_URL = 'https://platform.minimaxi.com/user-center/basic-information/interface-key';
const MINIMAX_CREATE_TEXTS = ['创建 API Key', '创建新的', 'Create new', '新建', '创建', 'Create'];

const platformRegistry = createAutoCreatePlatforms({ ZHIPU_URL, VOLC_URL, VOLC_AGENT_PLAN_URL, MINIMAX_URL });
const { AUTO_CREATE_PLATFORMS, AUTO_CREATE_PLATFORM_MAP, SPECIAL_PLATFORM_URLS, BROWSER_LOGIN_VERIFICATION_PLATFORMS, getBrowserPlatformUrl } = platformRegistry;

const captureExtractor = createCaptureExtractor({
  CREDENTIAL_PAIR_PLATFORMS, keyFromText, isAssetData, isValidExtractionForPlatform,
});
const {
  extractKeyFromCaptures, extractNewestNamedKeyFromCaptures, capturesContainMistralKeyRecords,
  describeCapturedSecretFields, describeCapturedResponses, describeMinimaxBackendResults,
  capturesContainMaskedSecret,
} = captureExtractor;

const volcengineMinimaxStrategy = createVolcengineMinimaxStrategy({
  sendCommand, execJs, sleep, closeAutomationWindow, foregroundClick,
  detectLoginRequired, detectInteractiveVerification, waitForInteractiveVerification, detectVolcengineLoginSurface,
  isAssetData, extractKeyFromCaptures, describeCapturedResponses,
  describeCapturedSecretFields, describeMinimaxBackendResults,
  VOLC_URL, VOLC_AGENT_PLAN_URL, VOLC_CREATE_TEXTS, MINIMAX_URL, MINIMAX_CREATE_TEXTS,
});
const { createVolcengineKey, createVolcengineAgentPlanKey, createMinimaxKey } = volcengineMinimaxStrategy;

const zhipuStrategy = createZhipuStrategy({
  sendCommand, execJs, sleep, closeAutomationWindow,
  detectLoginRequired, detectInteractiveVerification, waitForInteractiveVerification,
  isValidZhipuApiKey, extractKeyFromCaptures,
  ZHIPU_URL, ZHIPU_CREATE_TEXTS, ZHIPU_CONFIRM_TEXTS, ZHIPU_NAME_SELECTORS,
  resolveActionCandidate, scoreActionCandidate, descriptorFingerprint,
  clickCreateAction: (...args) => browserOrchestrator.clickCreateAction(...args),
});
const { createZhipuKey } = zhipuStrategy;

// ─── Platform registry and shared browser flow ─────────────────────
//
// The registry is the single source of truth for the Vault UI and the API.
// Every entry below maps to an online provider available in Model Management;
// local runtimes and OAuth-only Codex intentionally do not appear here.
// A browser flow always uses the user's already signed-in session in the OKIT
// automation window. It never receives or stores a platform password.

function listAutoCreatePlatforms(_req, res) {
  // Do not expose selectors or implementation details to the browser.
  res.json({ platforms: listPlatformDirectory(AUTO_CREATE_PLATFORMS) });
}

/**
 * Open every currently unverified provider console in the dedicated automation
 * Chrome window. This never creates a key or reads credentials; it only gives
 * the user one place to finish each official login before verification runs.
 */
async function openVerificationLoginTabs(_req, res) {
  if (!isExtensionConnected()) {
    return res.status(503).json({ error: 'OKIT 浏览器扩展未连接。' });
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
        error: 'OKIT 浏览器扩展未连接。请在 Chrome 打开 chrome://extensions，或在 Edge 打开 edge://extensions，然后选择“加载已解压的扩展程序”并选择 OKIT 扩展目录。',
      });
    }

    // The Vault UI opts into a resumable run. The HTTP request returns before
    // the provider page reaches a possible CAPTCHA so the UI can show the
    // handoff and poll this same run instead of starting a second creation.
    if (interactive === true) {
      const run = autoCreateRunService.create({ platformConfig, tokenName });
      void autoCreateRunService.execute(run);
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
    if (!isExtensionConnected()) return res.status(503).json({ success: false, error: 'OKIT 浏览器扩展未连接' });
    return res.json(await deleteCreatedBrowserKey({ platform: platformConfig, createdName }));
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// ─── Server-side key extraction ──────────────────────────────────

async function cdpStatus(req, res) {
  const { getExtensionVersion, getExtensionProtocol } = require('./ws-extension');
  return res.json({
    available: isExtensionConnected(),
    version: getExtensionVersion(),
    protocol: getExtensionProtocol(),
  });
}

beginGenericBrowserCreate = createGenericNavigationStrategy({
  sendCommand, sleep, extractNewestNamedKeyFromCaptures, capturesContainMistralKeyRecords,
  closeAutomationWindow, execJs, isLoginUrl, detectLoginRequired,
  detectInteractiveVerification, waitForInteractiveVerification,
  waitForSecurityVerificationToClear,
  recoverLatestZaiGlobalKey: (...args) => browserOrchestrator.recoverLatestZaiGlobalKey(...args),
  clickCreateAction: (...args) => browserOrchestrator.clickCreateAction(...args),
  keyFromText, extractKeyFromCaptures, foregroundClick, XIAOMI_ICON_CLASSIFY_JS,
  handoffOpenRouterLoginIfNeeded, hasOpenRouterPublicNavigation, redirectOpenRouterToLogin,
});
submitGenericBrowserCreate = createGenericFormStrategy({
  execJs, sendCommand, sleep, foregroundClick, waitForInteractiveVerification,
  resolveActionCandidate, scoreActionCandidate, descriptorFingerprint,
});
readGenericBrowserCreateResult = createGenericResultStrategy({
  execJs, sendCommand, sleep, keyFromText, extractKeyFromCaptures,
  closeAutomationWindow, describeCapturedSecretFields, capturesContainMaskedSecret,
});

browserOrchestrator = createBrowserOrchestrator({
  AUTO_CREATE_PLATFORM_MAP, VOLC_AGENT_PLAN_URL, createZhipuKey, createVolcengineKey,
  createVolcengineAgentPlanKey, createMinimaxKey, beginGenericBrowserCreate, submitGenericBrowserCreate,
  readGenericBrowserCreateResult, execJs, resolveActionCandidate, scoreActionCandidate,
  descriptorFingerprint, sendCommand, sleep, keyFromText, extractKeyFromCaptures,
  describeCapturedResponses, describeCapturedSecretFields, closeAutomationWindow, isAssetData,
});
({ createBrowserPlatformKey, recoverLatestZaiGlobalKey } = browserOrchestrator);

const specialDeleteStrategies = createSpecialDeleteStrategies({
  execJs, sleep, closeAutomationWindow, foregroundClick, sendCommand,
});
({ deleteAnthropicBrowserKey, deleteZhipuBrowserKey, deleteMoonshotBrowserKey } = specialDeleteStrategies);

const browserDeleteStrategy = createBrowserDeleteStrategy({
  sendCommand, execJs, sleep, closeAutomationWindow, foregroundClick,
  waitForInteractiveVerification, waitForSecurityVerificationToClear,
  deleteAnthropicBrowserKey, deleteZhipuBrowserKey, deleteMoonshotBrowserKey,
  getBrowserPlatformUrl, isLoginUrl,
});
({ deleteCreatedBrowserKey } = browserDeleteStrategy);

autoCreateRunService = createAutoCreateRunService({
  randomId: () => crypto.randomUUID(), now: () => new Date(), setTimer: setTimeout, clearTimer: clearTimeout,
  resultTtlMs: AUTO_CREATE_RUN_RESULT_TTL_MS, verificationTimeoutMs: AUTO_CREATE_VERIFICATION_TIMEOUT_MS,
  extensionConnected: isExtensionConnected, createBrowserKey: createBrowserPlatformKey, isAssetData,
  classifyLimit: classifyKeyCreationLimitFailure, detectLogin: detectLoginRequired,
  focusBrowser: focusAutomationWindow, sleep, detectVerification: detectInteractiveVerification,
});

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
