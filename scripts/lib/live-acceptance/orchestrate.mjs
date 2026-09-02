// Mode orchestration for the provider live-acceptance tool.
//
// runAcceptance is the single entry the CLI uses; the offline tests drive it
// with a fake browser driver and injected clock/sleep/spawn so every branch —
// including the "page redesigned, safe entry missing" red path — is provable
// without touching a real provider.

import path from 'node:path';
import fs from 'node:fs/promises';
import { redactSecrets } from './safety.mjs';
import {
  startReport, finalizeReport, sanitizePlatformResult, exitCodeFromResults, writeReportFile,
  uniqueRunStamp,
} from './report.mjs';
import { classifyLoginState, classifyVerification } from './probe.mjs';
import {
  readLaunchRecord, validateLaunchRecord, createWitness, awaitFreshWitnessReport,
  DEFAULT_WITNESS_PORT,
} from './sessions.mjs';

const DEFAULT_SETTLE = { attempts: 60, intervalMs: 500, spaSettleMs: 800 };

function pageSummary(state) {
  return {
    title: String(state?.title || ''),
    buttonsSummary: Array.isArray(state?.buttons) ? state.buttons : [],
    linksSummary: Array.isArray(state?.links) ? state.links : [],
    bodyChars: Number(state?.bodyChars) || 0,
  };
}

function classifyGuestOutcome(state) {
  if (classifyVerification(state)) {
    return { status: 'waiting_for_user', reason: '未登录会话遇到人机/安全验证（CAPTCHA/滑块/短信）——外部前置条件，需人工完成后重跑；未执行任何创建动作' };
  }
  if (classifyLoginState(state)) {
    return { status: 'passed_login_gate', reason: '未登录会话被登录墙识别（可交接登录）；本模式未执行任何创建/确认/复制/删除动作' };
  }
  if (state?.consoleSurface) {
    return { status: 'failed', reason: '全新临时会话未被登录拦截，页面呈现控制台特征——需人工核对（免登录视图或页面改版）' };
  }
  if ((state?.buttons?.length || 0) + (state?.links?.length || 0) > 0) {
    return { status: 'blocked_prerequisite', reason: '页面未呈现登录墙或控制台特征（可能营销页或改版），无法完成“未登录可识别”验收——需人工确认' };
  }
  return { status: 'failed', reason: '页面无可识别内容（疑似平台改版或反爬拦截）——探针无法定位登录墙，按失败处理' };
}

