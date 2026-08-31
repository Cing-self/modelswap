// Dedicated-test-Chrome launcher + CDP read-only driver.
//
// Hard safety properties:
//  * Chrome is ALWAYS launched with --user-data-dir inside the acceptance
//    root (verified with assertSafeProfileDir before spawn). The daily
//    profile is never referenced, copied, or backed up.
//  * The driver only implements read-only atoms (open-tab / probe /
//    screenshot / close-tab / dispose) and routes each through the mode's
//    action whitelist, so guest/auth-verify cannot express a click.
//  * CDP is only reachable on the dedicated debug port of this instance.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { assertDriverActionAllowed, assertSafeProfileDir } from './safety.mjs';
import { buildProbeScript } from './probe.mjs';

export const DEFAULT_DEBUG_PORT = Number(process.env.OKIT_LIVE_DEBUG_PORT || 9333);

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
  win32: [], // resolved from PROGRAMFILES env below
};

function windowsCandidates(env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }
  return candidates;
}

export function findChromeBinary({ env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  if (env.OKIT_LIVE_CHROME_BIN && existsSync(env.OKIT_LIVE_CHROME_BIN)) return env.OKIT_LIVE_CHROME_BIN;
  const candidates = platform === 'win32'
    ? windowsCandidates(env)
    : CHROME_CANDIDATES[platform] || [];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

// ─── CDP plumbing ───────────────────────────────────────────────────

async function cdpFetch(port, urlPath, method = 'GET') {
  const response = await fetch(new URL(urlPath, `http://127.0.0.1:${port}`), { method });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} ${urlPath}`);
  return response.json();
}

export async function probeDebugPort(port, timeoutMs = 8000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const version = await cdpFetch(port, '/json/version');
      if (version?.webSocketDebuggerUrl) return version;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`专用 Chrome 的 CDP 调试端口 127.0.0.1:${port} 在 ${timeoutMs}ms 内未就绪`);
}

export async function openCdpTab(port) {
  // Modern Chrome ignores ?url= on /json/new (security change); create a
  // blank target here and navigate it explicitly via Page.navigate.
  let target;
  try {
    target = await cdpFetch(port, '/json/new', 'PUT');
  } catch {
    target = await cdpFetch(port, '/json/new');
  }
  if (!target?.id || !target?.webSocketDebuggerUrl) {
    throw new Error('CDP 未返回新标签页的调试端点');
  }
  return { id: target.id, wsUrl: target.webSocketDebuggerUrl };
}

/** Create a tab and navigate it to the URL (see openCdpTab for why the URL
 *  cannot ride on /json/new). Returns the tab with its session attached. */
export async function openTabAtUrl(port, url) {
  const tab = await openCdpTab(port);
  const session = await connectTargetWs(tab.wsUrl);
  await session.send('Page.navigate', { url });
  return { tab, session };
}

export async function closeCdpTab(port, tabId) {
  if (!tabId) return;
  try {
    await cdpFetch(port, `/json/close/${tabId}`);
  } catch {
    // best-effort
  }
}

function connectTargetWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error('CDP WebSocket 连接超时'));
    }, 8000);
    ws.on('open', () => {
      clearTimeout(timer);
      let seq = 0;
      const pending = new Map();
      ws.on('message', (data) => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (message?.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      });
      ws.on('error', () => { /* surfaced via send timeouts */ });
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((resolveSend, rejectSend) => {
            const sendTimer = setTimeout(() => {
              pending.delete(id);
              rejectSend(new Error(`CDP 命令超时：${method}`));
            }, 20000);
            pending.set(id, (message) => {
              clearTimeout(sendTimer);
              if (message.error) rejectSend(new Error(`CDP ${method} 错误：${message.error.message || message.error}`));
              else resolveSend(message.result || {});
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch { /* already closed */ }
        },
      });
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 连接失败：${error?.message || error}`));
    });
  });
}

async function evaluateExpression(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`页面脚本执行失败：${String(detail || '').slice(0, 200)}`);
  }
  return result?.result?.value;
}

// ─── Dedicated Chrome launcher ──────────────────────────────────────

/**
 * Launch a dedicated test Chrome. The user-data-dir MUST live inside the
 * acceptance root (assertSafeProfileDir enforces this against the daily
 * profile blacklist too). Nothing from the daily browser is ever read,
 * copied, backed up, or exported.
 */
