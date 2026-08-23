/**
 * WebSocket bridge between OKIT server and Chrome Extension (v2 atomic-capability protocol).
 *
 * Extension connects via ws://localhost:3780/ws/extension and exposes generic
 * atoms: exec, navigate, network-capture-start, network-capture-read, etc.
 * OKIT server orchestrates platform-specific flows by composing these atoms
 * via sendCommand().
 *
 * Protocol message shapes:
 *   Client → Server:       { type: 'auth', token }     (one-time token handshake)
 *   Server → Client:       { type: 'auth-ok' } | { type: 'auth-failed', error }
 *   Server → Extension:    { id, action, ...params }   (a Command)
 *   Extension → Server:    { id, ok, data?, error? }   (a Result)
 *                          { type: 'hello', version }  (version handshake after auth)
 *                          { type: 'log', level, msg } (forwarded console output)
 *
 * Security model:
 *   The channel can navigate tabs, execute page JS, and read cookies, so it is
 *   locked down twice:
 *   1. Origin gate — the WebSocket upgrade is rejected unless the client's
 *      Origin is a browser-extension context (chrome-extension:// or
 *      moz-extension://). A regular web page cannot open the socket at all.
 *   2. One-time token handshake — even a socket that passes the origin gate
 *      stays mute until it presents a token issued by
 *      GET /api/extension/token (which itself only answers extension origins
 *      via CORS). Tokens are single-use and expire in 2 minutes.
 *
 * Legacy support: sendToExtension({ type: 'auto-create', ... }) is kept for
 * volcengine/minimax until they migrate to the atomic protocol (Phase 3).
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PENDING = new Map(); // requestId -> { resolve, reject, timer }
let extWs = null;
let reqCounter = 0;
let extensionVersion = null;
let extensionProtocol = null;

// ─── One-time auth tokens ────────────────────────────────────────────
// token -> expiry (ms epoch). Issued by /api/extension/token, consumed by the
// first message on a new WebSocket connection.

const TOKEN_TTL_MS = 2 * 60 * 1000;
const AUTH_TIMEOUT_MS = 5000;
const authTokens = new Map();

function isExtensionOrigin(origin) {
  return typeof origin === 'string' &&
    (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin));
}

function issueExtensionToken(ttlMs = TOKEN_TTL_MS) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  for (const [t, exp] of authTokens) {
    if (exp <= now) authTokens.delete(t);
  }
  authTokens.set(token, now + ttlMs);
  return token;
}

function consumeExtensionToken(token) {
  const exp = authTokens.get(token);
  if (!exp) return false;
  authTokens.delete(token); // single use
  return exp > Date.now();
}

function setupWebSocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/extension',
    // Origin gate: only browser-extension contexts may complete the upgrade.
    verifyClient: (info) => isExtensionOrigin(info.req.headers.origin),
  });

  wss.on('connection', (ws, req) => {
    console.log(`[WS] Extension socket from ${req.socket.remoteAddress} (origin ${req.headers.origin || 'none'}) — awaiting token`);

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        try { ws.send(JSON.stringify({ type: 'auth-failed', error: 'auth timeout' })); } catch { /* closing anyway */ }
        ws.close(4401, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (!authenticated) {
        if (msg.type === 'auth' && typeof msg.token === 'string' && consumeExtensionToken(msg.token)) {
          authenticated = true;
          clearTimeout(authTimer);
          // Single-extension model: only an AUTHENTICATED connection can evict
          // the previous one. Unauthenticated sockets never touch extWs.
          if (extWs && extWs !== ws) {
            extWs.close();
          }
          extWs = ws;
          ws.send(JSON.stringify({ type: 'auth-ok' }));
          console.log('[WS] Extension authenticated');
        } else if (msg.type === 'auth') {
          console.warn('[WS] Extension auth failed: invalid or expired token');
          try { ws.send(JSON.stringify({ type: 'auth-failed', error: 'invalid or expired token' })); } catch { /* ignore */ }
          ws.close(4401, 'invalid token');
        }
        return;
      }

      // Version handshake (extension sends this on connect)
      if (msg.type === 'hello') {
        extensionVersion = msg.version;
        extensionProtocol = msg.protocol || 'legacy';
        console.log(`[WS] Extension hello: v${msg.version} protocol=${extensionProtocol}`);
        return;
      }

      // Forwarded console log from the service worker
      if (msg.type === 'log') {
        const level = msg.level || 'info';
        const prefix = level === 'error' ? '[ext-error]' : level === 'warn' ? '[ext-warn]' : '[ext-log]';
        console.log(`${prefix} ${msg.msg || ''}`);
        return;
      }

      // Ignore other non-response keepalive/pong messages
      if (msg.type === 'debug' || msg.type === 'keepalive' || msg.type === 'pong') return;

      // Result correlation by id (covers both atomic Result and legacy responses)
      const pending = PENDING.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      PENDING.delete(msg.id);

      // Atomic protocol: { id, ok, data?, error? }
      if (msg.ok === false) {
        pending.reject(new Error(msg.error || 'Extension command failed'));
      } else if (msg.ok === true) {
        pending.resolve(msg);
      } else if (msg.type === 'error') {
        // Legacy error shape
        pending.reject(new Error(msg.error));
      } else {
        // Legacy success shape (type: 'key-created' | 'login-required' | 'key-not-found' | etc.)
        pending.resolve(msg);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (extWs === ws) {
        console.log('[WS] Extension disconnected');
        extWs = null;
        extensionVersion = null;
        extensionProtocol = null;
        // Reject every pending request — prevents callers from hanging forever
        for (const [id, pending] of PENDING.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension disconnected'));
          PENDING.delete(id);
        }
      }
    });
  });

  console.log('[WS] WebSocket server ready on /ws/extension (origin-gated + one-time token)');
  return wss;
}

