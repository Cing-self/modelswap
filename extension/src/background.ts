/**
 * MODELSWAP extension — Service Worker (background script) v2.0
 *
 * Connects to the MODELSWAP server via WebSocket, receives atomic-capability
 * commands (exec, navigate, network-capture-start, etc.), dispatches them to
 * Chrome APIs (debugger/tabs/cookies), and returns results.
 *
 * Design (based on opencli, simplified for MODELSWAP's single-user desktop model):
 *   - Single automation window (no multi-workspace isolation)
 *   - WS reconnect with exponential backoff + chrome.alarms keepalive
 *   - /ping health probe before WS attempt (avoids console noise)
 *   - stealth.ts injected via Page.addScriptToEvaluateOnNewDocument (before page scripts)
 *   - Network capture via CDP Network domain (getResponseBody for full API responses)
 *
 * The extension exposes ONLY generic atoms — platform-specific flows (which
 * button to click, which API to intercept) live in the MODELSWAP server
 * (src/web/api/auto-create.js). This keeps the extension stable across
 * platform additions.
 */

import type { Command, Result } from './protocol.js';
import { wsUrl, pingUrl, tokenUrl, MODELSWAP_PORTS, WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY } from './protocol.js';
import { generateStealthJs } from './stealth.js';
import * as executor from './cdp.js';
import { applyStoredOpenMode } from './open-mode.js';

// ─── WebSocket connection state ─────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
// Port the daemon was last found on — reused for plain HTTP reads (e.g.
// the vault group list for the popup/side-panel autocomplete).
let serverPort: number | null = null;
// Whether the connected daemon predates the vault-request/vault-save API
// (released builds before 2.2.0 silently ignore those messages).
let serverLegacy = false;

/**
 * Probe for the vault-request API. A 404 means the running daemon is an
 * older release: tell the UI immediately instead of letting saves time out
 * mysteriously ten seconds later.
 */
async function probeServerCapabilities(): Promise<void> {
  try {
    const port = serverPort;
    if (!port) return;
    const res = await fetch(`http://localhost:${port}/api/vault/requests`, { signal: AbortSignal.timeout(3000) });
    serverLegacy = res.status === 404;
    await chrome.storage.local.set({ serverLegacy });
    if (serverLegacy) {
      console.warn('[MODELSWAP] daemon predates vault-request API — extension save/capture unavailable until ModelSwap is upgraded');
    }
  } catch {
    // probe failed — leave the last known state
  }
}

// ─── Console log forwarding ──────────────────────────────────────────
// Forward service-worker console output to MODELSWAP server for debugging.

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
 * Probe the MODELSWAP server via its /ping HTTP endpoint before attempting a
 * WebSocket connection. fetch() failures are silently catchable; new
 * WebSocket() is not — Chrome logs ERR_CONNECTION_REFUSED to the extension
 * error page before any JS handler can intercept it.
 */
/**
 * Probe the ports the MODELSWAP server may occupy (3780 pinned, 3781+ fallback)
 * and return the first one that answers, or null when no server is running.
 * The short per-port timeout keeps the full sweep cheap on the ~20s keepalive
 * cadence when the server is down.
 */
