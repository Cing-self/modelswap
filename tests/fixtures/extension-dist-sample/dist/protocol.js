/**
 * OKIT extension protocol — shared types between OKIT server and Chrome extension.
 *
 * Atomic-capability protocol: the extension exposes generic actions (exec, navigate,
 * network-capture, etc.) and the OKIT server orchestrates platform-specific flows
 * (zhipu, volcengine, minimax) by composing these atoms. Adding a new platform
 * only requires server-side changes — the extension never needs to know platform
 * specifics.
 *
 * Inspired by opencli's protocol.
 */
// ─── Connection configuration ───────────────────────────────────────
// The OKIT server pins port 3780 and only climbs to 3781+ when 3780 is
// already taken by another process. The extension probes these ports in
// order and locks onto the first one that answers, so a fallback port no
// longer breaks the extension.
/** Default OKIT server port */
export const OKIT_PORT = 3780;
/** All ports the OKIT server may occupy (probed in order). */
export const OKIT_PORTS = [3780, 3781, 3782, 3783, 3784, 3785];
export const OKIT_HOST = 'localhost';
/** WebSocket endpoint for a given port — extension connects here for the command stream */
export const wsUrl = (port) => `ws://${OKIT_HOST}:${port}/ws/extension`;
/** Lightweight health-check endpoint — probed before each WebSocket attempt.
 *  This avoids ERR_CONNECTION_REFUSED noise in the extension console, since
 *  new WebSocket() failures are not catchable via try/catch. */
export const pingUrl = (port) => `http://${OKIT_HOST}:${port}/ping`;
/** One-time WS auth token endpoint for a given port. The server only answers
 *  (CORS) extension origins, so ordinary web pages can neither fetch a token
 *  nor use the WS command channel. */
export const tokenUrl = (port) => `http://${OKIT_HOST}:${port}/api/extension/token`;
/** Default-port URLs (kept for backwards compatibility). */
export const OKIT_WS_URL = wsUrl(OKIT_PORT);
export const OKIT_PING_URL = pingUrl(OKIT_PORT);
export const OKIT_TOKEN_URL = tokenUrl(OKIT_PORT);
// ─── Reconnect tuning ───────────────────────────────────────────────
/** Base reconnect delay for extension WebSocket (ms) */
export const WS_RECONNECT_BASE_DELAY = 2000;
/** Max reconnect delay (ms) — kept short since OKIT server is long-lived */
export const WS_RECONNECT_MAX_DELAY = 5000;