function classifyAuthVerifyOutcome(platform, state) {
  if (classifyVerification(state)) {
    return {
      status: 'waiting_for_user',
      loginUrl: state?.url,
      reason: '专用测试 profile 遇到人机/安全验证——请在保留的专用 Chrome 窗口人工完成官方验证后重跑',
    };
  }
  if (classifyLoginState(state)) {
    return {
      status: 'waiting_for_user',
      loginUrl: state?.url,
      reason: '专用测试 profile 尚未登录该平台；请在保留的专用 Chrome 窗口完成官方登录后重跑本命令（脚本不会代输账号/密码/验证码）',
    };
  }
  // Login/SSO transition pages (openai's "Signing in…" interstitial): a
  // handoff state, never a redesign verdict.
  if (state?.loginTransition) {
    return {
      status: 'waiting_for_user',
      loginUrl: state?.url,
      reason: '页面停留在登录/跳转过渡态（如 Signing in）——请稍后重跑；若持续出现请人工确认专用 profile 的登录态',
    };
  }
  // First-use workspace/organization chooser (anthropic's Individual /
  // Organization): a human prerequisite — the tool must never pick.
  if (state?.workspaceChooser) {
    return {
      status: 'waiting_for_user',
      loginUrl: state?.url,
      reason: '首次使用需人工选择组织/工作区（如 Individual / Organization）——外部前置条件，工具不代选；请在专用 Chrome 中完成选择后重跑',
    };
  }
  if ((state?.matchedExpected || []).length > 0) {
    return { status: 'passed_entry_found', reason: `已登录控制台可达，并找到预期安全入口文案（未点击）：${state.matchedExpected.slice(0, 3).join(' / ')}` };
  }
  if (state?.maskedPrefixFound) {
    return { status: 'passed_entry_found', reason: '已登录页面显示订阅专属 Key 的掩码前缀（未复制、未点击生成/重置）' };
  }
  if (platform.reuseOnly && state?.consoleSurface) {
    return { status: 'blocked_prerequisite', reason: '已登录，但页面未见可复用的掩码订阅 Key——按产品规则需先人工生成一次；自动化不会点击“生成/重置”' };
  }
  if (state?.keyManagementSurface) {
    return {
      status: 'passed_console_reached',
      reason: 'API Key 管理/列表页可确认（管理页级通过）；创建入口未出现在本次可见摘要中，不据此判定改版——入口级验收仍以按钮文案命中为准',
    };
  }
  const stable = state?.stable !== false;
  if (!stable || state?.skeletonUi) {
    return {
      status: 'page_not_ready',
      reason: state?.skeletonUi
        ? '页面仍为加载骨架/未渲染完成——有界等待后未稳定，不据此判定入口缺失或平台改版；请稍后重跑'
        : '页面在有界等待窗口内持续变化（未稳定）——不作入口/改版结论；请稍后重跑',
    };
  }
  if ((platform.expectedTexts || []).length > 0) {
    if (state?.consoleSurface) {
      return { status: 'failed', reason: 'safe_entry_missing：已登录且页面稳定的控制台上未找到任何预期入口文案——疑似第三方页面改版，需要更新平台策略' };
    }
    return {
      status: 'page_not_ready',
      reason: '页面已稳定但未呈现可确认的控制台内容（空壳/未就绪）——不据此判定入口缺失或平台改版；请稍后重跑',
    };
  }
  if (state?.consoleSurface) {
    return { status: 'passed_console_reached', reason: '已登录控制台可达；该平台未配置显式入口文案，仅验证页面状态（弱通过，不等于入口级验收）' };
  }
  return {
    status: 'page_not_ready',
    reason: '已登录会话未呈现可识别的稳定控制台（疑似未就绪或渲染中）——不作改版结论；请稍后重跑',
  };
}

function shouldScreenshot(policy, status) {
  if (policy === 'off') return false;
  if (policy === 'all') return true;
  // login-only: keep evidence for handoffs and failures; skip healthy
  // signed-in consoles, whose screenshots would contain account UI.
  return status === 'waiting_for_user' || status === 'failed' || status === 'blocked_prerequisite';
}