async function findServerPort(): Promise<number | null> {
  for (const port of MODELSWAP_PORTS) {
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
  serverPort = port;

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
    console.log('[MODELSWAP] Connected to daemon');
    reconnectAttempts = 0;
    void chrome.storage.local.set({ wsConnected: true });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Authenticate first (server stays mute until a valid token arrives), then
    // send version + protocol marker so the server can confirm it's talking to
    // the v2 atomic-capability extension (not a stale cached v1 SW).
    if (token) ws?.send(JSON.stringify({ type: 'auth', token }));
    // NOTE: protocol stays the LAST property — the live-acceptance patcher
    // anchors on `protocol: 'atomic-v2',\n}` exactly once.
    ws?.send(JSON.stringify({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      // Lets the server supersede only THIS extension's stale sockets, so a
      // released copy and a dev copy can stay connected side by side.
      extId: chrome.runtime.id,
      protocol: 'atomic-v2',
    }));
    void probeServerCapabilities();
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
      console.error('[MODELSWAP] WS auth rejected:', msg.error || 'unknown');
      ws?.close();
      return;
    }
    // Credential-request queue sync (server → extension push)
    if (msg?.type === 'vault-request-sync') {
      vaultRequests = Array.isArray(msg.requests) ? msg.requests : [];
      void persistVaultRequests();
      void injectCopyGuardIntoMatchingTabs();
      return;
    }
      // Capture result for a vault-capture we sent
      if (msg?.type === 'vault-capture-result') {
        resolveCaptureResult(msg);
        return;
      }
      // Direct-save result for a vault-save we sent
      if (msg?.type === 'vault-save-result') {
        resolveCaptureResult(msg);
        return;
      }
    try {
      const command = msg as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error('[MODELSWAP] Message handling error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[MODELSWAP] Disconnected from daemon');
    ws = null;
    void chrome.storage.local.set({ wsConnected: false });
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
// MODELSWAP is single-user, so we keep ONE dedicated automation window. The user's
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
        console.log(`[MODELSWAP] Automation window ${automationWindowId} closed (idle timeout)`);
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
  console.log(`[MODELSWAP] Created automation window ${automationWindowId} (start=${startUrl})`);
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
    console.log('[MODELSWAP] Automation window closed');
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
  console.log(`[MODELSWAP] Stealth injected for tab ${tabId}`);
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

// ─── Open-mode memory (popup vs side panel) ─────────────────────────
// The toolbar icon reopens the user's last capture surface. setPanelBehavior
// and setPopup are per-session browser state, so re-apply the stored
// preference on every service-worker wake and whenever it changes.
function initialize(): void {
  if (initialized) return;
  initialized = true;
  // Keepalive alarm — fires every ~20s. This is the primary mechanism to
  // prevent MV3 from killing the service worker during idle periods. Each
  // fire triggers connect() which, if already connected, sends a heartbeat
  // ping to the server to reset the SW activity timer.
  chrome.alarms.create('keepalive', { periodInMinutes: 0.33 }); // ~20 seconds
  executor.registerListeners();
  void loadVaultRequests();
  void connect();
  void applyStoredOpenMode();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.openMode) void applyStoredOpenMode();
  });
  console.log('[MODELSWAP] Extension initialized v' + chrome.runtime.getManifest().version);
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
  if (msg?.type === 'modelswap-clipboard-read-result' && typeof msg.requestId === 'string') {
    const pending = clipboardReadPending.get(msg.requestId);
    if (!pending) return false;
    clipboardReadPending.delete(msg.requestId);
    if (typeof msg.error === 'string') pending.reject(new Error(`Clipboard read failed: ${msg.error}`));
    else if (typeof msg.text === 'string') pending.resolve(msg.text);
    else pending.reject(new Error('Clipboard read returned no text'));
    return false;
  }
  if (msg?.type === 'modelswap-copy') {
    void handleCopyDetected(msg);
    return false;
  }
  if (msg?.type === 'modelswap-popup-init') {
    sendResponse({
      requests: vaultRequests,
      connected: ws?.readyState === WebSocket.OPEN,
      legacy: serverLegacy,
    });
    return false;
  }
  if (msg?.type === 'modelswap-manual-capture') {
    void handleManualCapture(msg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'modelswap-manual-save') {
    void handleManualSave(msg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'modelswap-get-groups') {
    void getVaultGroups().then(sendResponse);
    return true; // async response
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

// ─── Vault credential capture (credential-request flow) ─────────────
//
// The server pushes pending requests (`modelswap vault request` from an
// agent CLI); copy-guard content scripts forward secret-shaped copies; this
// worker matches copies to requests with a two-tier confidence model:
//   auto    — expected-domain copy (pattern hit, or agent-vouched domain)
//             → store + notify; the user never judges "存不存"
//   confirm — plausible but not proven → one-click notification [存 / 不是这个]
// Everything else is silently ignored.

interface VaultRequestFieldView { name: string; pattern?: string }
interface VaultRequestItemView {
  key: string; group?: string; desc?: string; url?: string; steps?: string[];
  pattern?: string; fields?: VaultRequestFieldView[]; replace?: boolean;
  status: 'pending' | 'fulfilled'; masked?: unknown; duplicate?: boolean; storedAt?: number;
}
interface VaultRequestView {
  id: string; createdAt: number; expiresAt: number; fulfilled: boolean;
  items: VaultRequestItemView[];
}

let vaultRequests: VaultRequestView[] = [];

async function persistVaultRequests(): Promise<void> {
  await chrome.storage.local.set({ vaultRequests });
  updateVaultBadge();
}

/**
 * Copy-guard injection is domain-scoped, never resident: the manifest
 * declares no content scripts, so the guard only reaches a page while a
 * pending request names that console's domain (arm-time sweep for already
 * open tabs + a navigation listener for pages opened while armed). Both
 * content scripts carry idempotency guards, so repeat injection is safe.
 */
async function injectCopyGuardScripts(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/copy-guard.js'] });
  // The MAIN-world clipboard hook catches button-driven
  // navigator.clipboard.writeText() copies (no copy event fires).
  await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/copy-guard-main.js'], world: 'MAIN' as chrome.scripting.ExecutionWorld });
}

function pendingRequestDomains(): { domains: Set<string>; coversAnyPage: boolean } {
  const now = Date.now();
  const domains = new Set<string>();
  let coversAnyPage = false;
  for (const req of vaultRequests) {
    if (req.expiresAt <= now) continue;
    for (const item of req.items) {
      if (item.status !== 'pending') continue;
      if (!item.url) {
        // No console URL given: there is no domain to scope to. Arm-time
        // sweeps may still cover already-open pages; auto-capture stays
        // confirm-gated (matchItem never returns 'auto' without a domain).
        coversAnyPage = true;
        continue;
      }
      try { domains.add(registrableDomain(new URL(item.url).hostname)); } catch { /* bad url */ }
    }
  }
  return { domains, coversAnyPage };
}

async function injectCopyGuardIntoMatchingTabs(): Promise<void> {
  const { domains, coversAnyPage } = pendingRequestDomains();
  if (domains.size === 0 && !coversAnyPage) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch { continue; }
    if (!domains.has(registrableDomain(host)) && !coversAnyPage) continue;
    try {
      await injectCopyGuardScripts(tab.id);
      console.log(`[MODELSWAP] copy-guard injected into open tab: ${host}`);
    } catch { // protected page, discarded tab, already-injected is fine too
    }
  }
}

// Pages that NAVIGATE while a request is armed get the guard on load —
// still domain-scoped to the pending requests, still not resident.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (vaultRequests.length === 0) return;
  const { domains } = pendingRequestDomains();
  if (domains.size === 0) return;
  let host = '';
  try { host = new URL(tab.url ?? '').hostname; } catch { return; }
  if (!host || !domains.has(registrableDomain(host))) return;
  try {
    await injectCopyGuardScripts(tabId);
    console.log(`[MODELSWAP] copy-guard injected on navigation: ${host}`);
  } catch { // protected page, discarded tab, already-injected is fine too
  }
});

