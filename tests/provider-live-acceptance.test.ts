// Offline safety/behavior tests for the provider live-acceptance tool.
//
// These never launch Chrome, never touch a real provider, and never talk to
// the OKIT server. The browser is a fake driver; the spawn/fetch used by
// create-cleanup is injected. Subprocess cases run the real CLI/launcher
// scripts under an isolated HOME/USERPROFILE with a dead server URL, so no
// code path can reach the network even if a guard regresses.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseLiveAcceptanceArgs } from '../scripts/lib/live-acceptance/args.mjs';
import {
  isSimpleProfileName, assertSafeProfileDir, findUnsafeArg, redactSecrets, sanitizeUrl,
  assertDriverActionAllowed, assertProbeScriptReadOnly, dailyProfileHomes,
} from '../scripts/lib/live-acceptance/safety.mjs';
import { buildProbeScript, classifyLoginState, classifyVerification } from '../scripts/lib/live-acceptance/probe.mjs';
import { loadBrowserPlatforms, extraExpectedTexts, listAllPlatforms } from '../scripts/lib/live-acceptance/platforms.mjs';
import { sanitizePlatformResult, exitCodeFromResults, writeReportFile, uniqueRunStamp } from '../scripts/lib/live-acceptance/report.mjs';
import { runAcceptance, verifyDedicatedExtensionIdentity } from '../scripts/lib/live-acceptance/orchestrate.mjs';
import {
  buildAcceptanceExtensionCopy, patchExtensionBackgroundSource, writeLaunchRecord,
  validateLaunchRecord, createWitness, awaitFreshWitnessReport, parsePortFromWsUrl, newSessionId,
} from '../scripts/lib/live-acceptance/sessions.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_SCRIPT = path.join(REPO_ROOT, 'scripts', 'provider-live-acceptance.mjs');
const CHROME_HELPER = path.join(REPO_ROOT, 'scripts', 'provider-live-chrome.mjs');
const OLD_CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'auto-create-key-check.mjs');
const SIGNAL_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'live-signal-cleanup-fixture.mjs');

function tmpRoot(prefix = 'live-acc-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emitter() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, fn: (...args: unknown[]) => void) { (handlers[event] ||= []).push(fn); },
    emit(event: string, ...args: unknown[]) { (handlers[event] || []).forEach((fn) => fn(...args)); },
  };
}

// ─── Fake read-only browser driver ──────────────────────────────────
// Mirrors the production driver surface. It records every action so tests
// can prove guest/auth-verify only ever emit whitelisted read-only atoms.
// statesByPlatform values may be a single state object (returned for every
// probe) or an ARRAY of states returned in sequence (last one sticks) to
// simulate evolving/unstable pages.
function makeFakeDriver(mode: string, statesByPlatform: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const guard = (action: string) => assertDriverActionAllowed(mode, action);
  const stateFor = (platformId: string): Record<string, unknown> => {
    const states = statesByPlatform[platformId] || [];
    const sequence = Array.isArray(states) ? states : [states];
    counters[platformId] = (counters[platformId] || 0) + 1;
    const index = Math.min(counters[platformId] - 1, sequence.length - 1);
    return { readyState: 'complete', ...(sequence[Math.max(0, index)] || {}) };
  };
  return {
    mode,
    calls,
    async openTab(url: string) {
      guard('open-tab');
      calls.push(`open-tab ${url}`);
      return { id: `tab-${calls.length}`, wsUrl: `ws://127.0.0.1:9/fake/${calls.length}` };
    },
    async probe(_tab: unknown, probeOptions: { platformId: string }) {
      guard('probe');
      calls.push(`probe ${probeOptions.platformId}`);
      return stateFor(probeOptions.platformId);
    },
    async screenshot(_tab: unknown, filePath: string) {
      guard('screenshot');
      calls.push(`screenshot ${filePath}`);
      fs.writeFileSync(filePath, 'PNG-fake');
      return filePath;
    },
    async closeTab() {
      guard('close-tab');
      calls.push('close-tab');
    },
    async dispose(options: { keepOpen?: boolean } = {}) {
      guard('dispose');
      calls.push(`dispose keepOpen=${Boolean(options.keepOpen)}`);
    },
  };
}

const ZHIPU_PLATFORM = {
  id: 'zhipu',
  label: '智谱 AI（国内站）',
  url: 'https://open.bigmodel.cn/apikey/platform',
  expectedTexts: ['新建API Key'],
  maskedPrefix: '',
  reuseOnly: false,
};

const LOGIN_WALL_STATE = {
  url: 'https://open.bigmodel.cn/usercenter/login',
  title: '登录',
  buttons: ['登录 / 注册', '获取验证码'],
  links: [],
  bodyChars: 800,
  hasSmsLoginSurface: true,
  hasLoginAction: true,
};

async function runWithFake(
  mode: string,
  platformConfigs: Array<Record<string, unknown>>,
  statesByPlatform: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>,
  extra: Record<string, unknown> = {},
) {
  const root = tmpRoot();
  const driver = makeFakeDriver(mode, statesByPlatform);
  const result = await runAcceptance({
    mode,
    platformConfigs: platformConfigs as never,
    driver: driver as never,
    root,
    checkout: { revision: 'deadbeefcafe1234', dirty: false },
    sleep: async () => undefined,
    settle: { attempts: 2, intervalMs: 0, spaSettleMs: 0 },
    logger: { log: () => undefined },
    screenshotPolicy: extra.screenshotPolicy as string || 'all',
    ...extra,
  } as never);
  const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
  return { result, report, driver, root };
}

// ─── Argument parsing & safety rejections ───────────────────────────

