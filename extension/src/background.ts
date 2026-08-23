/**
 * OKIT extension — Service Worker (background script) v2.0
 *
 * Connects to the OKIT server via WebSocket, receives atomic-capability
 * commands (exec, navigate, network-capture-start, etc.), dispatches them to
 * Chrome APIs (debugger/tabs/cookies), and returns results.
 *
 * Design (based on opencli, simplified for OKIT's single-user desktop model):
 *   - Single automation window (no multi-workspace isolation)
 *   - WS reconnect with exponential backoff + chrome.alarms keepalive
 *   - /ping health probe before WS attempt (avoids console noise)
 *   - stealth.ts injected via Page.addScriptToEvaluateOnNewDocument (before page scripts)
 *   - Network capture via CDP Network domain (getResponseBody for full API responses)
 *
 * The extension exposes ONLY generic atoms — platform-specific flows (which
 * button to click, which API to intercept) live in the OKIT server
 * (src/web/api/auto-create.js). This keeps the extension stable across
 * platform additions.
 */

import type { Command, Result } from './protocol.js';
import { wsUrl, pingUrl, tokenUrl, OKIT_PORTS, WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY } from './protocol.js';
import { generateStealthJs } from './stealth.js';
import * as executor from './cdp.js';

// ─── WebSocket connection state ─────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// ─── Console log forwarding ──────────────────────────────────────────
// Forward service-worker console output to OKIT server for debugging.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    ws.send(JSON.stringify({ type: 'log', level, msg, ts: Date.now() }));
  } catch { /* don't recurse */ }
}

console.log = (...args: unknown[]) => { _origLog(...args); forwardLog('info', args); };
console.warn = (...args: unknown[]) => { _origWarn(...args); forwardLog('warn', args); };
console.error = (...args: unknown[]) => { _origError(...args); forwardLog('error', args); };

// ─── WebSocket connection ────────────────────────────────────────────

/**
 * Probe the OKIT server via its /ping HTTP endpoint before attempting a
 * WebSocket connection. fetch() failures are silently catchable; new
 * WebSocket() is not — Chrome logs ERR_CONNECTION_REFUSED to the extension
 * error page before any JS handler can intercept it.
 */
/**
 * Probe the ports the OKIT server may occupy (3780 pinned, 3781+ fallback)
 * and return the first one that answers, or null when no server is running.
 * The short per-port timeout keeps the full sweep cheap on the ~20s keepalive
 * cadence when the server is down.
 */
async function findServerPort(): Promise<number | null> {
  for (const port of OKIT_PORTS) {
    try {
      const res = await fetch(pingUrl(port), { signal: AbortSignal.timeout(600) });
      if (res.ok) return port; // unexpected responses fall through to the next port
    } catch {
      // No server on this port — try the next one.
    }
  }
  return null;
}