function registrableDomain(hostname: string): string {
  const parts = hostname.split('.');
  return parts.slice(-2).join('.');
}

function updateVaultBadge(): void {
  const now = Date.now();
  const pending = vaultRequests.reduce(
    (count, req) => (req.expiresAt > now ? count + req.items.filter(i => i.status !== 'fulfilled').length : count),
    0,
  );
  void chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#c65b2e' });
}

async function loadVaultRequests(): Promise<void> {
  try {
    const st = await chrome.storage.local.get('vaultRequests');
    vaultRequests = (st.vaultRequests as VaultRequestView[]) ?? [];
  } catch {
    vaultRequests = [];
  }
  updateVaultBadge();
}

// ── Capture correlation (extension → server vault-capture round trip) ──

interface CaptureWaiter { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }
const capturePending = new Map<string, CaptureWaiter>();
let captureCounter = 0;

function resolveCaptureResult(msg: any): void {
  const pending = capturePending.get(msg?.id);
  if (!pending) return;
  capturePending.delete(msg?.id);
  clearTimeout(pending.timer);
  pending.resolve(msg);
}

async function sendCapture(
  requestId: string,
  item: VaultRequestItemView,
  payload: { value?: string; fields?: Record<string, string> },
  confirmed: boolean,
  source?: { url?: string; title?: string },
): Promise<any> {
  // A capture message can wake the service worker while the WS handshake is
  // still in flight — grant the socket a short grace window before failing;
  // losing the user's only copy of a secret to a reconnect window is worse
  // than a 3s pause.
  {
    const deadline = Date.now() + 3000;
    while ((!ws || ws.readyState !== WebSocket.OPEN) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'MODELSWAP 未连接（服务未运行？）' });
      return;
    }
    const id = `cap_${Date.now()}_${++captureCounter}`;
    const timer = setTimeout(() => {
      capturePending.delete(id);
      resolve({ ok: false, error: '捕获写入超时' });
    }, 10000);
    capturePending.set(id, { resolve, timer });
    ws.send(JSON.stringify({
      type: 'vault-capture', id, requestId, key: item.key,
      ...(payload.value !== undefined ? { value: payload.value } : {}),
      ...(payload.fields !== undefined ? { fields: payload.fields } : {}),
      confirmed,
      source: source ?? {},
    }));
  });
}