export async function runAcceptance(options) {
  const {
    mode,
    dryRun = false,
    allowCreateAndCleanup = false,
    keepOpen = null,
    screenshotPolicy = 'all',
    platformConfigs = [],
    driver = null,
    root,
    checkout = {},
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    settle = DEFAULT_SETTLE,
    fetchImpl = fetch,
    baseUrl = process.env.MODELSWAP_AUTO_CREATE_BASE_URL || 'http://127.0.0.1:3780',
    delegateScriptPath = '',
    repoRoot = process.cwd(),
    spawnImpl = null,
    env = process.env,
    logger = console,
    runStamp = '',
    sessionId = '',
    identityDeps = null,
    witnessTimeoutMs = 45000,
    createCleanupRealRunEnabled = false,
  } = options;

  // Mode default: auth-verify keeps the dedicated Chrome open so the user can
  // finish logins in it; guest/create-cleanup close it.
  const keepChromeOpen = keepOpen === null ? mode === 'auth-verify' : Boolean(keepOpen);
  // Millisecond + random stamp by default: two runs in the same second must
  // never share a report path or screenshot directory (P1 collision fix).
  const stamp = runStamp || uniqueRunStamp(now);
  const screenshotDir = path.join(root, 'screenshots', stamp);
  const report = startReport({
    mode,
    dryRun,
    checkout,
    requestedPlatforms: platformConfigs.map((platform) => platform.id),
    safety: {
      extensionLoaded: mode === 'create-cleanup',
      screenshotPolicy,
      keepOpen: keepChromeOpen,
      artifactRoot: root,
    },
  });

  const push = (partial) => {
    const result = sanitizePlatformResult(partial);
    report.results.push(result);
    logger.log(`${result.status}\t${result.platform}${result.reason ? `\t${result.reason}` : ''}`);
    return result;
  };

  let exitCode = 0;
  try {
    if (mode === 'create-cleanup') {
      exitCode = await runCreateCleanupMode({
        platformConfig: platformConfigs[0] || null,
        dryRun, allowCreateAndCleanup, push, fetchImpl, baseUrl,
        delegateScriptPath, repoRoot, spawnImpl, env, logger,
        sessionId, root, identityDeps, witnessTimeoutMs, createCleanupRealRunEnabled,
      });
    } else if (dryRun) {
      for (const platform of platformConfigs) {
        push({
          platform: platform.id,
          label: platform.label,
          mode: 'browser',
          stage: 'plan',
          status: 'dry_run',
          reason: 'dry-run 仅校验参数、计划与报告格式；未启动浏览器、未访问任何外部资源',
        });
      }
      exitCode = 0;
    } else {
      if (!driver) throw new Error(`模式 ${mode} 需要 browser driver（dry-run 除外）`);
      for (const platform of platformConfigs) {
        await probePlatform({ platform, mode, driver, settle, sleep, push, screenshotDir, screenshotPolicy });
      }
    }
  } catch (error) {
    push({
      platform: platformConfigs[0]?.id || 'all',
      label: platformConfigs[0]?.label || '',
      stage: 'fatal',
      status: 'rejected',
      reason: `运行中止：${redactSecrets(error?.message || String(error))}`,
    });
    exitCode = 1;
  } finally {
    // dry-run must not touch the driver at all; create-cleanup never uses one.
    if (driver && !dryRun && mode !== 'create-cleanup') {
      try {
        await driver.dispose({ keepOpen: keepChromeOpen });
      } catch (error) {
        logger.log(`warn\t浏览器清理失败：${redactSecrets(error?.message || error)}`);
      }
    }
  }

  finalizeReport(report);
  const reportPath = await writeReportFile(root, report, stamp);
  logger.log(`report\t${reportPath}`);
  return { report, exitCode: exitCode || report.exitCode, reportPath };
}

async function probePlatform({ platform, mode, driver, settle, sleep, push, screenshotDir, screenshotPolicy }) {
  const base = {
    platform: platform.id,
    label: platform.label,
    mode: 'browser',
    stage: 'navigate',
  };
  let tab;
  try {
    tab = await driver.openTab(platform.url);
  } catch (error) {
    return push({
      ...base,
      stage: 'open-tab',
      status: 'blocked_prerequisite',
      reason: `无法打开专用浏览器页面（浏览器/CDP 错误）：${redactSecrets(error?.message || error)}`,
    });
  }

  let state = null;
  try {
    // Heavy SPA shells (openai/deepseek/moonshot/qwen...) render long after
    // readyState flips to complete. Keep polling until the page exposes real
    // content (body text or any visible action/nav text) AND two consecutive
    // probes return the same signature — a bounded stability window, so an
    // evolving skeleton never receives an entry/redesign verdict.
    let previousSignature = null;
    let equalSamples = 0;
    const signatureOf = (probe) => JSON.stringify([
      probe?.bodyChars || 0,
      (probe?.buttons || []).length,
      (probe?.links || []).length,
    ]);
    const probeOnce = () => driver.probe(tab, {
      platformId: platform.id,
      expectedTexts: platform.expectedTexts || [],
      maskedPrefix: platform.maskedPrefix || '',
    });
    const observe = (probe) => {
      const signature = signatureOf(probe);
      if (signature === previousSignature) equalSamples += 1;
      else equalSamples = 0;
      previousSignature = signature;
    };
    for (let attempt = 0; attempt < Math.max(1, settle.attempts); attempt += 1) {
      state = await probeOnce();
      observe(state);
      const hasContent = (state?.bodyChars || 0) > 0
        || (state?.buttons?.length || 0) > 0
        || (state?.links?.length || 0) > 0;
      if (state?.readyState === 'complete' && !state?.aboutBlank && hasContent && equalSamples >= 1) break;
      await sleep(settle.intervalMs);
    }
    if (settle.spaSettleMs > 0) await sleep(settle.spaSettleMs);
    state = await probeOnce();
    observe(state);
    state.stable = equalSamples >= 1;
  } catch (error) {
    await safeClose(driver, tab);
    return push({
      ...base,
      stage: 'probe',
      status: 'failed',
      reason: `只读探针执行失败（可能页面改版或 CDP 中断）：${redactSecrets(error?.message || error)}`,
    });
  }

  const outcome = mode === 'guest'
    ? classifyGuestOutcome(state)
    : classifyAuthVerifyOutcome(platform, state);

  let screenshot = null;
  if (shouldScreenshot(screenshotPolicy, outcome.status)) {
    try {
      await fs.mkdir(screenshotDir, { recursive: true });
      const filePath = path.join(screenshotDir, `${mode}-${platform.id}.png`);
      await driver.screenshot(tab, filePath);
      screenshot = filePath;
    } catch {
      screenshot = null;
    }
  }

  await safeClose(driver, tab);
  return push({
    ...base,
    stage: 'classify',
    ...outcome,
    loginUrl: outcome.loginUrl || state?.url,
    page: pageSummary(state),
    screenshot,
  });
}