describe('provider-live-acceptance args', () => {
  it('parses a valid guest invocation with safe defaults', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'guest', '--platform', 'zhipu']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.mode).toBe('guest');
    expect(parsed.platforms).toEqual(['zhipu']);
    expect(parsed.effective?.screenshots).toBe('all');
    expect(parsed.effective?.keepOpen).toBe(false);
  });

  it('accepts --list without --mode (parity with the old checker)', () => {
    const parsed = parseLiveAcceptanceArgs(['--list']);
    expect(parsed.ok).toBe(true);
  });

  it('rejects missing and unknown modes', () => {
    expect(parseLiveAcceptanceArgs(['--platform', 'zhipu']).ok).toBe(false);
    expect(parseLiveAcceptanceArgs(['--mode', 'yolo']).ok).toBe(false);
  });

  it('create-cleanup requires exactly one explicit platform', () => {
    const none = parseLiveAcceptanceArgs(['--mode', 'create-cleanup', '--allow-create-and-cleanup']);
    expect(none.ok).toBe(false);
    expect(none.ok === false && none.error).toContain('必须用 --platform');
    const two = parseLiveAcceptanceArgs(['--mode', 'create-cleanup', '--platform', 'zhipu,openai', '--allow-create-and-cleanup']);
    expect(two.ok).toBe(false);
    expect(two.ok === false && two.error).toContain('一次只允许一个平台');
  });

  it('create-cleanup real run requires the dangerous confirmation switch', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'create-cleanup', '--platform', 'zhipu', '--session', '12345678-abcd-1234-abcd-1234567890ab']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('--allow-create-and-cleanup');
  });

  it('create-cleanup real run requires a one-time acceptance session id', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'create-cleanup', '--platform', 'zhipu', '--allow-create-and-cleanup']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('--session');
    const badSession = parseLiveAcceptanceArgs(['--mode', 'create-cleanup', '--platform', 'zhipu', '--allow-create-and-cleanup', '--session', '../not/a/session']);
    expect(badSession.ok).toBe(false);
  });

  it('rejects raw user-data-dir passthrough and cookie-migration flags', () => {
    for (const argv of [
      ['--mode', 'guest', '--user-data-dir', '/tmp/x'],
      ['--mode', 'guest', '--user-data-dir=/tmp/x'],
      ['--mode', 'guest', '--copy-profile', '/tmp/x'],
      ['--mode', 'guest', '--import', '/tmp/x'],
      ['--mode', 'guest', '--migrate-cookies'],
      ['--mode', 'guest', '--load-cookies=/tmp/cookies.txt'],
      ['--mode', 'guest', '--password', 'hunter2'],
    ]) {
      const parsed = parseLiveAcceptanceArgs(argv);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toContain('拒绝不安全参数');
    }
  });

  it('rejects profile names that are paths or traversals', () => {
    for (const bad of ['../escape', '/abs/path', 'a/b', '..']) {
      expect(isSimpleProfileName(bad)).toBe(false);
    }
    const parsed = parseLiveAcceptanceArgs(['--mode', 'auth-verify', '--profile', '../../Library/Application Support/Google/Chrome']);
    expect(parsed.ok).toBe(false);
  });

  it('guest mode refuses persistent --profile (temp session only)', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'guest', '--profile', 'keepme']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('全新临时');
  });

  it('refuses --with-extension on the acceptance tool (extension loading is launcher-only)', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'auth-verify', '--with-extension']);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('未知参数');
  });

  it('rejects unknown arguments', () => {
    const parsed = parseLiveAcceptanceArgs(['--mode', 'guest', '--frobnicate']);
    expect(parsed.ok).toBe(false);
  });
});

// ─── Profile isolation & redaction primitives ───────────────────────