async function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  const port = await findServerPort();
  if (port === null) return; // server not running — skip WebSocket to avoid console noise

  // One-time auth token. The server issues tokens only to extension origins
  // (CORS-gated), then requires one on the WebSocket before any command
  // traffic — an ordinary web page can do neither.
  let token: string | undefined;
  try {
    const res = await fetch(tokenUrl(port), { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const body = await res.json() as { token?: string };
      token = body.token;
    } else if (res.status !== 404) {
      return; // unexpected error — retry on the next keepalive tick
    }
    // 404 = server predates WS auth; it accepts an unauthenticated connect.
  } catch {
    return;
  }

  try {
    ws = new WebSocket(wsUrl(port));
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[OKIT] Connected to daemon');
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Authenticate first (server stays mute until a valid token arrives), then
    // send version + protocol marker so the server can confirm it's talking to
    // the v2 atomic-capability extension (not a stale cached v1 SW).
    if (token) ws?.send(JSON.stringify({ type: 'auth', token }));
    ws?.send(JSON.stringify({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      protocol: 'atomic-v2',
    }));
  };

  ws.onmessage = async (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    if (msg?.type === 'auth-ok') return; // handshake ack — not a command
    if (msg?.type === 'auth-failed') {
      console.error('[OKIT] WS auth rejected:', msg.error || 'unknown error');
      ws?.close();
      return;
    }
    try {
      const command = msg as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error('[OKIT] Message handling error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[OKIT] Disconnected from daemon');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

/**
 * After MAX_EAGER_ATTEMPTS (reaching ~60s backoff), stop scheduling reconnects.
 * The keepalive alarm (~24s) will still call connect() periodically, but at a
 * much lower frequency — reducing console noise when the server is not running.
 */
const MAX_EAGER_ATTEMPTS = 6; // 2s, 4s, 8s, 16s, 32s, 60s — then stop

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return; // let keepalive alarm handle it
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ─── Automation window (single, reused) ──────────────────────────────
// OKIT is single-user, so we keep ONE dedicated automation window. The user's
// active browsing session is never touched. The window auto-closes after 30s
// of idle (no commands).

let automationWindowId: number | null = null;
let automationTabId: number | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const WINDOW_IDLE_TIMEOUT = 30000; // 30s — quick cleanup after command finishes

/** Blank page used when no user URL is provided. */
const BLANK_PAGE = 'about:blank';

/** Check if a URL can be debugged via CDP — only allow http(s), blank, data. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

/** Check if a URL is safe for user-facing navigation (http/https only). */
function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (automationWindowId !== null) {
      try {
        await chrome.windows.remove(automationWindowId);
        console.log(`[OKIT] Automation window ${automationWindowId} closed (idle timeout)`);
      } catch {
        // Already gone
      }
    }
    automationWindowId = null;
    automationTabId = null;
    idleTimer = null;
  }, WINDOW_IDLE_TIMEOUT);
}

/** Get or create the dedicated automation window.
 *  @param initialUrl — if provided (http/https), used as the initial page.
 */
async function getAutomationWindow(initialUrl?: string): Promise<number> {
  // Check if our window is still alive
  if (automationWindowId !== null) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      // Window was closed by user
      automationWindowId = null;
      automationTabId = null;
    }
  }

  const startUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;

  // Note: Do NOT set `state` parameter. Chrome 146+ rejects 'normal' as invalid.
  const win = await chrome.windows.create({
    url: startUrl,
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
  });
  automationWindowId = win.id!;
  console.log(`[OKIT] Created automation window ${automationWindowId} (start=${startUrl})`);
  resetIdleTimer();

  // Wait for the initial tab to finish loading
  const tabs = await chrome.tabs.query({ windowId: win.id! });
  if (tabs[0]?.id) {
    automationTabId = tabs[0].id;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 500);
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === tabs[0].id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      if (tabs[0].status === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  return automationWindowId;
}

/** Resolve the target tab ID for a command — explicit tabId wins, else automation tab. */
async function resolveTabId(explicitTabId?: number, initialUrl?: string): Promise<number> {
  if (explicitTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(explicitTabId);
      if (isDebuggableUrl(tab.url)) return explicitTabId;
    } catch {
      // fall through to automation tab
    }
  }

  // Use the cached automation tab if still valid
  if (automationTabId !== null) {
    try {
      const tab = await chrome.tabs.get(automationTabId);
      if (isDebuggableUrl(tab.url)) return automationTabId;
    } catch {
      automationTabId = null;
    }
  }

  // Ensure the window exists, then find a debuggable tab
  const windowId = await getAutomationWindow(initialUrl);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find(t => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) {
    automationTabId = debuggableTab.id;
    return automationTabId;
  }

  // Fallback: create a new tab
  const newTab = await chrome.tabs.create({ windowId, url: BLANK_PAGE, active: true });
  if (!newTab.id) throw new Error('Failed to create tab in automation window');
  automationTabId = newTab.id;
  return automationTabId;
}

// Clean up when the automation window is closed by the user
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === automationWindowId) {
    console.log('[OKIT] Automation window closed');
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    automationWindowId = null;
    automationTabId = null;
  }
});

// ─── Stealth injection ───────────────────────────────────────────────
// CRITICAL: stealth must be injected BEFORE page scripts run. We use
// Page.addScriptToEvaluateOnNewDocument so the stealth JS runs at the very
// start of every new page load, before any website fingerprinting code.
// Injecting via Runtime.evaluate AFTER navigation is too late — the site
// has already detected CDP.

/** Track which tabs have already had stealth registered. */
const stealthInjectedTabs = new Set<number>();