function maskText(v: string): string {
  if (v.length <= 8) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 5)}…${v.slice(-2)}`;
}

function maskedPreview(masked: unknown): string {
  if (typeof masked === 'string') return masked;
  if (masked && typeof masked === 'object') {
    return Object.entries(masked as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(' · ');
  }
  return '';
}

function notifyBasic(title: string, message: string): void {
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

async function completeItem(requestId: string, key: string, result: any): Promise<void> {
  const req = vaultRequests.find(r => r.id === requestId);
  const item = req?.items.find(i => i.key === key);
  if (req && item) {
    item.status = 'fulfilled';
    item.masked = result.masked;
    item.duplicate = result.duplicate === true;
    item.storedAt = Date.now();
    req.fulfilled = req.items.every(i => i.status === 'fulfilled');
    await persistVaultRequests();
  }
  const preview = maskedPreview(result.masked);
  notifyBasic(
    `${key} 已存入 MODELSWAP ✅${result.duplicate ? '（与现有值相同）' : ''}`,
    preview ? `值: ${preview}` : '',
  );
}

// ── Confirm tier — notification buttons hold the pending decision ──

interface ConfirmDecision {
  requestId: string;
  item: VaultRequestItemView;
  payload: { value?: string; fields?: Record<string, string> };
  source?: { url?: string; title?: string };
}
const confirmDecisions = new Map<string, ConfirmDecision>();

function askConfirm(
  requestId: string,
  item: VaultRequestItemView,
  payload: { value?: string; fields?: Record<string, string> },
  source: { url?: string; title?: string } | undefined,
  note: string,
): void {
  const preview = payload.fields
    ? Object.entries(payload.fields).map(([k, v]) => `${k}: ${maskText(v)}`).join(' · ')
    : maskText(payload.value ?? '');
  const suffix = note ? `\n⚠ ${note}` : '';
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `存为 ${item.key}？`,
    message: `捕获到 ${preview}${suffix}`,
    buttons: [{ title: '存' }, { title: '不是这个' }],
    requireInteraction: true,
  }, (notificationId) => {
    confirmDecisions.set(notificationId, { requestId, item, payload, source });
  });
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const decision = confirmDecisions.get(notificationId);
  if (!decision) return;
  confirmDecisions.delete(notificationId);
  void chrome.notifications.clear(notificationId);
  if (buttonIndex !== 0) return; // "不是这个" — plain dismiss
  void (async () => {
    const result = await sendCapture(decision.requestId, decision.item, decision.payload, true, decision.source);
    if (result.ok) await completeItem(decision.requestId, decision.item.key, result);
    else notifyBasic('保存失败', result.error ?? '未知错误');
  })();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  // Body click = dismiss the confirm; the decision is dropped.
  if (confirmDecisions.has(notificationId)) {
    confirmDecisions.delete(notificationId);
    void chrome.notifications.clear(notificationId);
  }
});

// ── Matching ─────────────────────────────────────────────────────────

// Mirrors isPatternSafe in the server's vault-requests.js: patterns arrive
// from requests the server already screened, but this copy keeps the guard
// honest across version-skewed server/extension pairs. Same conservative
// classes: star height > 1, overlapping alternation inside an unbounded
// quantifier. An unsafe pattern is treated as absent (confirm tier only).
function isPatternSafe(pattern: string): boolean {
  const source = pattern
    .replace(/\\[uD]/g, "x")
    .replace(/\\\d+/g, "x")
    .replace(/\\./g, "x")
    .replace(/\[[^\]]*\]/g, "x");
  const stack: Array<{ unboundedInside: boolean; branches: Array<string | 0> | null }> = [{ unboundedInside: false, branches: null }];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const top = stack[stack.length - 1];
    if (ch === "(") {
      stack.push({ unboundedInside: false, branches: [0] });
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (stack.length === 1) return false;
      const group = stack.pop()!;
      const parent = stack[stack.length - 1];
      const quantifier = source.slice(i + 1).match(/^[*+{]/);
      const unboundedHere = quantifier !== null && (quantifier[0] !== "{" || /\{\d+,/.test(source.slice(i + 1)));
      if (unboundedHere) {
        if (group.unboundedInside) return false;
        if (group.branches && group.branches.length > 1) {
          for (let b = 0; b < group.branches.length; b++) {
            for (let c = b + 1; c < group.branches.length; c++) {
              const fb = group.branches[b];
              const fc = group.branches[c];
              if (fb && fc && typeof fb === "string" && typeof fc === "string" && fb[0] === fc[0]) return false;
            }
          }
        }
        if (parent) parent.unboundedInside = true;
      }
      i += 1 + (quantifier ? quantifier[0].length : 0);
      continue;
    }
    if (ch === "|") {
      if (top.branches) top.branches.push(0);
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+") {
      top.unboundedInside = true;
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = source.indexOf("}", i);
      const body = close === -1 ? "" : source.slice(i + 1, close);
      if (/\d+,/.test(body)) top.unboundedInside = true;
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }
    const branch = top.branches;
    if (branch && branch[branch.length - 1] === 0) branch[branch.length - 1] = ch;
    i += 1;
  }
  return stack.length === 1;
}

function compileRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  if (!isPatternSafe(pattern)) {
    // The server should have rejected this at creation; a version-skewed
    // pair must degrade to confirm-tier rather than risk hanging the SW.
    console.warn("[MODELSWAP] unsafe capture pattern ignored (ReDoS screen):", pattern.slice(0, 40));
    return null;
  }
  try { return new RegExp(pattern); } catch { return null; }
}

/** Rough registrable-domain comparison (last two labels) — good enough to
 *  boost confidence for "copied on the console the agent pointed at". */
function sameRegistrableDomain(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const ra = new URL(a).hostname.split('.').slice(-2).join('.');
    const rb = new URL(b).hostname.split('.').slice(-2).join('.');
    return ra === rb;
  } catch {
    return false;
  }
}

function looksSecret(s: string): boolean {
  if (/\s/.test(s) || s.length < 20 || !/^[A-Za-z0-9_\-.=+/]+$/.test(s)) return false;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3.0;
}

function parseTemplate(text: string): Record<string, string> | null {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 8) return null;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([\w.-]{1,64})\s*[:=]\s*(.+)$/);
    if (!m) return null;
    out[m[1]] = m[2].trim();
  }
  return out;
}

interface ItemMatch { tier: 'auto' | 'confirm'; payload: { value?: string; fields?: Record<string, string> }; note: string }

function matchItem(item: VaultRequestItemView, text: string, pageUrl?: string): ItemMatch | null {
  const domain = sameRegistrableDomain(pageUrl, item.url);

  if (item.fields?.length) {
    const parsed = parseTemplate(text);
    if (!parsed) return null;
    const names = item.fields.map(f => f.name);
    const present = names.filter(n => parsed[n] !== undefined);
    if (present.length === 0) return null;
    const all = present.length === names.length;
    let patternsOk = true;
    for (const n of present) {
      const re = compileRegex(item.fields.find(f => f.name === n)?.pattern);
      if (re && !re.test(parsed[n])) patternsOk = false;
    }
    const fields: Record<string, string> = {};
    for (const n of present) fields[n] = parsed[n];
    if (all && patternsOk && domain) return { tier: 'auto', payload: { fields }, note: '' };
    if (patternsOk || domain) {
      const missing = names.filter(n => parsed[n] === undefined);
      return { tier: 'confirm', payload: { fields }, note: missing.length ? `还缺字段: ${missing.join(', ')}` : '' };
    }
    return null;
  }

  const single = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!single) return null;
  const re = compileRegex(item.pattern);
  if (re) {
    const patternOk = re.test(single);
    if (patternOk && domain) return { tier: 'auto', payload: { value: single }, note: '' };
    if (patternOk) return { tier: 'confirm', payload: { value: single }, note: '复制来源不是预期控制台域名' };
    if (domain && looksSecret(single)) return { tier: 'confirm', payload: { value: single }, note: '与 agent 预期格式不符' };
    return null;
  }
  // No pattern supplied. The agent vouched for the console by arming the
  // request against its URL — a copy there IS the value the agent asked
  // for, so store it directly; asking the user "存不存" would push the
  // system's judgment onto them. 8-char floor aligned with the server's
  // value-length guard. The entropy/charset heuristic stays only for
  // URL-less requests, where a copy has no domain context at all.
  if (domain && single.length >= 8) return { tier: 'auto', payload: { value: single }, note: '' };
  if (!item.url && looksSecret(single)) return { tier: 'confirm', payload: { value: single }, note: '' };
  return null;
}

async function handleCopyDetected(msg: { text: string; url?: string; title?: string }): Promise<void> {
  if (vaultRequests.length === 0) return;
  const now = Date.now();
  let auto: { req: VaultRequestView; item: VaultRequestItemView; match: ItemMatch } | null = null;
  let confirmCandidate: { req: VaultRequestView; item: VaultRequestItemView; match: ItemMatch } | null = null;
  // Newest request first — if several pending items match one copy, the most
  // recent ask (the one whose waiter is actually alive) should win.
  const ordered = [...vaultRequests].sort((a, b) => b.createdAt - a.createdAt);
  for (const req of ordered) {
    if (req.expiresAt <= now) continue;
    for (const item of req.items) {
      if (item.status === 'fulfilled') continue;
      const match = matchItem(item, msg.text, msg.url);
      if (!match) continue;
      if (match.tier === 'auto') { auto = { req, item, match }; break; }
      if (!confirmCandidate) confirmCandidate = { req, item, match };
    }
    if (auto) break;
  }

  if (auto) {
    const result = await sendCapture(auto.req.id, auto.item, auto.match.payload, false, msg);
    if (result.ok) {
      await completeItem(auto.req.id, auto.item.key, result);
    } else if (result.code === 'pattern-mismatch' || result.code === 'key-exists') {
      // Soft gates demand an explicit user confirmation.
      askConfirm(auto.req.id, auto.item, auto.match.payload, msg,
        result.code === 'key-exists' ? '同名 key 已存在，确认覆盖' : '与 agent 预期格式不符');
    } else {
      notifyBasic('捕获失败', result.error ?? '未知错误');
    }
  } else if (confirmCandidate) {
    askConfirm(confirmCandidate.req.id, confirmCandidate.item, confirmCandidate.match.payload, msg, confirmCandidate.match.note);
  }
}

async function handleManualCapture(msg: { key: string; text: string }): Promise<any> {
  const now = Date.now();
  for (const req of vaultRequests) {
    if (req.expiresAt <= now) continue;
    const item = req.items.find(i => i.key === msg.key && i.status !== 'fulfilled');
    if (!item) continue;
    let payload: { value?: string; fields?: Record<string, string> };
    if (item.fields?.length) {
      const parsed = parseTemplate(msg.text) ?? {};
      payload = { fields: parsed };
    } else {
      payload = { value: msg.text.trim().split(/\r?\n/)[0]?.trim() ?? msg.text.trim() };
    }
    const result = await sendCapture(req.id, item, payload, true, { url: 'extension-popup', title: 'manual paste' });
    if (result.ok) {
      await completeItem(req.id, item.key, result);
      return { ok: true, masked: result.masked };
    }
    return { ok: false, error: result.error ?? '未知错误', code: result.code };
  }
  return { ok: false, error: `没有等待中的请求: ${msg.key}` };
}

// ── Direct save — user composed this in the popup, no pending request ──

function sendVaultSave(payload: { key: string; group?: string; desc?: string; value: string; force?: boolean }): Promise<any> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'MODELSWAP 未连接（服务未运行？）' });
      return;
    }
    const id = `save_${Date.now()}_${++captureCounter}`;
    const timer = setTimeout(() => {
      capturePending.delete(id);
      resolve({ ok: false, error: '保存写入超时 — 本地 ModelSwap 服务可能版本过旧，请升级后重试' });
    }, 10000);
    capturePending.set(id, { resolve, timer });
    // Field-by-field on purpose: payload is the raw runtime message and
    // spreading it would clobber `type` with 'modelswap-manual-save'.
    ws.send(JSON.stringify({
      type: 'vault-save',
      id,
      key: payload.key,
      group: payload.group,
      desc: payload.desc,
      value: payload.value,
      force: payload.force === true,
    }));
  });
}

async function handleManualSave(msg: { key: string; group?: string; desc?: string; value: string; force?: boolean }): Promise<any> {
  const result = await sendVaultSave(msg);
  if (result.ok) {
    const preview = maskedPreview(result.masked);
    notifyBasic(
      `${msg.key} 已存入 MODELSWAP ✅${result.duplicate ? '（与现有值相同）' : ''}`,
      preview ? `值: ${preview}` : '',
    );
  }
  return result;
}

/**
 * Distinct vault group names for the create-form autocomplete. Read over
 * plain HTTP from the daemon (host_permissions make the SW fetch read-able);
 * only group labels leave the vault — never values.
 */
async function getVaultGroups(): Promise<{ groups: string[] }> {
  try {
    let port = serverPort;
    if (!port || ws?.readyState !== WebSocket.OPEN) port = await findServerPort();
    if (!port) return { groups: [] };
    const res = await fetch(`http://localhost:${port}/api/vault`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { groups: [] };
    const data = await res.json() as { secrets?: Array<{ group?: string }> };
    const groups = [...new Set(
      (data.secrets ?? [])
        .map((s) => (s.group ?? '').trim())
        .filter(Boolean),
    )].sort((a, b) => a.localeCompare(b, 'zh'));
    return { groups };
  } catch {
    return { groups: [] };
  }
}

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
      console.warn(`[MODELSWAP] Navigate to ${targetUrl} timed out after 15s`);
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
      // instead of forcing a second login in the MODELSWAP automation window.
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