describe('provider-live-acceptance safety primitives', () => {
  const home = path.join(os.tmpdir(), 'live-safety-home');
  const root = path.join(home, '.okit', 'provider-live-acceptance');

  it('allows profile dirs inside the acceptance root', () => {
    expect(assertSafeProfileDir({ root, dir: path.join(root, 'profiles', 'auth'), platform: 'darwin', home })).toBe(true);
  });

  it('rejects profile dirs outside the acceptance root', () => {
    expect(() => assertSafeProfileDir({ root, dir: '/tmp/elsewhere', platform: 'darwin', home })).toThrow(/验收根目录之外/);
  });

  it('rejects daily Chrome profile dirs on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const daily = dailyProfileHomes(platform, home);
      expect(daily.length).toBeGreaterThan(0);
      for (const dir of daily) {
        expect(() => assertSafeProfileDir({ root, dir, platform, home })).toThrow(/日常浏览器目录/);
      }
    }
  });

  it('rejects a root that would sit inside a daily profile', () => {
    const insideRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'okit-live');
    expect(() => assertSafeProfileDir({ root: insideRoot, dir: path.join(insideRoot, 'profiles', 'auth'), platform: 'darwin', home })).toThrow(/日常浏览器目录/);
  });

  it('findUnsafeArg flags raw passthrough flags in = and space forms', () => {
    expect(findUnsafeArg(['--user-data-dir=/x'])).toBe('--user-data-dir');
    expect(findUnsafeArg(['--cookies=1'])).toBe('--cookies');
    expect(findUnsafeArg(['--mode', 'guest'])).toBeNull();
  });

  it('redacts API keys, JWTs, volcengine AKs, bearer tokens, and long hex', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrst leaked')).not.toContain('sk-abcdefghijklmnopqrst');
    expect(redactSecrets('xai-1234567890abcdef1234')).toContain('[REDACTED]');
    expect(redactSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig')).toContain('[REDACTED]');
    expect(redactSecrets('AKLTdeadbeefdeadbeef1234')).toContain('[REDACTED]');
    expect(redactSecrets('Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redactSecrets('state=0123456789abcdef0123456789abcdef')).toContain('[REDACTED]');
  });

  it('sanitizeUrl strips credentials, query strings, and fragments', () => {
    expect(sanitizeUrl('https://user:pass@example.com/a/b?token=secret#frag')).toBe('https://example.com/a/b');
    expect(sanitizeUrl('not a url')).not.toMatch(/^https?:\/\//);
    expect(sanitizeUrl('javascript:alert(1)')).not.toContain('alert');
  });

  it('preserves Windows-style delegate report paths as local diagnostics', () => {
    const delegateReport = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\live-acc-mr7LEV\\delegate-report.json';
    expect(sanitizePlatformResult({ platform: 'zhipu', status: 'cleanup_failed', delegateReport }).delegateReport)
      .toBe(delegateReport);
  });

  it('enforces the read-only action whitelist per mode', () => {
    expect(assertDriverActionAllowed('guest', 'probe')).toBe(true);
    expect(assertDriverActionAllowed('auth-verify', 'screenshot')).toBe(true);
    expect(() => assertDriverActionAllowed('guest', 'click')).toThrow(/只读白名单/);
    expect(() => assertDriverActionAllowed('auth-verify', 'type')).toThrow(/只读白名单/);
    expect(() => assertDriverActionAllowed('create-cleanup', 'probe')).toThrow(/不允许任何浏览器驱动动作/);
  });

  it('assertProbeScriptReadOnly rejects scripts touching cookies, storage, or events', () => {
    for (const bad of ['document.cookie', 'localStorage.getItem("x")', 'el.click()', 'el.value', 'new WebSocket("ws://x")']) {
      expect(() => assertProbeScriptReadOnly(bad)).toThrow(/禁止令牌/);
    }
  });
});

// ─── Probe builder & state classification mirrors ───────────────────

describe('provider-live-acceptance probe', () => {
  it('builds a script that self-checks as read-only and embeds expected texts', () => {
    const source = buildProbeScript({ expectedTexts: ['新建API Key'], maskedPrefix: 'sk-tp-', platformId: 'zhipu' });
    expect(typeof source).toBe('string');
    expect(assertProbeScriptReadOnly(source)).toBe(true);
    expect(source).toContain('新建API Key');
    expect(source).toContain('sk-tp-');
    // query strings are never read at the source
    expect(source).not.toContain('location.search');
    expect(source).not.toContain('location.hash');
  });

  it('compiles the generated probe (catches template-escaping regressions)', () => {
    // A single-backslash regex inside the builder's template literal once
    // closed the injected regex early and made the probe throw on the live
    // page (注册 is not defined). Compiling without executing catches that
    // class of bug offline.
    const source = buildProbeScript({ expectedTexts: ['新建API Key'], maskedPrefix: 'sk-tp-', platformId: 'zhipu' });
    expect(() => new Function(source)).not.toThrow();
  });

  it('embeds the explicit signed-out action family found by the real sweep', () => {
    const source = buildProbeScript({ expectedTexts: [], maskedPrefix: '', platformId: 'zhipu' });
    // anthropic “Continue with Google”, kimi “注册/登录”, volcengine “立即登录使用”
    expect(source).toContain('continue with (?:google|email|sso');
    expect(source).toContain('立即登录');
    expect(source).toContain('注册');
    // OAuth-style hosts like auth.opencode.ai count as login surfaces
    expect(source).toMatch(/\(login\|auth\|signin\|passport\|accounts\)/);
  });

  it('classifies login surfaces like the product does', () => {
    expect(classifyLoginState({ loginRoute: true })).toBe(true);
    expect(classifyLoginState({ hasSmsLoginSurface: true })).toBe(true);
    expect(classifyLoginState({ hasLoginInput: true, hasLoginAction: true })).toBe(true);
    expect(classifyLoginState({ hasExplicitLoginAction: true })).toBe(true);
    expect(classifyLoginState({ hostIsLoginPage: true })).toBe(true);
    expect(classifyLoginState({ hasLoginAction: true })).toBe(false);
    expect(classifyLoginState({})).toBe(false);
  });

  it('classifies interactive verification with dialog or challenge evidence', () => {
    expect(classifyVerification({ verificationDialog: true })).toBe(true);
    expect(classifyVerification({ verificationPage: true, strongPageVerification: true })).toBe(true);
    expect(classifyVerification({ verificationPage: true })).toBe(false);
    expect(classifyVerification({})).toBe(false);
  });
});

// ─── Platform catalogue single-source ───────────────────────────────

describe('provider-live-acceptance platform catalogue', () => {
  it('derives the browser platform list from AUTO_CREATE_PLATFORMS (31, no cloudflare)', () => {
    const platforms = loadBrowserPlatforms();
    expect(platforms).toHaveLength(31);
    expect(platforms.some((platform) => platform.id === 'cloudflare')).toBe(false);
    for (const platform of platforms) {
      expect(platform.url).toMatch(/^https:\/\//);
    }
    // special-URL platforms resolve through the verification mapping
    expect(platforms.find((platform) => platform.id === 'zhipu')?.url).toContain('open.bigmodel.cn');
    expect(platforms.find((platform) => platform.id === 'volcengine')?.url).toContain('volcengine.com');
  });

  it('reuses strategy-side expected texts instead of duplicating phrases', () => {
    const zhipuExtra = extraExpectedTexts('zhipu');
    expect(zhipuExtra).toContain('新建API Key');
    expect(extraExpectedTexts('openai')).toEqual([]);
  });

  it('flags reuse-only subscription platforms with their masked prefixes', () => {
    const platform = loadBrowserPlatforms().find((item) => item.id === 'tencent-token-plan');
    expect(platform?.reuseOnly).toBe(true);
    expect(platform?.maskedPrefix).toBe('sk-tp-');
  });

  it('listAllPlatforms exposes all 32 platforms with modes', () => {
    expect(listAllPlatforms()).toHaveLength(32);
    expect(listAllPlatforms().filter((platform) => platform.mode === 'api')).toEqual([
      expect.objectContaining({ id: 'cloudflare' }),
    ]);
  });
});

// ─── Report sanitization & exit codes ───────────────────────────────

describe('provider-live-acceptance report', () => {
  it('redacts page summaries and login URLs in platform results', () => {
    const sanitized = sanitizePlatformResult({
      platform: 'zhipu',
      status: 'failed',
      reason: 'page shows sk-abcdefghijklmnopqrst and more',
      loginUrl: 'https://example.com/login?token=abcdef0123456789',
      page: {
        title: 't'.repeat(300),
        buttonsSummary: ['复制', 'sk-abcdefghijklmnopqrst'],
        linksSummary: [],
        bodyChars: 10,
      },
      sneakyExtra: 'should be dropped',
    } as never);
    expect(JSON.stringify(sanitized)).not.toContain('sk-abcdefghijklmnopqrst');
    expect(sanitized.loginUrl).toBe('https://example.com/login');
    expect(sanitized.page?.buttonsSummary[1]).toBe('[REDACTED]');
    expect(sanitized.page?.title).toHaveLength(120);
    expect(JSON.stringify(sanitized)).not.toContain('sneakyExtra');
  });

  it('maps result statuses to exit codes with defect precedence', () => {
    expect(exitCodeFromResults([{ status: 'failed' }])).toBe(1);
    expect(exitCodeFromResults([{ status: 'cleanup_failed' }])).toBe(1);
    expect(exitCodeFromResults([{ status: 'rejected' }])).toBe(1);
    expect(exitCodeFromResults([{ status: 'waiting_for_user' }])).toBe(2);
    expect(exitCodeFromResults([{ status: 'blocked_prerequisite' }])).toBe(2);
    expect(exitCodeFromResults([{ status: 'passed_login_gate' }])).toBe(0);
    expect(exitCodeFromResults([{ status: 'waiting_for_user' }, { status: 'failed' }])).toBe(1);
  });
});

// ─── Orchestration with the fake driver ─────────────────────────────

describe('provider-live-acceptance guest mode', () => {
  it('passes when the login wall is detected, using only read-only atoms', async () => {
    const { result, report, driver } = await runWithFake('guest', [ZHIPU_PLATFORM], { zhipu: LOGIN_WALL_STATE });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_login_gate');
    expect(report.results[0].loginUrl).toBe('https://open.bigmodel.cn/usercenter/login');
    // only whitelisted read-only actions were requested — no create/confirm/click atoms exist on the driver
    for (const call of driver.calls) {
      expect(call).toMatch(/^(open-tab |probe |screenshot |close-tab|dispose )/);
      expect(call).not.toMatch(/click|type|submit|confirm|create-button/i);
    }
    expect(report.results[0].page.buttonsSummary).toContain('登录 / 注册');
  });

  it('reports waiting_for_user (exit 2) when a CAPTCHA appears', async () => {
    const { result, report } = await runWithFake('guest', [ZHIPU_PLATFORM], {
      zhipu: { ...LOGIN_WALL_STATE, verificationDialog: true },
    });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('waiting_for_user');
  });

  it('fails with a locatable report when the redesigned page has nothing recognizable', async () => {
    const { result, report } = await runWithFake('guest', [ZHIPU_PLATFORM], {
      zhipu: { url: 'https://open.bigmodel.cn/apikey/platform', title: '404', buttons: [], links: [], bodyChars: 0 },
    });
    expect(result.exitCode).toBe(1);
    expect(report.results[0].status).toBe('failed');
    expect(report.results[0].reason).toContain('无可识别内容');
    expect(fs.existsSync(result.reportPath)).toBe(true);
    expect(report.checkout.revision).toBe('deadbeefcafe1234');
  });
});

// ─── Real-page regressions from the 2026-08-31 auth-verify report ───
// Each case replays the exact page evidence captured in
// ~/.okit/provider-live-acceptance/reports/20260831171718115-d390-live-auth-verify.json.
// Written BEFORE the implementation change; all five misjudged classes must
// stop being reported as failed / safe_entry_missing.
describe('provider-live-acceptance auth-verify real-page regressions', () => {
  // openai: title "OpenAI Platform", bodyChars 13, zero buttons/links — the
  // screenshot shows the "Signing in…" interstitial. A login-transition page
  // is a handoff state, never a redesign verdict.
  it('login transition ("Signing in…") is waiting_for_user, not safe_entry_missing', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'openai', expectedTexts: ['Create new secret key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      openai: {
        url: 'https://platform.openai.com/api-keys',
        title: 'OpenAI Platform',
        buttons: [],
        links: [],
        bodyChars: 13,
        loginTransition: true,
        matchedExpected: [],
      },
    }, { screenshotPolicy: 'login-only' });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('waiting_for_user');
    expect(report.results[0].reason).toMatch(/登录|跳转/);
    expect(report.results[0].reason).not.toMatch(/疑似.{0,6}改版|safe_entry_missing|需要更新平台策略/);
  });

  // anthropic: "Create Organization | Claude Platform" with Individual /
  // Organization buttons — a first-use workspace chooser. Human prerequisite;
  // the tool must never pick on the user's behalf.
  it('first-use organization chooser is waiting_for_user (human picks, tool never clicks)', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'anthropic', expectedTexts: ['Create Key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      anthropic: {
        url: 'https://platform.claude.com/create',
        title: 'Create Organization | Claude Platform',
        buttons: ['Individual', 'Organization'],
        links: [],
        bodyChars: 286,
        workspaceChooser: true,
        matchedExpected: [],
      },
    }, { screenshotPolicy: 'login-only' });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('waiting_for_user');
    expect(report.results[0].reason).toMatch(/组织|工作区/);
    expect(report.results[0].reason).toMatch(/人工|不代选/);
  });

  // moonshot: signed-in "API Key Management" page reached (screenshot), nav
  // link "API Keys", 1634 body chars — but the create button text is not in
  // the visible summary. Management-page confirmation is a console-level
  // pass, honestly labelled — not a redesign failure.
  it('reached API Key management page passes at console level when entry text is absent', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'moonshot', expectedTexts: ['Create API Key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      moonshot: {
        url: 'https://platform.kimi.ai/console/api-keys',
        title: 'Kimi API Platform',
        buttons: ['Personal', 'Organization Overview', 'You have unread notifications', 'Edit', 'Delete'],
        links: ['User Center', 'API Keys', 'Usage Limits', 'Projects', 'Overview', 'Recharge', 'Billing Details'],
        bodyChars: 1634,
        keyManagementSurface: true,
        matchedExpected: [],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_console_reached');
    expect(report.results[0].reason).toMatch(/管理/);
    expect(report.results[0].reason).not.toMatch(/疑似.{0,6}改版|safe_entry_missing|需要更新平台策略/);
  });

  // volcengine: page title itself is "火山方舟 - API Key 管理" — the same
  // management-page rule upgrades the previous weak pass to an explicit
  // management-level confirmation.
  it('management-page title (火山 API Key 管理) yields management-level confirmation', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'volcengine', expectedTexts: [] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      volcengine: {
        url: 'https://console.volcengine.com/ark/region:cn-beijing/apiKey',
        title: '火山方舟 - API Key 管理',
        buttons: ['全部产品', '火山方舟', '问卷反馈', '收起浮层'],
        links: ['火山引擎'],
        bodyChars: 124,
        keyManagementSurface: true,
        matchedExpected: [],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_console_reached');
    expect(report.results[0].reason).toMatch(/管理/);
  });

  // kimi-coding: loading skeleton (3 chrome buttons, 19 nav links, 159 body
  // chars). An unstable/skeleton page must be reported as not ready — never
  // as "entry missing / platform redesigned".
  it('loading skeleton is page_not_ready, not a redesign verdict', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'kimi-coding', expectedTexts: ['新建 API Key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      'kimi-coding': {
        url: 'https://platform.kimi.com/console/api-keys',
        title: 'Kimi API 开放平台',
        buttons: ['个人组织', '组织概览', '有未读消息'],
        links: ['开发工作台', '用户中心', 'API Key 管理', '用量限制', '账户总览'],
        bodyChars: 159,
        skeletonUi: true,
        matchedExpected: [],
      },
    }, { screenshotPolicy: 'login-only' });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('page_not_ready');
    expect(report.results[0].reason).not.toMatch(/疑似.{0,6}改版|safe_entry_missing|需要更新平台策略/);
  });

  // qianfan-coding: console shell (29 body chars, nav chrome links only, no
  // content). A stable-but-empty shell is still "not ready" for an entry
  // verdict — the page gave us nothing to judge.
  it('empty console shell is page_not_ready, not safe_entry_missing', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'qianfan-coding', expectedTexts: ['点击生成', '复制'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      'qianfan-coding': {
        url: 'https://console.bce.baidu.com/qianfan/resource/token-plan',
        title: '百度千帆 - 百度智能云控制台',
        buttons: [],
        links: ['控制台', '财务', '工单', '文档', '生态', '备案', '购物车'],
        bodyChars: 29,
        matchedExpected: [],
      },
    }, { screenshotPolicy: 'login-only' });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('page_not_ready');
    expect(report.results[0].reason).not.toMatch(/疑似.{0,6}改版|safe_entry_missing|需要更新平台策略/);
  });

  // A page whose probe signature keeps changing within the bounded settle
  // window is unstable: no verdict may be drawn from it.
  it('unstable page (changing probe signatures) is page_not_ready, not failed', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'flaky', expectedTexts: ['新建API Key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      flaky: [
        { url: 'https://flaky.example.com/keys', title: 'Console', buttons: [], links: [], bodyChars: 10, matchedExpected: [] },
        { url: 'https://flaky.example.com/keys', title: 'Console', buttons: ['a'], links: [], bodyChars: 40, matchedExpected: [] },
        { url: 'https://flaky.example.com/keys', title: 'Console', buttons: ['a', 'b'], links: ['x'], bodyChars: 90, matchedExpected: [] },
      ],
    });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('page_not_ready');
  });

  it('keeps failing safe_entry_missing ONLY for a stable signed-in console with configured entries gone', async () => {
    // The genuine redesign reverse case must survive this fix: stable page,
    // console surface present, expected texts configured and absent.
    const platform = { ...ZHIPU_PLATFORM, expectedTexts: ['新建API Key'] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      zhipu: {
        url: 'https://open.bigmodel.cn/apikey/platform',
        title: '全新控制台',
        buttons: ['帮助', '文档'],
        links: ['首页'],
        bodyChars: 1200,
        consoleSurface: true,
        matchedExpected: [],
      },
    });
    expect(result.exitCode).toBe(1);
    expect(report.results[0].status).toBe('failed');
    expect(report.results[0].reason).toContain('safe_entry_missing');
  });
});