async function ensureStealthInjected(tabId: number): Promise<void> {
  if (stealthInjectedTabs.has(tabId)) return;
  await executor.ensureAttached(tabId, true);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
    source: generateStealthJs(),
  });
  stealthInjectedTabs.add(tabId);
  console.log(`[OKIT] Stealth injected for tab ${tabId}`);
}

// When a tab navigates to a new page, re-verify stealth is registered.
// Page.addScriptToEvaluateOnNewDocument persists across navigations within
// the same tab, so we only need to register once per tab — but we re-check
// after attach failures clear the set.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  // Only act on our automation tab
  if (tabId !== automationTabId) return;
  if (info.status === 'loading' && stealthInjectedTabs.has(tabId)) {
    // Stealth already registered for this tab; addScriptToEvaluateOnNewDocument
    // will apply it to the new navigation automatically.
    return;
  }
});

// ─── Lifecycle events ────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  // Keepalive alarm — fires every ~20s. This is the primary mechanism to
  // prevent MV3 from killing the service worker during idle periods. Each
  // fire triggers connect() which, if already connected, sends a heartbeat
  // ping to the server to reset the SW activity timer.
  chrome.alarms.create('keepalive', { periodInMinutes: 0.33 }); // ~20 seconds
  executor.registerListeners();
  void connect();
  console.log('[OKIT] Extension initialized v' + chrome.runtime.getManifest().version);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // If WS is connected, send a heartbeat ping to keep the SW active.
    // MV3 kills idle SWs after ~30s; this resets the activity timer every 20s.
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'keepalive', ts: Date.now() })); } catch { /* will reconnect */ }
      // Also do a tiny chrome.runtime API call to reset the SW timer
      void chrome.runtime.getManifest();
    }
    void connect();
  }
});

// ─── Extension-page messages ──────────────────────────────────────────

type ClipboardReadPending = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

const clipboardReadPending = new Map<string, ClipboardReadPending>();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'okit-clipboard-read-result' && typeof msg.requestId === 'string') {
    const pending = clipboardReadPending.get(msg.requestId);
    if (!pending) return false;
    clipboardReadPending.delete(msg.requestId);
    if (typeof msg.error === 'string') pending.reject(new Error(`Clipboard read failed: ${msg.error}`));
    else if (typeof msg.text === 'string') pending.resolve(msg.text);
    else pending.reject(new Error('Clipboard read returned no text'));
    return false;
  }
  if (msg?.type === 'getStatus') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
      version: chrome.runtime.getManifest().version,
      automationWindowId,
    });
  }
  return false;
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  resetIdleTimer(); // window stays alive while active
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd);
      case 'navigate':
        return await handleNavigate(cmd);
      case 'tabs':
        return await handleTabs(cmd);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd);
      case 'focus-window':
        return await handleFocusWindow(cmd);
      case 'close-window':
        return await handleCloseWindow(cmd);
      case 'cdp':
        return await handleCdp(cmd);
      case 'set-file-input':
        return await handleSetFileInput(cmd);
      case 'insert-text':
        return await handleInsertText(cmd);
      case 'network-capture-start':
        return await handleNetworkCaptureStart(cmd);
      case 'network-capture-read':
        return await handleNetworkCaptureRead(cmd);
      case 'clipboard-read':
        return await handleClipboardRead(cmd);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

