/**
 * MODELSWAP extension protocol — shared types between MODELSWAP server and Chrome extension.
 *
 * Atomic-capability protocol: the extension exposes generic actions (exec, navigate,
 * network-capture, etc.) and the MODELSWAP server orchestrates platform-specific flows
 * (zhipu, volcengine, minimax) by composing these atoms. Adding a new platform
 * only requires server-side changes — the extension never needs to know platform
 * specifics.
 *
 * Inspired by opencli's protocol.
 */
// ─── Connection configuration ───────────────────────────────────────
// The MODELSWAP server pins port 3780 and only climbs to 3781+ when 3780 is
// already taken by another process. The extension probes these ports in
// order and locks onto the first one that answers, so a fallback port no
// longer breaks the extension.
/** Default MODELSWAP server port */
export const MODELSWAP_PORT = 3780;
/** All ports the MODELSWAP server may occupy (probed in order). */
export const MODELSWAP_PORTS = [3780, 3781, 3782, 3783, 3784, 3785];
export const MODELSWAP_HOST = 'localhost';
/** WebSocket endpoint for a given port — extension connects here for the command stream */
export const wsUrl = (port) => `ws://${MODELSWAP_HOST}:${port}/ws/extension`;
/** Lightweight health-check endpoint — probed before each WebSocket attempt.
 *  This avoids ERR_CONNECTION_REFUSED noise in the extension console, since
 *  new WebSocket() failures are not catchable via try/catch. */
export const pingUrl = (port) => `http://${MODELSWAP_HOST}:${port}/ping`;
/** One-time WS auth token endpoint for a given port. The server only answers
 *  (CORS) extension origins, so ordinary web pages can neither fetch a token
 *  nor use the WS command channel. */
export const tokenUrl = (port) => `http://${MODELSWAP_HOST}:${port}/api/extension/token`;
/** Default-port URLs (kept for backwards compatibility). */
export const MODELSWAP_WS_URL = wsUrl(MODELSWAP_PORT);
export const MODELSWAP_PING_URL = pingUrl(MODELSWAP_PORT);
export const MODELSWAP_TOKEN_URL = tokenUrl(MODELSWAP_PORT);
// ─── Reconnect tuning ───────────────────────────────────────────────
/** Base reconnect delay for extension WebSocket (ms) */
export const WS_RECONNECT_BASE_DELAY = 2000;
/** Max reconnect delay (ms) — kept short since MODELSWAP server is long-lived */
export const WS_RECONNECT_MAX_DELAY = 5000;