describe('provider-live-acceptance auth-verify mode', () => {
  it('reports waiting_for_user with a sanitized login URL when not logged in', async () => {
    const { result, report, driver } = await runWithFake('auth-verify', [ZHIPU_PLATFORM], {
      zhipu: { ...LOGIN_WALL_STATE, url: 'https://open.bigmodel.cn/usercenter/login?next=%2Fapikey%23token%3Dabc' },
    });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('waiting_for_user');
    expect(report.results[0].loginUrl).toBe('https://open.bigmodel.cn/usercenter/login');
    expect(driver.calls.some((call) => call.startsWith('dispose keepOpen=true'))).toBe(true);
    for (const call of driver.calls) {
      expect(call).toMatch(/^(open-tab |probe |screenshot |close-tab|dispose )/);
    }
  });

  it('passes when the signed-in console shows the expected safe entry (no clicks)', async () => {
    const { result, report, driver } = await runWithFake('auth-verify', [ZHIPU_PLATFORM], {
      zhipu: {
        url: 'https://open.bigmodel.cn/apikey/platform',
        title: 'API Keys',
        buttons: ['新建API Key', '帮助'],
        links: ['控制台'],
        bodyChars: 5000,
        consoleSurface: true,
        matchedExpected: ['新建API Key'],
      },
    }, { screenshotPolicy: 'login-only' });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_entry_found');
    expect(report.results[0].reason).toContain('新建API Key');
    // login-only screenshots: a healthy signed-in console is NOT captured
    expect(driver.calls.some((call) => call.startsWith('screenshot'))).toBe(false);
  });

  it('fails (safe_entry_missing) when the signed-in page lost its expected entry — the redesign reverse case', async () => {
    const { result, report } = await runWithFake('auth-verify', [ZHIPU_PLATFORM], {
      zhipu: {
        url: 'https://open.bigmodel.cn/apikey/platform',
        title: '全新控制台',
        buttons: ['帮助', '文档'],
        links: ['首页'],
        bodyChars: 120,
        consoleSurface: true,
        matchedExpected: [],
      },
    });
    expect(result.exitCode).toBe(1);
    expect(report.results[0].status).toBe('failed');
    expect(report.results[0].reason).toContain('safe_entry_missing');
  });

  it('blocked_prerequisite for reuse-only plans without a masked key', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'tencent-token-plan', reuseOnly: true, maskedPrefix: 'sk-tp-', expectedTexts: [] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      'tencent-token-plan': { url: 'https://console.cloud.tencent.com/tokenhub/tokenplan', buttons: ['概览'], bodyChars: 900, consoleSurface: true, maskedPrefixFound: false },
    });
    expect(result.exitCode).toBe(2);
    expect(report.results[0].status).toBe('blocked_prerequisite');
  });

  it('passes when the masked subscription key prefix is visible', async () => {
    const platform = { ...ZHIPU_PLATFORM, id: 'tencent-token-plan', reuseOnly: true, maskedPrefix: 'sk-tp-', expectedTexts: [] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      'tencent-token-plan': { url: 'https://console.cloud.tencent.com/tokenhub/tokenplan', buttons: ['复制'], bodyChars: 900, consoleSurface: true, maskedPrefixFound: true },
    });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_entry_found');
    expect(report.results[0].reason).toContain('掩码');
  });

  it('weak pass (console reached) for platforms without configured entry texts', async () => {
    const platform = { ...ZHIPU_PLATFORM, expectedTexts: [] };
    const { result, report } = await runWithFake('auth-verify', [platform], {
      zhipu: { url: ZHIPU_PLATFORM.url, buttons: ['概览'], bodyChars: 800, consoleSurface: true },
    });
    expect(result.exitCode).toBe(0);
    expect(report.results[0].status).toBe('passed_console_reached');
    expect(report.results[0].reason).toContain('弱通过');
  });

  it('redacts secrets that appear in captured button text', async () => {
    const { report } = await runWithFake('auth-verify', [ZHIPU_PLATFORM], {
      zhipu: { ...LOGIN_WALL_STATE, buttons: ['登录', 'sk-abcdefghijklmnopqrst'] },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrst');
    expect(report.results[0].page.buttonsSummary).toContain('[REDACTED]');
  });
});