async function handleExec(cmd: Command): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId);
  try {
    // Ensure stealth is injected before evaluating page JS — the page may have
    // reloaded since the last attach, clearing our addScriptToEvaluateOnNewDocument.
    await ensureStealthInjected(tabId);
    const data = await executor.evaluate(tabId, cmd.code, true);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleNavigate(cmd: Command): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  const tabId = await resolveTabId(cmd.tabId, cmd.url);

  const beforeTab = await chrome.tabs.get(tabId);
  const beforeUrl = beforeTab.url;
  const targetUrl = cmd.url;

  // Fast-path: tab is already at the target URL and fully loaded.
  if (beforeTab.status === 'complete' && beforeTab.url === targetUrl) {
    await ensureStealthInjected(tabId);
    return { id: cmd.id, ok: true, data: { title: beforeTab.title, url: beforeTab.url, tabId, timedOut: false } };
  }

  // Detach any existing debugger before top-level navigation — avoids stale
  // attach state that causes "Inspected target navigated" on the next eval.
  await executor.detach(tabId);
  stealthInjectedTabs.delete(tabId);

  await chrome.tabs.update(tabId, { url: targetUrl });

  // Wait until navigation completes (status 'complete' AND url differs from before)
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && (tab.url === targetUrl || tab.url !== beforeUrl)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if the tab already navigated (instant cache hit)
    checkTimer = setTimeout(async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete' && (t.url === targetUrl || t.url !== beforeUrl)) finish();
      } catch { /* tab gone */ }
    }, 100);

    // Timeout fallback
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[OKIT] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15000);
  });

  // Inject stealth for the new page BEFORE any exec commands run on it.
  // The addScriptToEvaluateOnNewDocument call here registers stealth for
  // future navigations too; the current page's scripts have already run,
  // but stealth still applies to SPA route changes and reloaded resources.
  await ensureStealthInjected(tabId);

  const tab = await chrome.tabs.get(tabId);
  return { id: cmd.id, ok: true, data: { title: tab.title, url: tab.url, tabId, timedOut } };
}