export async function launchDedicatedChrome({
  binary,
  userDataDir,
  root,
  debugPort = DEFAULT_DEBUG_PORT,
  withExtension = false,
  extensionDir = '',
  platform = process.platform,
  home = os.homedir(),
  spawnImpl = spawn,
  extraArgs = [],
}) {
  assertSafeProfileDir({ root, dir: userDataDir, platform, home });
  await fsp.mkdir(userDataDir, { recursive: true });
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-background-timer-throttling',
    '--new-window',
    'about:blank',
  ];
  if (withExtension) {
    if (!extensionDir || !fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
      throw new Error(`--with-extension 需要有效的扩展目录（含 manifest.json）：${extensionDir || '(空)'}`);
    }
    args.unshift(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
  }
  args.push(...extraArgs);
  const child = spawnImpl(binary, args, {
    detached: true,
    stdio: 'ignore',
    // Chrome on macOS/Linux under CI sandboxes may need DISPLAY; local manual
    // runs always have it. No env overrides are applied on purpose.
  });
  child.unref();
  return { pid: child.pid, userDataDir, debugPort };
}

// ─── Read-only driver used by guest / auth-verify ───────────────────

export function createReadOnlyDriver({
  mode,
  binary,
  root,
  profileDir,
  debugPort = DEFAULT_DEBUG_PORT,
  temporary = false, // guest: profile dir is deleted on dispose
  withExtension = false,
  extensionDir = '',
  launchTimeoutMs = 15000,
}) {
  let launched = null;
  const sessions = new Map(); // tabId -> CDP session
  const openedTabs = [];
  const ensureLaunched = async () => {
    if (launched) return launched;
    // Reuse a still-running dedicated Chrome on the same debug port (the
    // auth-verify rerun-after-login flow) before launching a fresh one.
    try {
      await probeDebugPort(debugPort, 1200, 400);
      launched = { reused: true };
      return launched;
    } catch {
      // not running — launch below
    }
    if (!binary) throw new Error('未找到 Chrome/Chromium/Edge 可执行文件；请用 --chrome-bin 显式指定');
    launched = await launchDedicatedChrome({
      binary, userDataDir: profileDir, root, debugPort, withExtension, extensionDir,
    });
    await probeDebugPort(debugPort, launchTimeoutMs);
    return launched;
  };
  const sessionFor = async (tab) => {
    if (sessions.has(tab.id)) return sessions.get(tab.id);
    const session = await connectTargetWs(tab.wsUrl);
    sessions.set(tab.id, session);
    return session;
  };
  const guard = (action) => assertDriverActionAllowed(mode, action);

  return {
    mode,
    isTemporaryProfile: temporary,
    async openTab(url) {
      guard('open-tab');
      await ensureLaunched();
      const { tab, session } = await openTabAtUrl(debugPort, url);
      openedTabs.push(tab.id);
      sessions.set(tab.id, session);
      return tab;
    },
    async probe(tab, probeOptions) {
      guard('probe');
      const run = async () => {
        const session = await sessionFor(tab);
        const expression = buildProbeScript(probeOptions);
        return evaluateExpression(session, expression);
      };
      try {
        const raw = await run();
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (error) {
        // Cross-process navigations can invalidate a target session; one
        // reconnect-and-retry keeps long sweeps alive.
        const message = String(error?.message || error);
        if (!/session|target closed|websocket/i.test(message)) throw error;
        sessions.get(tab.id)?.close();
        sessions.delete(tab.id);
        const raw = await run();
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
    },
    async screenshot(tab, filePath) {
      guard('screenshot');
      const session = await sessionFor(tab);
      const result = await session.send('Page.captureScreenshot', { format: 'png' });
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, Buffer.from(result.data, 'base64'));
      return filePath;
    },
    async closeTab(tab) {
      guard('close-tab');
      sessions.get(tab.id)?.close();
      sessions.delete(tab.id);
      await closeCdpTab(debugPort, tab.id);
    },
    async dispose({ keepOpen = false } = {}) {
      guard('dispose');
      for (const session of sessions.values()) session.close();
      sessions.clear();
      if (keepOpen) return;
      if (launched && !launched.reused && launched.pid) {
        try { process.kill(-launched.pid, 'SIGTERM'); } catch {
          try { process.kill(launched.pid, 'SIGTERM'); } catch { /* already gone */ }
        }
      }
      if (temporary && profileDir) {
        await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