async function safeClose(driver, tab) {
  try {
    await driver.closeTab(tab);
  } catch {
    // closing a probe tab is best-effort; the driver disposes the browser
  }
}

// ─── P0: dedicated-Chrome extension identity ────────────────────────
//
// /api/vault/cdp-status only proves that SOME extension holds the server's
// single WS slot. Before any create/delete delegation we require a proof that
// the connected extension belongs to THIS acceptance session: a patched
// extension copy reporting {sessionId, wsUrl, wsState} to a local witness
// while its server socket is open. Every dep is injectable so the offline
// tests can drive the refuse paths without a browser.

function defaultIdentityDeps({ root, fetchImpl, witnessTimeoutMs = 45000 }) {
  return {
    readRecord: ({ sessionId }) => readLaunchRecord({ root, sessionId }),
    validateRecord: (record) => validateLaunchRecord(record, { root }),
    probeCdp: async (debugPort) => {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${debugPort}/json/version`);
        return response.ok;
      } catch {
        return false;
      }
    },
    startWitness: async (record) => {
      const witness = createWitness({ port: record.witnessPort || DEFAULT_WITNESS_PORT });
      await witness.start();
      return witness;
    },
    awaitReport: ({ witness, sessionId, expectPort }) => awaitFreshWitnessReport({
      witness, sessionId, expectWsPort: expectPort, maxWaitMs: witnessTimeoutMs,
    }),
  };
}

export async function verifyDedicatedExtensionIdentity({
  sessionId, root, baseUrl, fetchImpl = fetch, identityDeps = null, witnessTimeoutMs = 45000, logger = console,
}) {
  const deps = identityDeps || defaultIdentityDeps({ root, fetchImpl, witnessTimeoutMs });
  const refuse = (reason) => ({ ok: false, reason });
  if (!sessionId) {
    return refuse('未提供验收会话（--session）。create-cleanup 只接受由 provider-live-chrome --with-extension 生成的一次性验收会话；仅有“某个扩展在线”不构成执行依据');
  }
  const record = await deps.readRecord({ sessionId });
  if (!record) {
    return refuse(`找不到验收会话记录 ${sessionId}；请先用 provider-live-chrome --with-extension 启动专用 Chrome 生成新会话`);
  }
  const validation = await deps.validateRecord(record);
  if (!validation.ok) {
    return refuse(`会话记录校验失败：${validation.reason}`);
  }
  const cdpAlive = await deps.probeCdp(record.debugPort);
  if (!cdpAlive) {
    return refuse(`专用 Chrome 的 CDP（127.0.0.1:${record.debugPort}）未响应；会话 ${sessionId} 已失效，请重新启动`);
  }
  let expectPort = 80;
  try {
    expectPort = Number(new URL(baseUrl).port || 80);
  } catch {
    expectPort = 80;
  }
  let witness = null;
  try {
    witness = await deps.startWitness(record);
  } catch (error) {
    return refuse(`验收 witness 端口（${record.witnessPort || DEFAULT_WITNESS_PORT}）无法监听：${redactSecrets(error?.message || error)}；无法接收扩展证明`);
  }
  let report = null;
  try {
    report = await deps.awaitReport({ witness, sessionId, expectPort });
  } finally {
    try { await witness.stop(); } catch { /* already closed */ }
  }
  if (!report) {
    return refuse(`未在 ${Math.round(witnessTimeoutMs / 1000)}s 内收到会话 ${sessionId} 的扩展心跳证明（要求 wsState=OPEN 且目标端口=${expectPort}）。当前在线的可能是日常 Chrome 的普通扩展（未打补丁、不上报会话）；无法证明扩展来源，拒绝执行`);
  }
  logger.log(`identity\tverified\tsession=${sessionId}\twitness-port=${parsePortOf(report.wsUrl) ?? '?'}`);
  return { ok: true, record, report };
}

function parsePortOf(wsUrl) {
  const match = /:\/\/[^/:]+:(\d+)(?:\/|$)/.exec(String(wsUrl || ''));
  return match ? Number(match[1]) : null;
}

async function runCreateCleanupMode({
  platformConfig, dryRun, allowCreateAndCleanup, push, fetchImpl, baseUrl,
  delegateScriptPath, repoRoot, spawnImpl, env, logger,
  sessionId = '', root = '', identityDeps = null, witnessTimeoutMs = 45000,
  createCleanupRealRunEnabled = false,
}) {
  if (!platformConfig) {
    push({ platform: 'all', stage: 'validate', status: 'rejected', reason: 'create-cleanup 必须恰好指定一个平台' });
    return 1;
  }
  if (!dryRun && !allowCreateAndCleanup) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      stage: 'validate',
      status: 'rejected',
      reason: 'create-cleanup 默认禁止：真实运行必须同时给出 --platform 与 --allow-create-and-cleanup',
    });
    return 1;
  }
  if (dryRun) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      mode: platformConfig.mode,
      stage: 'plan',
      status: 'dry_run',
      reason: '仅计划校验：未连接 MODELSWAP 服务、未启动浏览器、未创建任何第三方密钥',
      steps: [
        { step: 'verify-server', detail: `GET ${baseUrl}/api/vault/cdp-status，要求 available=true（有扩展在线）` },
        { step: 'verify-dedicated-chrome', detail: '校验 --session 一次性会话的启动记录：专用 profile 位于验收根内、补丁扩展副本完整、专用 Chrome CDP 存活' },
        { step: 'verify-extension-session', detail: `在 witness（127.0.0.1:${DEFAULT_WITNESS_PORT}）收到本会话补丁扩展连接目标服务端口的新鲜心跳（wsState=OPEN）；普通/未知扩展在线不构成依据，无证明即拒绝` },
        { step: 'create', detail: `委托 scripts/auto-create-key-check.mjs ${platformConfig.id} --allow-create-and-cleanup：唯一测试名创建一把 Key` },
        { step: 'read', detail: '读取创建结果并核对唯一测试名与返回名称一致' },
        { step: 'delete', detail: '按精确名称删除本次创建的 Key（POST /api/vault/auto-create/delete）' },
        { step: 'confirm-gone', detail: '确认该名称行消失；任何清理失败立即停止并报告 cleanup_failed，不再创建下一把 Key' },
      ],
    });
    return 0;
  }

  if (!dryRun && !createCleanupRealRunEnabled) {
    // HARD DISABLE (leadership ruling 2026-08-31): the single-extension WS
    // slot means the witness can only prove the dedicated extension was
    // online *just now*; a later re-auth by the daily Chrome's extension
    // replaces extWs and the delegated create could land in the daily
    // browser. Commands are not session-bound in the product protocol, so
    // without changing the extension/server this cannot be eliminated on
    // one machine. Real runs stay disabled; only dry-run plans execute.
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      mode: platformConfig.mode,
      stage: 'disabled',
      status: 'disabled',
      reason: 'create-cleanup 真实创建当前禁用（裁定 2026-08-31）：单扩展槽位竞态未消除——witness 只能证明专用扩展“刚刚在线”，日常 Chrome 扩展随后重新认证即可替换服务端的 extWs，而自动创建命令不按 session 绑定，仍可能落到日常 Chrome。解禁二选一：① 在隔离 VM/独立机器运行专用 MODELSWAP 服务与专用 Chrome；② 改产品 WS 协议（服务端记录 acceptanceSession、命令按 session 发送、连接被替换即拒绝）。当前仅 dry-run 可用。',
    });
    return 1;
  }

  // Real run: the MODELSWAP server + its extension must be alive first.
  let health = { ok: false, payload: {} };
  try {
    const response = await fetchImpl(new URL('/api/vault/cdp-status', baseUrl));
    health = { ok: response.ok, payload: await response.json().catch(() => ({})) };
  } catch (error) {
    health = { ok: false, payload: { error: error?.message || String(error) } };
  }
  if (!health.ok || !health.payload?.available) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      mode: platformConfig.mode,
      stage: 'verify-server',
      status: 'blocked_prerequisite',
      reason: `MODELSWAP 服务/浏览器扩展未就绪（${redactSecrets(health.payload?.error || (health.ok ? 'available=false' : '服务不可达'))}）；请先启动 MODELSWAP 服务并用 provider-live-chrome.mjs --with-extension 打开专用 Chrome`,
    });
    return 2;
  }

  // P0 gate: prove the connected extension belongs to this acceptance
  // session before any create/delete delegation. cdp-status alone proves
  // nothing about WHICH Chrome the extension lives in.
  const identity = await verifyDedicatedExtensionIdentity({
    sessionId, root, baseUrl, fetchImpl, identityDeps, witnessTimeoutMs, logger,
  });
  if (!identity.ok) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      mode: platformConfig.mode,
      stage: 'verify-extension-session',
      status: 'unverified_extension_identity',
      reason: identity.reason,
    });
    return 1;
  }

  if (!spawnImpl || !delegateScriptPath) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      stage: 'delegate',
      status: 'failed',
      reason: '缺少委托执行器（内部错误）',
    });
    return 1;
  }

  const child = spawnImpl(process.execPath, [delegateScriptPath, platformConfig.id, '--allow-create-and-cleanup'], {
    cwd: repoRoot,
    env,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { if (stdout.length < 65536) stdout += String(chunk); });
  const code = await new Promise((resolve) => {
    child.on('error', resolve);
    child.on('close', (exitCode) => resolve(exitCode == null ? 1 : exitCode));
  });

  const reportMatch = stdout.match(/^report\t(.+)$/m);
  let delegated = null;
  if (reportMatch) {
    try {
      const payload = JSON.parse(await fs.readFile(reportMatch[1].trim(), 'utf8'));
      delegated = (payload.results || [])[0] || null;
    } catch {
      delegated = null;
    }
  }
  if (!delegated) {
    push({
      platform: platformConfig.id,
      label: platformConfig.label,
      mode: platformConfig.mode,
      stage: 'delegate',
      status: 'failed',
      reason: `委托脚本未产出可解析结果（退出码 ${code}）：${redactSecrets(stdout.split('\n').slice(-5).join(' '))}`,
    });
    return 1;
  }
  const result = push({
    platform: platformConfig.id,
    label: platformConfig.label,
    mode: platformConfig.mode,
    stage: 'delegate',
    status: delegated.status,
    reason: delegated.reason ? redactSecrets(delegated.reason) : `委托完成（status=${delegated.status}）`,
    testName: delegated.testName,
    createdName: delegated.createdName,
    delegateReport: reportMatch ? reportMatch[1].trim() : '',
  });
  logger.log(`delegate-exit\t${code}`);
  return exitCodeFromResults([result]);
}
