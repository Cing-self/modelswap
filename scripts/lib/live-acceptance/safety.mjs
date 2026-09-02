// Pure safety primitives for the provider live-acceptance tool.
//
// Everything in this module is side-effect free so the offline test suite can
// prove the security boundaries (daily-profile rejection, cookie-migration
// rejection, read-only driver whitelist, secret redaction) without a browser.

import path from 'node:path';

export const MODES = ['guest', 'auth-verify', 'create-cleanup'];

// Per-mode default subdirectory names under the acceptance root. guest always
// uses a throwaway per-run directory, so it has no persistent default here.
export const DEFAULT_PROFILE_BY_MODE = {
  guest: '',
  'auth-verify': 'auth',
  'create-cleanup': 'auth',
};

// Chromium-family default profile directories per platform. The structural
// rule is stronger than this list (acceptance profiles must live inside the
// acceptance root), but the explicit blacklist is defense in depth and keeps
// honest mistake messages actionable.
export function dailyProfileHomes(platform, home) {
  const osPlatform = platform || process.platform;
  const homeDir = home || '';
  if (!homeDir) return [];
  if (osPlatform === 'darwin') {
    return [
      path.join(homeDir, 'Library/Application Support/Google/Chrome'),
      path.join(homeDir, 'Library/Application Support/Google/Chrome Canary'),
      path.join(homeDir, 'Library/Application Support/Chromium'),
      path.join(homeDir, 'Library/Application Support/Microsoft Edge'),
      path.join(homeDir, 'Library/Application Support/BraveSoftware/Brave-Browser'),
      path.join(homeDir, 'Library/Application Support/Vivaldi'),
    ];
  }
  if (osPlatform === 'win32') {
    return [
      path.join(homeDir, 'AppData/Local/Google/Chrome/User Data'),
      path.join(homeDir, 'AppData/Local/Google/Chrome Beta/User Data'),
      path.join(homeDir, 'AppData/Local/Chromium/User Data'),
      path.join(homeDir, 'AppData/Local/Microsoft/Edge/User Data'),
      path.join(homeDir, 'AppData/Local/BraveSoftware/Brave-Browser/User Data'),
    ];
  }
  return [
    path.join(homeDir, '.config/google-chrome'),
    path.join(homeDir, '.config/chromium'),
    path.join(homeDir, '.config/microsoft-edge'),
    path.join(homeDir, '.var/app/com.google.Chrome/config/google-chrome'),
    path.join(homeDir, '.var/app/com.microsoft.Edge/config/microsoft-edge'),
  ];
}

// Profile names are plain identifiers, never paths. This makes it impossible
// to point the acceptance tool at an arbitrary (daily) browser directory
// through --profile.
export function isSimpleProfileName(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.includes('..');
}

// Long flags that would either redirect Chrome at foreign user data or move
// cookie/session material around. Any occurrence is a hard refusal.
const FORBIDDEN_ARG_FLAGS = [
  '--user-data-dir',
  '--profile-directory',
  '--chrome-user-data',
  '--use-default-profile',
  '--daily-profile',
  '--copy-profile',
  '--from-profile',
  '--import',
  '--import-from',
  '--migrate-cookies',
  '--load-cookies',
  '--restore-cookies',
  '--export-cookies',
  '--cookies',
  '--password',
  '--passwords',
];

export function findUnsafeArg(argv) {
  for (const token of argv || []) {
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const bare = token.split('=')[0];
    if (FORBIDDEN_ARG_FLAGS.includes(bare)) return bare;
  }
  return null;
}

function isInsideOrEqual(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Structural profile isolation. The launch directory must live inside the
 * acceptance root and must never be, contain, or sit inside a daily browser
 * profile directory. Both sides of the containment are checked so a misplaced
 * root is caught too.
 */
export function assertSafeProfileDir({ root, dir, platform, home }) {
  if (!root || !dir) throw new Error('缺少验收根目录或 profile 目录');
  // Daily-profile overlap first: it is the more specific (and more alarming)
  // diagnosis when both rules would match.
  for (const target of [root, dir]) {
    for (const daily of dailyProfileHomes(platform, home)) {
      if (isInsideOrEqual(target, daily) || isInsideOrEqual(daily, target)) {
        throw new Error(`拒绝触碰日常浏览器目录：${target} 与 ${daily} 重叠；验收工具绝不读取/复制/迁移日常 Chrome 数据`);
      }
    }
  }
  if (!isInsideOrEqual(dir, root)) {
    throw new Error(`拒绝使用验收根目录之外的 profile：${dir}（必须位于 ${root} 内）`);
  }
  return true;
}

// ─── Read-only driver action whitelist ──────────────────────────────
// guest/auth-verify drive a dedicated Chrome over CDP and may only use
// navigation + read-only probing atoms. create-cleanup never drives a browser
// itself (it delegates to the OKIT server flow), so it allows none.
export const READONLY_DRIVER_ACTIONS = new Set([
  'ensure-launched',
  'open-tab',
  'probe',
  'screenshot',
  'close-tab',
  'list-tabs',
  'dispose',
]);

export function assertDriverActionAllowed(mode, action) {
  if (mode === 'guest' || mode === 'auth-verify') {
    if (!READONLY_DRIVER_ACTIONS.has(action)) {
      throw new Error(`模式 ${mode} 不允许浏览器动作 “${action}”（只读白名单：${[...READONLY_DRIVER_ACTIONS].join(', ')}）`);
    }
    return true;
  }
  throw new Error(`模式 ${mode} 不允许任何浏览器驱动动作（${action}）；该模式仅通过委托流程执行`);
}

// The injected page probe must stay read-only: no cookies/storage access, no
// input value reads, no synthetic events, no mutation. The builder calls this
// on its own output and the tests re-assert it, so a future edit that adds a
// forbidden token fails before it ever reaches a real page.
const PROBE_FORBIDDEN_TOKENS = [
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator.clipboard',
  'XMLHttpRequest',
  'dispatchEvent',
  '.click(',
  '.submit(',
  '.focus(',
  '.select(',
  '.removeChild',
  '.remove(',
  '.value',
  'fetch(',
  'WebSocket',
  'chrome.',
  'requestHeaders',
  'append(',
];

export function assertProbeScriptReadOnly(source) {
  const text = String(source || '');
  for (const token of PROBE_FORBIDDEN_TOKENS) {
    if (text.includes(token)) {
      throw new Error(`只读探针脚本包含禁止令牌 “${token}”；探针不得读取 Cookie/存储/输入值或触发任何页面动作`);
    }
  }
  return true;
}

// ─── Redaction ──────────────────────────────────────────────────────
// Same token families as scripts/auto-create-key-check.mjs plus long hex runs
// (OAuth state / anti-CSRF tokens). Applied to every page-derived string and
// error message before it enters a report.
export function redactSecrets(value) {
  return String(value || '')
    .replace(/\b(?:sk|xai|tp|bce-v3)[-_/.A-Za-z0-9]{12,}/g, '[REDACTED]')
    .replace(/AKLT[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/**
 * URLs are recorded as scheme://host/path only. Query strings and fragments
 * routinely carry session state, redirect targets, or one-time tokens, so
 * they are stripped at the source (the page probe never even reads them).
 */
export function sanitizeUrl(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // javascript:/data:/file: URLs never belong in a report; drop wholesale.
      return '[REDACTED]';
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return redactSecrets(raw).slice(0, 200);
  }
}

export function sanitizeTextSummary(items, { maxItems = 30, maxLength = 48 } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => redactSecrets(item).slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}