/**
 * Send an atomic-capability command to the extension and wait for the result.
 * This is the primary API for platform orchestration (used by auto-create.js).
 *
 * @param {string} action - one of: exec, navigate, tabs, cookies, screenshot,
 *   focus-window, close-window, cdp, set-file-input, insert-text, network-capture-start,
 *   network-capture-read
 * @param {object} params - action-specific parameters (code, url, pattern, ...)
 * @param {number} timeoutMs - default 60s
 * @returns {Promise<{id, ok, data}>} the extension's Result
 */
function sendCommand(action, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!extWs || extWs.readyState !== 1) {
      reject(new Error('Chrome Extension not connected. Please install the OKIT extension (chrome://extensions → Load unpacked → select okit/extension).'));
      return;
    }

    const id = `cmd_${Date.now()}_${++reqCounter}`;
    const timer = setTimeout(() => {
      PENDING.delete(id);
      reject(new Error(`Extension command "${action}" timed out (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    PENDING.set(id, { resolve, reject, timer });

    extWs.send(JSON.stringify({ id, action, ...params }));
  });
}

/**
 * Send a legacy-shape command to the Chrome Extension and wait for response.
 * Kept for volcengine/minimax until they migrate to the atomic protocol.
 *
 * @param {object} command - must include a `type` field (e.g. {type:'auto-create',...})
 * @param {number} timeoutMs - default 60s
 */
function sendToExtension(command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!extWs || extWs.readyState !== 1) {
      reject(new Error('Chrome Extension not connected. Please install the OKIT extension.'));
      return;
    }

    const id = String(++reqCounter);
    const timer = setTimeout(() => {
      PENDING.delete(id);
      reject(new Error('Extension command timed out'));
    }, timeoutMs);

    PENDING.set(id, { resolve, reject, timer });

    extWs.send(JSON.stringify({ id, ...command }));
  });
}

/**
 * Check if extension is connected.
 */
function isExtensionConnected() {
  return extWs !== null && extWs.readyState === 1;
}

/**
 * Get the connected extension's reported version (null if not connected or pre-hello).
 */
function getExtensionVersion() {
  return extensionVersion;
}

/**
 * Get the connected extension's reported protocol ('atomic-v2' for the new
 * extension, 'legacy' for the old v1, or null if not connected/pre-hello).
 */
function getExtensionProtocol() {
  return extensionProtocol;
}

module.exports = {
  setupWebSocket,
  sendCommand,        // atomic-capability API (new, preferred)
  sendToExtension,    // legacy shape (volcengine/minimax until Phase 3)
  isExtensionConnected,
  getExtensionVersion,
  getExtensionProtocol,
  issueExtensionToken, // one-time WS auth token (used by /api/extension/token)
  consumeExtensionToken, // test hook: validate + burn a token
  isExtensionOrigin,   // origin gate helper (used by /api/extension/token)
};