describe('provider-live-acceptance dry-run', () => {
  it('guest dry-run plans without ever touching a driver', async () => {
    const root = tmpRoot();
    const boobyTrap = new Proxy({}, {
      get() { throw new Error('dry-run 不应触碰浏览器驱动'); },
    });
    const result = await runAcceptance({
      mode: 'guest',
      dryRun: true,
      platformConfigs: [ZHIPU_PLATFORM] as never,
      driver: boobyTrap as never,
      root,
      checkout: { revision: 'deadbeefcafe1234', dirty: false },
      logger: { log: () => undefined },
    } as never);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('dry_run');
    expect(report.dryRun).toBe(true);
  });
});

describe('provider-live-acceptance create-cleanup mode', () => {
  const CC_PLATFORM = { id: 'zhipu', label: '智谱 AI（国内站）', mode: 'browser' };
  const SESSION_ID = '12345678-abcd-1234-abcd-1234567890ab';
  const baseOptions = {
    mode: 'create-cleanup',
    platformConfigs: [CC_PLATFORM],
    root: '',
    checkout: { revision: 'deadbeefcafe1234', dirty: false },
    logger: { log: () => undefined },
    delegateScriptPath: '/nonexistent/auto-create-key-check.mjs',
    repoRoot: REPO_ROOT,
    sessionId: SESSION_ID,
    witnessTimeoutMs: 50,
  };
  const healthy = () => new Response(JSON.stringify({ available: true }), { status: 200 });

  // Identity deps that simulate a fully verified dedicated-Chrome session.
  function okIdentityDeps(overrides: Record<string, unknown> = {}) {
    return {
      readRecord: async ({ sessionId }: { sessionId: string }) => ({
        sessionId, profileDir: '/safe', debugPort: 9333, witnessPort: 9341, pid: 1,
        extensionCopyDir: '/safe-copy', createdAt: new Date().toISOString(),
      }),
      validateRecord: async () => ({ ok: true, checks: {} }),
      probeCdp: async () => true,
      startWitness: async () => ({ stop: async () => undefined }),
      awaitReport: async () => ({ sessionId: SESSION_ID, wsUrl: 'ws://localhost:3780/ws/extension', wsState: 1 }),
      ...overrides,
    };
  }

  it('rejects a real run without the dangerous double confirmation', async () => {
    const root = tmpRoot();
    let fetched = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      fetchImpl: async () => { fetched += 1; return new Response('{}'); },
    } as never);
    expect(result.exitCode).toBe(1);
    expect(fetched).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('rejected');
    expect(report.results[0].reason).toContain('--allow-create-and-cleanup');
  });

  it('dry-run lists the full create→delete plan without server, spawn, or identity calls', async () => {
    const root = tmpRoot();
    let fetched = 0;
    let spawned = 0;
    const identityDeps = okIdentityDeps({
      readRecord: async () => { throw new Error('dry-run 不得读取会话'); },
      startWitness: async () => { throw new Error('dry-run 不得启动 witness'); },
    });
    const result = await runAcceptance({
      ...baseOptions, root, dryRun: true,
      fetchImpl: async () => { fetched += 1; return new Response('{}'); },
      spawnImpl: () => { spawned += 1; throw new Error('dry-run 不得 spawn'); },
      identityDeps,
    } as never);
    expect(result.exitCode).toBe(0);
    expect(fetched).toBe(0);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    const steps = report.results[0].steps.map((step: { step: string }) => step.step);
    expect(steps).toEqual(['verify-server', 'verify-dedicated-chrome', 'verify-extension-session', 'create', 'read', 'delete', 'confirm-gone']);
  });

  it('hard-disabled by default: a fully verified session still refuses with zero fetch and zero delegation', async () => {
    const root = tmpRoot();
    let fetched = 0;
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      // NOTE: no createCleanupRealRunEnabled here — the CLI never passes it.
      fetchImpl: async () => { fetched += 1; return healthy(); },
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps(),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(fetched).toBe(0);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('disabled');
    expect(report.results[0].reason).toContain('单扩展槽位竞态未消除');
    expect(report.results[0].reason).toContain('隔离 VM');
  });

  it('blocked_prerequisite when the OKIT server/extension is not reachable', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: async () => { throw new Error('connection refused'); },
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
    } as never);
    expect(result.exitCode).toBe(2);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('blocked_prerequisite');
  });

  it('refuses (exit 1, no delegation) when only an ordinary/unknown extension is online — no session given', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root, sessionId: '',
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps(),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('unverified_extension_identity');
    expect(report.results[0].reason).toContain('--session');
  });

  it('refuses when the session record is missing', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps({ readRecord: async () => null }),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('unverified_extension_identity');
    expect(report.results[0].reason).toContain('找不到验收会话记录');
  });

  it('refuses when the launch record fails validation', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps({ validateRecord: async () => ({ ok: false, reason: '会话记录的 profile 目录未通过隔离校验' }) }),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].reason).toContain('未通过隔离校验');
  });

  it('refuses when the dedicated Chrome CDP is dead', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps({ probeCdp: async () => false }),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].reason).toContain('CDP');
  });

  it('refuses on witness timeout — an online ordinary extension never reports a session heartbeat', async () => {
    const root = tmpRoot();
    let spawned = 0;
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl: () => { spawned += 1; throw new Error('不得 spawn'); },
      identityDeps: okIdentityDeps({ awaitReport: async () => null }),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawned).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('unverified_extension_identity');
    expect(report.results[0].reason).toContain('心跳证明');
  });

  it('propagates a delegate cleanup failure as exit 1 and stops (single platform, one spawn)', async () => {
    const root = tmpRoot();
    const delegateReportPath = path.join(root, 'delegate-report.json');
    fs.writeFileSync(delegateReportPath, JSON.stringify({
      results: [{
        id: 'zhipu',
        status: 'cleanup_failed',
        cleanup: 'failed',
        testName: 'OKIT_AUTOCHECK_ZHIPU_20260831120000',
        createdName: 'OKIT_AUTOCHECK_ZHIPU_20260831120000',
        reason: '删除失败（HTTP 500）：unknown error',
      }],
    }));
    const spawnCalls: string[][] = [];
    const spawnImpl = () => {
      const child: Record<string, unknown> = emitter();
      (child as { stdout: ReturnType<typeof emitter> }).stdout = emitter();
      (child as { stderr: ReturnType<typeof emitter> }).stderr = emitter();
      spawnCalls.push(['spawned']);
      setTimeout(() => {
        (child as { stdout: emitter }).stdout.emit('data', `cleanup_failed\tzhipu\nreport\t${delegateReportPath}\n`);
        child.emit('close', 1);
      }, 0);
      return child;
    };
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl,
      identityDeps: okIdentityDeps(),
    } as never);
    expect(result.exitCode).toBe(1);
    expect(spawnCalls).toHaveLength(1);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('cleanup_failed');
    expect(report.results[0].createdName).toBe('OKIT_AUTOCHECK_ZHIPU_20260831120000');
    expect(report.results[0].delegateReport).toBe(delegateReportPath);
  });

  it('maps a delegate pass to exit 0 after identity verification', async () => {
    const root = tmpRoot();
    const delegateReportPath = path.join(root, 'delegate-report.json');
    fs.writeFileSync(delegateReportPath, JSON.stringify({
      results: [{ id: 'zhipu', status: 'passed', cleanup: 'deleted', testName: 'T', createdName: 'T' }],
    }));
    const spawnImpl = () => {
      const child: Record<string, unknown> = emitter();
      (child as { stdout: emitter }).stdout = emitter();
      (child as { stderr: emitter }).stderr = emitter();
      setTimeout(() => {
        (child as { stdout: emitter }).stdout.emit('data', `passed\tzhipu\nreport\t${delegateReportPath}\n`);
        child.emit('close', 0);
      }, 0);
      return child;
    };
    const result = await runAcceptance({
      ...baseOptions, root,
      allowCreateAndCleanup: true,
      createCleanupRealRunEnabled: true,
      fetchImpl: healthy,
      spawnImpl,
      identityDeps: okIdentityDeps(),
    } as never);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
    expect(report.results[0].status).toBe('passed');
  });
});