async function handleTabs(cmd: Command): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      // Discovery is read-only and must include the user's normal browser
      // windows. Usage integrations reuse an already-authenticated page
      // instead of forcing a second login in the OKIT automation window.
      const tabs = await chrome.tabs.query({});
      const data = tabs
        .filter(t => isDebuggableUrl(t.url))
        .map((t, i) => ({ index: i, tabId: t.id, url: t.url, title: t.title, active: t.active }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (automationWindowId === null) return { id: cmd.id, ok: false, error: 'No automation window' };
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme' };
      }
      const tab = await chrome.tabs.create({ windowId: automationWindowId, url: cmd.url ?? BLANK_PAGE, active: true });
      automationTabId = tab.id!;
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      if (automationWindowId === null) return { id: cmd.id, ok: false, error: 'No automation window' };
      const tabId = cmd.tabId ?? automationTabId;
      if (tabId === null) return { id: cmd.id, ok: false, error: 'No tab to close' };
      await chrome.tabs.remove(tabId);
      await executor.detach(tabId);
      if (tabId === automationTabId) automationTabId = null;
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (automationWindowId === null) return { id: cmd.id, ok: false, error: 'No automation window' };
      if (cmd.tabId !== undefined) {
        await chrome.tabs.update(cmd.tabId, { active: true });
        automationTabId = cmd.tabId;
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      return { id: cmd.id, ok: false, error: 'Missing tabId' };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie domain or URL required' };
  }
  // Prefer URL matching when the caller needs the exact cookies that a page
  // request would send. This includes parent-domain cookies (for example
  // `.xiaomimimo.com`) that are valid for a platform subdomain but are not
  // returned by an exact `domain: platform.xiaomimimo.com` lookup.
  const cookies = await chrome.cookies.getAll(cmd.url ? { url: cmd.url } : { domain: cmd.domain });
  const data = cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format, quality: cmd.quality, fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Bring the dedicated automation window forward when a human needs to log in.
 *  Chrome does not expose a persistent "always on top" setting, but focusing the
 *  window and activating its tab makes the handoff immediately visible. */
async function handleFocusWindow(cmd: Command): Promise<Result> {
  if (automationWindowId === null) {
    return { id: cmd.id, ok: false, error: 'No automation window' };
  }
  try {
    const win = await chrome.windows.update(automationWindowId, { focused: true, drawAttention: true });
    if (automationTabId !== null) {
      await chrome.tabs.update(automationTabId, { active: true });
    }
    if (cmd.hold) {
      // A person may need more than the normal 30-second cleanup window to
      // finish MFA or an account login. They can close the window themselves.
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    } else {
      resetIdleTimer();
    }
    return {
      id: cmd.id,
      ok: true,
      data: { windowId: win.id, tabId: automationTabId, focused: true },
    };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** CDP methods permitted via the 'cdp' passthrough action. */
const CDP_ALLOWLIST = new Set([
  'Accessibility.getFullAXTree',
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.querySelectorAll',
  'DOM.scrollIntoViewIfNeeded',
  'DOMSnapshot.captureSnapshot',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.enable',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);

async function handleCdp(cmd: Command): Promise<Result> {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const tabId = await resolveTabId(cmd.tabId);
  try {
    await executor.ensureAttached(tabId, true);
    const data = await chrome.debugger.sendCommand({ tabId }, cmd.cdpMethod, cmd.cdpParams ?? {});
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCloseWindow(_cmd: Command): Promise<Result> {
  if (automationWindowId !== null) {
    try {
      await chrome.windows.remove(automationWindowId);
    } catch { /* already closed */ }
    automationWindowId = null;
    automationTabId = null;
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  return { id: _cmd.id, ok: true, data: { closed: true } };
}

async function handleSetFileInput(cmd: Command): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }
  const tabId = await resolveTabId(cmd.tabId);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleInsertText(cmd: Command): Promise<Result> {
  if (typeof cmd.text !== 'string') {
    return { id: cmd.id, ok: false, error: 'Missing text payload' };
  }
  const tabId = await resolveTabId(cmd.tabId);
  try {
    await executor.insertText(tabId, cmd.text);
    return { id: cmd.id, ok: true, data: { inserted: true } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleNetworkCaptureStart(cmd: Command): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId);
  try {
    await ensureStealthInjected(tabId);
    await executor.startNetworkCapture(tabId, cmd.pattern);
    return { id: cmd.id, ok: true, data: { started: true } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleNetworkCaptureRead(cmd: Command): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId);
  try {
    const data = await executor.readNetworkCapture(tabId);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a just-copied provider key only when it completely matches the
 * server-supplied platform pattern. This is deliberately not a general
 * clipboard-inspection endpoint: unmatched content never leaves the extension.
 */
async function handleClipboardRead(cmd: Command): Promise<Result> {
  if (!cmd.clipboardPattern) {
    return { id: cmd.id, ok: false, error: 'Clipboard pattern required' };
  }
  try {
    const text = (await readClipboardText()).trim();
    if (!text || text.length > 4096) {
      return { id: cmd.id, ok: true, data: { matched: false, length: text.length } };
    }
    let matcher: RegExp;
    try { matcher = new RegExp(cmd.clipboardPattern); } catch {
      return { id: cmd.id, ok: false, error: 'Invalid clipboard pattern' };
    }
    const match = text.match(matcher);
    if (!match || (!cmd.clipboardAllowSurrounding && match[0] !== text)) {
      return { id: cmd.id, ok: true, data: { matched: false, length: text.length } };
    }
    const value = match[0];
    return { id: cmd.id, ok: true, data: { matched: true, value, length: value.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Chrome requires the document that calls navigator.clipboard.readText() to be
 * focused. MV3 offscreen documents are explicitly unfocusable, so we open a
 * focused extension-only popup for this one read, then close it. The window is
 * positioned off-screen: focus is what the clipboard API demands, visibility
 * is not — so the reader never flashes on screen during key creation.
 */
async function readClipboardText(): Promise<string> {
  const requestId = crypto.randomUUID();
  let popupWindowId: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = new Promise<string>((resolve, reject) => {
      clipboardReadPending.set(requestId, { resolve, reject });
      timeout = setTimeout(() => {
        clipboardReadPending.delete(requestId);
        reject(new Error('Timed out waiting for the focused clipboard reader'));
      }, 5000);
    });
    try {
      const popup = await chrome.windows.create({
        url: chrome.runtime.getURL(`clipboard.html?requestId=${encodeURIComponent(requestId)}`),
        type: 'popup',
        width: 260,
        height: 96,
        focused: true,
        // Way outside any display — the popup keeps focus (required for
        // clipboard.readText) without ever being visible to the user.
        left: 32000,
        top: 32000,
      });
      popupWindowId = popup.id;
    } catch (error) {
      const pending = clipboardReadPending.get(requestId);
      clipboardReadPending.delete(requestId);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return await result;
  } finally {
    if (timeout) clearTimeout(timeout);
    clipboardReadPending.delete(requestId);
    if (popupWindowId !== undefined) await chrome.windows.remove(popupWindowId).catch(() => {});
  }
}

// ─── Boot ────────────────────────────────────────────────────────────
// MV3 service workers may start via onInstalled/onStartup (above) or directly
// when an event wakes them. The initialize() guard prevents double-init.
// We also call it once at module load for safety.
initialize();