// Snapshot of the real built extension (extension/dist is git-ignored, so CI
// checkouts have no dist — see tests/fixtures/extension-dist-sample/README.md).
const EXT_SAMPLE = path.join(REPO_ROOT, 'tests', 'fixtures', 'extension-dist-sample');
const REAL_EXTENSION_DIST = path.join(REPO_ROOT, 'extension', 'dist', 'background.js');

describe('provider-live-acceptance session binding (P0 primitives)', () => {
  it('builds a patched copy of the extension snapshot and the result is valid ESM', { timeout: 30000 }, async () => {
    const root = tmpRoot('live-copy-');
    const sessionId = newSessionId();
    const copyDir = path.join(root, 'copy');
    const built = await buildAcceptanceExtensionCopy({
      sourceDir: EXT_SAMPLE,
      destDir: copyDir,
      sessionId,
      witnessPort: 9341,
    });
    expect(built.patched).toEqual({ hello: 1, authOk: 1, keepalive: 1 });
    const background = fs.readFileSync(path.join(copyDir, 'dist', 'background.js'), 'utf8');
    expect(background).toContain(sessionId);
    expect(background).toContain('acceptanceSession: globalThis.__OKIT_ACCEPTANCE__.sessionId');
    expect(background).toContain("reportAcceptance('acceptance-heartbeat')");
    expect(fs.existsSync(path.join(copyDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(copyDir, 'OKIT_ACCEPTANCE_SESSION.json'))).toBe(true);
    // The patched background must still be valid ESM (node --check on .mjs).
    const mjsPath = path.join(root, 'background-check.mjs');
    fs.copyFileSync(path.join(copyDir, 'dist', 'background.js'), mjsPath);
    const check = spawnSync(process.execPath, ['--check', mjsPath], { encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  it('patches a CRLF checkout of the extension snapshot', () => {
    const source = fs.readFileSync(path.join(EXT_SAMPLE, 'dist', 'background.js'), 'utf8');
    const crlfSource = source.replace(/\r\n|\r|\n/g, '\r\n');
    const patched = patchExtensionBackgroundSource(crlfSource, {
      sessionId: 'abcd1234-0',
      witnessPort: 9341,
    });
    expect(patched.counts).toEqual({ hello: 1, authOk: 1, keepalive: 1 });
    expect(patched.patched).not.toContain('\r\n');
  });

  it('fails closed when the source lacks the built dist', async () => {
    const root = tmpRoot('live-nosrc-');
    const empty = path.join(root, 'empty-ext');
    fs.mkdirSync(path.join(empty, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(empty, 'manifest.json'), '{}');
    await expect(buildAcceptanceExtensionCopy({
      sourceDir: empty, destDir: path.join(root, 'copy'), sessionId: newSessionId(), witnessPort: 9341,
    })).rejects.toThrow(/build-extension/);
  });

  it('patch anchors stay in sync with the real built extension when it exists', () => {
    // CI checkouts do not build extension/dist before npm test, so this drift
    // guard runs wherever the built artifact is present (dev machines and the
    // build environment). The snapshot fixture keeps the offline coverage.
    if (!fs.existsSync(REAL_EXTENSION_DIST)) return;
    const real = fs.readFileSync(REAL_EXTENSION_DIST, 'utf8');
    const snapshot = fs.readFileSync(path.join(EXT_SAMPLE, 'dist', 'background.js'), 'utf8');
    expect(real).toBe(snapshot);
  });

  it('fails closed when patch anchors are missing or already applied', () => {
    expect(() => patchExtensionBackgroundSource('const x = 1;', { sessionId: 'abcd1234-0', witnessPort: 9341 })).toThrow(/锚点/);
    const real = fs.readFileSync(path.join(EXT_SAMPLE, 'dist', 'background.js'), 'utf8');
    const once = patchExtensionBackgroundSource(real, { sessionId: 'abcd1234-0', witnessPort: 9341 });
    expect(() => patchExtensionBackgroundSource(once.patched, { sessionId: 'abcd1234-0', witnessPort: 9341 })).toThrow(/不得重复打补丁/);
  });

  it('validates launch records against isolation, age, and copy integrity', { timeout: 30000 }, async () => {
    const root = tmpRoot('live-rec-');
    const sessionId = newSessionId();
    const profileDir = path.join(root, 'profiles', 'auth');
    const copyDir = path.join(root, 'copy');
    const built = await buildAcceptanceExtensionCopy({
      sourceDir: EXT_SAMPLE,
      destDir: copyDir,
      sessionId,
      witnessPort: 9341,
    });
    const { record } = await writeLaunchRecord({
      root, sessionId, profileDir, debugPort: 9333, witnessPort: 9341, pid: process.pid, extensionCopyDir: copyDir,
    });
    await expect(validateLaunchRecord(record, { root })).resolves.toMatchObject({ ok: true });

    const outside = await validateLaunchRecord({ ...record, profileDir: '/tmp/daily-chrome' }, { root });
    expect(outside.ok).toBe(false);
    expect(outside.reason).toContain('未通过隔离校验');

    const stale = await validateLaunchRecord(
      { ...record, createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() },
      { root },
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toContain('过期');

    const noCopy = await validateLaunchRecord({ ...record, extensionCopyDir: path.join(root, 'missing') }, { root });
    expect(noCopy.ok).toBe(false);
    expect(noCopy.reason).toContain('副本缺失');
  });

  it('witness stores reports locally and freshness filters reject stale/closed/wrong-port reports', { timeout: 15000 }, async () => {
    const witness = createWitness({ port: 0 });
    const addr = await witness.start();
    const sessionId = newSessionId();
    const post = async (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${addr.port}/acceptance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post({ sessionId, wsUrl: 'ws://localhost:3780/ws/extension', wsState: 1 })).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${addr.port}/other`, { method: 'POST' })).status).toBe(404);
    expect(parsePortFromWsUrl('ws://localhost:3780/ws/extension')).toBe(3780);

    const match = await awaitFreshWitnessReport({ witness, sessionId, expectWsPort: 3780, maxWaitMs: 300, pollMs: 25 });
    expect(match?.sessionId).toBe(sessionId);

    const wrongPort = await awaitFreshWitnessReport({ witness, sessionId, expectWsPort: 3781, maxWaitMs: 120, pollMs: 20 });
    expect(wrongPort).toBeNull();

    // stale report: receivedAt far in the past via injected clock
    const staleWitness = {
      lastReport: () => ({ sessionId, wsUrl: 'ws://localhost:3780/ws/extension', wsState: 1, receivedAt: Date.now() - 60000 }),
    };
    expect(await awaitFreshWitnessReport({ witness: staleWitness as never, sessionId, expectWsPort: 3780, maxWaitMs: 50, pollMs: 10 })).toBeNull();

    const closedWitness = {
      lastReport: () => ({ sessionId, wsUrl: 'ws://localhost:3780/ws/extension', wsState: 0, receivedAt: Date.now() }),
    };
    expect(await awaitFreshWitnessReport({ witness: closedWitness as never, sessionId, expectWsPort: 3780, maxWaitMs: 50, pollMs: 10 })).toBeNull();
    await witness.stop();
  });

  it('verifyDedicatedExtensionIdentity returns the report on the happy path', async () => {
    const root = tmpRoot();
    const outcome = await verifyDedicatedExtensionIdentity({
      sessionId: 'sess-happy-1',
      root,
      baseUrl: 'http://127.0.0.1:3780',
      fetchImpl: async () => new Response('{}'),
      identityDeps: okIdentityStub(),
    });
    expect(outcome.ok).toBe(true);
  });
});

function okIdentityStub() {
  return {
    readRecord: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
    validateRecord: async () => ({ ok: true, checks: {} }),
    probeCdp: async () => true,
    startWitness: async () => ({ stop: async () => undefined }),
    awaitReport: async () => ({ sessionId: 'sess-happy-1', wsUrl: 'ws://localhost:3780/ws/extension', wsState: 1 }),
  };
}

describe('provider live-acceptance report collision (P1)', () => {
  it('two same-stamp runs into the SAME root produce two intact reports (no overwrite)', async () => {
    // Reproduces the reviewer's scenario exactly: one shared root (one
    // reports/ directory) and one shared second-precision stamp. Separate
    // tmpRoot()s would never collide at all and prove nothing about the fix.
    const sharedStamp = '20260831155122';
    const root = tmpRoot();
    const openaiPlatform = { ...ZHIPU_PLATFORM, id: 'openai', label: 'OpenAI', expectedTexts: [] };
    const first = await runAcceptance({
      mode: 'guest',
      dryRun: true,
      platformConfigs: [ZHIPU_PLATFORM] as never,
      root,
      checkout: { revision: 'deadbeefcafe1234', dirty: false },
      logger: { log: () => undefined },
      runStamp: sharedStamp,
    } as never);
    const second = await runAcceptance({
      mode: 'guest',
      dryRun: true,
      platformConfigs: [openaiPlatform] as never,
      root,
      checkout: { revision: 'deadbeefcafe1234', dirty: false },
      logger: { log: () => undefined },
      runStamp: sharedStamp,
    } as never);
    // the exclusive-create retry must have renamed the second write instead
    // of overwriting the first — both files survive with their OWN content
    expect(second.reportPath).not.toBe(first.reportPath);
    const firstReport = JSON.parse(fs.readFileSync(first.reportPath, 'utf8'));
    const secondReport = JSON.parse(fs.readFileSync(second.reportPath, 'utf8'));
    expect(firstReport.requestedPlatforms).toEqual(['zhipu']);
    expect(secondReport.requestedPlatforms).toEqual(['openai']);
    // exactly two guest reports exist in the shared directory — run 1's
    // evidence was not clobbered by run 2
    const reportFiles = fs.readdirSync(path.join(root, 'reports')).filter((name) => name.endsWith('-live-guest.json'));
    expect(reportFiles).toHaveLength(2);
    expect(reportFiles).toContain(path.basename(first.reportPath));
    expect(reportFiles).toContain(path.basename(second.reportPath));
  });

  it('writeReportFile never overwrites an existing report (exclusive create + retry)', async () => {
    const root = tmpRoot();
    const firstPath = await writeReportFile(root, { mode: 'guest', results: [] } as never, 'dup-stamp');
    const secondPath = await writeReportFile(root, { mode: 'guest', results: [], marker: 2 } as never, 'dup-stamp');
    expect(secondPath).not.toBe(firstPath);
    const first = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
    const second = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    expect(first.marker).toBeUndefined();
    expect(second.marker).toBe(2);
  });

  it('default stamps carry millisecond + random components', async () => {
    // A 16-bit random suffix reduces same-millisecond collisions but cannot
    // mathematically eliminate birthday collisions. Exclusive-create retry in
    // writeReportFile is the no-overwrite guarantee and has its own test.
    const stamp = uniqueRunStamp();
    expect(stamp).toMatch(/^\d{17}-[0-9a-f]{4}$/);
  });
});

describe('provider live-acceptance signal cleanup (P1)', { timeout: 20000 }, () => {
  // Windows cannot deliver SIGINT/SIGTERM to a child via process.kill with
  // POSIX semantics (handlers are not invoked), so this real-signal fixture
  // runs only on POSIX CI legs.
  it.skipIf(process.platform === 'win32')('SIGINT runs best-effort dispose, removes the temp profile, exits 130', () => {
    const run = spawnSync(process.execPath, [SIGNAL_FIXTURE, 'SIGINT'], { encoding: 'utf8' });
    expect(run.status).toBe(130);
    expect(run.stdout).toContain('DISPOSED');
    const readyLine = run.stdout.split('\n').find((line) => line.startsWith('READY '));
    expect(readyLine).toBeTruthy();
    expect(fs.existsSync(readyLine!.slice('READY '.length).trim())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('SIGTERM disposes and exits 143', () => {
    const run = spawnSync(process.execPath, [SIGNAL_FIXTURE, 'SIGTERM'], { encoding: 'utf8' });
    expect(run.status).toBe(143);
    expect(run.stdout).toContain('DISPOSED');
  });
});

// ─── Real CLI subprocess rejections (offline, isolated HOME) ────────

describe('provider live-acceptance CLI subprocess', { timeout: 30000 }, () => {
  function runNode(script: string, args: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cli-home-'));
    return spawnSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // Belt and suspenders: even a guard regression cannot reach a live
        // OKIT server or a real debugging port from these subprocesses.
        OKIT_AUTO_CREATE_BASE_URL: 'http://127.0.0.1:9',
        OKIT_LIVE_DEBUG_PORT: '39777',
        OKIT_LIVE_CHROME_BIN: '',
      },
    });
  }

  it('guest --dry-run produces a plan report without accessing external resources', () => {
    const run = runNode(CLI_SCRIPT, ['--mode', 'guest', '--dry-run', '--platform', 'zhipu']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('dry_run\tzhipu');
    const reportLine = run.stdout.split('\n').find((line) => line.startsWith('report\t'));
    expect(reportLine).toBeTruthy();
    const reportPath = reportLine!.slice('report\t'.length).trim();
    expect(reportPath).toContain(path.join('.okit', 'provider-live-acceptance', 'reports'));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.mode).toBe('guest');
    expect(report.dryRun).toBe(true);
    expect(report.checkout.revision).toMatch(/^[0-9a-f]{7,40}$/);
    expect(report.results[0]).toMatchObject({ platform: 'zhipu', status: 'dry_run' });
    // no screenshot/browser artifacts were produced
    expect(fs.existsSync(path.join(path.dirname(reportPath), '..', 'screenshots'))).toBe(false);
  });

  it('refuses create-cleanup without the dangerous confirmation (non-zero exit)', () => {
    const run = runNode(CLI_SCRIPT, ['--mode', 'create-cleanup', '--platform', 'zhipu']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--allow-create-and-cleanup');
  });

  it('refuses create-cleanup with the confirmation but no acceptance session (non-zero exit)', () => {
    const run = runNode(CLI_SCRIPT, ['--mode', 'create-cleanup', '--platform', 'zhipu', '--allow-create-and-cleanup']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--session');
    expect(run.stderr).toContain('专用 Chrome');
  });

  it('refuses create-cleanup with every parameter supplied — real creation is hard-disabled (exit 1)', () => {
    const run = runNode(CLI_SCRIPT, [
      '--mode', 'create-cleanup', '--platform', 'zhipu',
      '--allow-create-and-cleanup', '--session', '12345678-abcd-1234-abcd-1234567890ab',
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('disabled\tzhipu');
    expect(run.stdout).toContain('禁用');
    // no delegation happened: no delegate exit line was printed
    expect(run.stdout).not.toContain('delegate-exit');
  });

  it('refuses raw --user-data-dir attempts (non-zero exit)', () => {
    const run = runNode(CLI_SCRIPT, ['--mode', 'guest', '--user-data-dir', '/tmp/evil']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('拒绝不安全参数');
  });

  it('refuses api-mode platforms (cloudflare) in guest/auth-verify', () => {
    const run = runNode(CLI_SCRIPT, ['--mode', 'guest', '--platform', 'cloudflare']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('mode 是 api');
  });

  it('provider-live-chrome refuses a daily-profile --profile value (non-zero exit)', () => {
    const daily = path.join(os.tmpdir(), 'live-cli-home-x', 'Library', 'Application Support', 'Google', 'Chrome');
    const run = runNode(CHROME_HELPER, ['--profile', daily]);
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toMatch(/简单标识符|拒绝/);
  });

  it('provider-live-chrome refuses cookie-migration flags (non-zero exit)', () => {
    const run = runNode(CHROME_HELPER, ['--copy-profile', '/tmp/daily']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('拒绝不安全参数');
  });

  it('hardened auto-create-key-check refuses implicit batch creation', () => {
    const run = runNode(OLD_CHECK_SCRIPT, []);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('拒绝执行');
    expect(run.stderr).toContain('未指定平台');
  });

  it('hardened auto-create-key-check refuses a real run without the dangerous switch', () => {
    const run = runNode(OLD_CHECK_SCRIPT, ['zhipu']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--allow-create-and-cleanup');
  });

  it('hardened auto-create-key-check still supports --list and explicit dry-run plans', () => {
    const listRun = runNode(OLD_CHECK_SCRIPT, ['--list']);
    expect(listRun.status).toBe(0);
    expect(listRun.stdout.trim().split('\n')).toHaveLength(32);

    const dryRun = runNode(OLD_CHECK_SCRIPT, ['--dry-run', 'zhipu']);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('dry_run\tzhipu');
    // dry-run of the old checker writes no browser/platform artifacts beyond its report
    const reportLine = dryRun.stdout.split('\n').find((line) => line.startsWith('report\t'));
    expect(reportLine).toBeTruthy();
  });
});
