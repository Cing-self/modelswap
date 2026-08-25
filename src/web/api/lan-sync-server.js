// LAN peer sync listener: a dedicated, token-authenticated HTTP service that
// stores the latest encrypted sync blob — same semantics as a WebDAV server
// storing a file. It never serializes local state on request: blob timestamps
// belong to the pushing machine, and the pull-side merge guards depend on that.
const express = require('express');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const core = require('./cloud-sync-core');

const DEFAULT_PORT = 3790;
// Keep the fallback range intentionally small and predictable. The selected
// port is persisted below, so it remains stable after the first allocation.
const PORT_FALLBACK_COUNT = 10;
const BLOB_BODY_LIMIT = '25mb';
const BLOB_PATH = path.join(os.homedir(), '.okit', 'sync', 'lan-blob.json');

let server = null;
let runningPort = null;
let runningTokenHash = null;
let lastError = null;
let blobCache = null;
let cachedMachineName;

// --- Peer tracking (hub side) ---------------------------------------------
// Devices that recently talked to this listener identify themselves via the
// x-okit-machine header ("<encodedName>#<machineId>"). In-memory only: a
// restart clears the list and peers re-appear within one pull cycle (≤5 min).
// "Online" must tolerate the 5-minute pull interval, hence the 6-minute bar.
const PEER_ONLINE_MS = 6 * 60 * 1000;
const PEER_TTL_MS = 60 * 60 * 1000;
const recentPeers = new Map(); // machineId -> { id, name, address, lastSeen }

function trackPeer(req) {
  const header = String(req.headers['x-okit-machine'] || '');
  const sep = header.lastIndexOf('#');
  if (sep <= 0) return;
  const id = header.slice(sep + 1).trim();
  if (!id) return;
  let name = header.slice(0, sep);
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  recentPeers.set(id, { id, name, address, lastSeen: Date.now() });
}

function getRecentPeers() {
  const now = Date.now();
  const peers = [];
  for (const [id, peer] of recentPeers) {
    if (now - peer.lastSeen > PEER_TTL_MS) { recentPeers.delete(id); continue; }
    peers.push({ ...peer, online: now - peer.lastSeen < PEER_ONLINE_MS });
  }
  return peers.sort((a, b) => b.lastSeen - a.lastSeen);
}

// This machine's display identity, for the x-okit-machine header the adapter
// sends with every peer request. Cached — it hits user.json on refresh.
let identityCache = { at: 0, value: { name: '', id: null } };
async function getMachineIdentity() {
  if (Date.now() - identityCache.at < 30_000) return identityCache.value;
  let id = null;
  try {
    const config = await core.loadConfig();
    id = config.sync?.machineId || null;
  } catch { /* stay null until the first push assigns a machineId */ }
  identityCache = { at: Date.now(), value: { name: getMachineName(), id } };
  return identityCache.value;
}

// --- Pairing sessions -------------------------------------------------------
// A pairing code is a short-lived, single-use secret: a spoke presents it to
// POST /pair within the window and receives the persistent access token.
// Only one session may be active at a time; generating a new code invalidates
// the previous one. In-memory — a restart simply clears outstanding codes.
const PAIRING_TTL_MS = 5 * 60 * 1000;
let pendingPairing = null; // { code, expiresAt }

function createPairingCode() {
  const code = crypto.randomBytes(6).toString('hex');
  pendingPairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
  return { ...pendingPairing };
}

function getPendingPairing() {
  if (pendingPairing && Date.now() > pendingPairing.expiresAt) pendingPairing = null;
  return pendingPairing ? { ...pendingPairing } : null;
}

function getMachineName() {
  if (cachedMachineName) return cachedMachineName;
  try {
    if (process.platform === 'darwin') {
      cachedMachineName = execSync('scutil --get ComputerName', { timeout: 2000 }).toString().trim();
    }
  } catch {}
  if (!cachedMachineName) cachedMachineName = os.hostname();
  return cachedMachineName;
}

// Candidate addresses advertised to peers: RFC1918 IPv4 plus the Tailscale
// CGNAT range (100.64/10), which behaves like a private LAN segment.
function isPrivateV4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function listLanAddresses() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (isPrivateV4(net.address)) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

function buildConnectionCode(address, port, token) {
  const name = encodeURIComponent(getMachineName());
  return `okit-lan://${address}:${port}/${token}?name=${name}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Timing-safe token check over sha256 digests so token length never leaks.
function checkToken(req, token) {
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided) return false;
  const a = Buffer.from(sha256Hex(provided), 'hex');
  const b = Buffer.from(sha256Hex(token), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidBlobShape(blob) {
  return !!blob && typeof blob === 'object'
    && typeof blob.nonce === 'string' && /^[0-9a-f]+$/i.test(blob.nonce)
    && typeof blob.ciphertext === 'string' && /^[0-9a-f]+$/i.test(blob.ciphertext)
    && typeof blob.tag === 'string' && /^[0-9a-f]+$/i.test(blob.tag);
}

async function loadPersistedBlob() {
  blobCache = null;
  try {
    if (await fs.pathExists(BLOB_PATH)) blobCache = await fs.readJson(BLOB_PATH);
  } catch {
    blobCache = null;
  }
}

async function persistBlob(blob) {
  blobCache = blob;
  try {
    await fs.ensureDir(path.dirname(BLOB_PATH));
    await fs.writeJson(BLOB_PATH, blob, { spaces: 2 });
  } catch (error) {
    console.error('LAN sync blob persist failed:', error.message);
  }
}

function createListenerApp(token) {
  const app = express();
  app.use(express.json({ limit: BLOB_BODY_LIMIT }));

  // Pairing exchange — must sit BEFORE the Bearer auth middleware: the caller
  // doesn't hold the access token yet, the fresh pairing code is the
  // credential. Single-use: only a password-verified exchange consumes it.
  app.post('/pair', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    const claimedUserId = String(req.body?.userId || '').trim();
    const session = getPendingPairing();
    if (!session) {
      return res.status(401).json({ error: '配对码无效或已过期' });
    }
    const a = Buffer.from(sha256Hex(code), 'hex');
    const b = Buffer.from(sha256Hex(session.code), 'hex');
    if (code.length !== session.code.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: '配对码无效或已过期' });
    }
    let machineId = null;
    let userId = null;
    try {
      const config = await core.loadConfig();
      machineId = config.sync?.machineId || null;
      ({ userId } = await core.resolveSyncKeys(config));
    } catch {
      return res.status(409).json({ error: '主设备尚未设置同步密码，无法配对' });
    }
    if (!userId || !claimedUserId || claimedUserId !== userId) {
      // Keep the session alive so the user can correct the password and retry
      // without asking the primary device to generate another pairing code.
      return res.status(403).json({ error: '两台设备的同步密码不一致，请先在两台设备上设置为相同的同步密码' });
    }
    pendingPairing = null;
    core.appendLog('lan-pair-exchange', 'lan', true, 'pairing code redeemed');
    res.json({
      version: 1,
      token,
      machineName: getMachineName(),
      machineId,
      userId,
    });
  });

  app.use((req, res, next) => {
    if (!checkToken(req, token)) return res.status(401).json({ error: 'unauthorized' });
    trackPeer(req);
    next();
  });

  // Identity + capability probe for pairing and connection tests. userId is a
  // password-derived identifier (not a decryption key): peers compare it to
  // detect sync-password mismatches before any blob exchange fails to decrypt.
  app.get('/ping', async (req, res) => {
    try {
      const config = await core.loadConfig();
      let userId = null;
      try {
        ({ userId } = await core.resolveSyncKeys(config));
      } catch { /* no sync password configured yet */ }
      res.json({
        version: 1,
        machineName: getMachineName(),
        machineId: config.sync?.machineId || null,
        userId,
        hasBlob: !!blobCache,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/blob', (req, res) => {
    if (!blobCache) return res.status(404).json({ error: 'no data' });
    res.json(blobCache);
  });

  app.put('/blob', async (req, res) => {
    if (!isValidBlobShape(req.body)) {
      return res.status(400).json({ error: 'invalid blob' });
    }
    await persistBlob(req.body);
    core.appendLog('lan-blob-receive', 'lan', true, `${req.body.ciphertext.length} bytes ciphertext`);
    res.json({ success: true });
  });

  return app;
}

async function startLanSyncServer(port, token) {
  if (server) await stopLanSyncServer();
  lastError = null;
  await loadPersistedBlob();
  let listener = null;
  let actualPort = null;
  let lastListenError = null;

  // Prefer the configured port. A pairing code always carries the actual
  // endpoint, and applyConfig persists a fallback, so allocation is stable.
  for (let offset = 0; offset <= PORT_FALLBACK_COUNT; offset += 1) {
    const candidatePort = port + offset;
    const candidate = http.createServer(createListenerApp(token));
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(candidatePort, '0.0.0.0', () => {
          candidate.off('error', reject);
          resolve();
        });
      });
      listener = candidate;
      actualPort = candidatePort;
      break;
    } catch (error) {
      lastListenError = error;
      if (error.code !== 'EADDRINUSE') break;
      candidate.removeAllListeners();
    }
  }

  if (!listener || !actualPort) {
    lastError = lastListenError?.code === 'EADDRINUSE'
      ? '局域网同步暂时无法启动，请稍后重试'
      : (lastListenError?.message || '局域网同步服务启动失败');
    core.appendLog('lan-sync-start', 'lan', false, lastError);
    console.error(`LAN sync listener failed to start: ${lastError}`);
    server = null;
    runningPort = null;
    runningTokenHash = null;
    return { running: false, error: lastError };
  }

  listener.on('error', (error) => {
    lastError = error.message;
    console.error('LAN sync listener error:', error.message);
  });

  server = listener;
  runningPort = actualPort;
  runningTokenHash = sha256Hex(token);
  core.appendLog('lan-sync-start', 'lan', true, `listening on 0.0.0.0:${actualPort}`);
  return { running: true, port: actualPort, autoAssigned: actualPort !== port };
}

async function stopLanSyncServer() {
  if (!server) return;
  const listener = server;
  server = null;
  runningPort = null;
  runningTokenHash = null;
  // Stop accepting new connections first, then terminate keep-alive sockets
  // (e.g. undici fetch pools) so close() can finish without leaking a listener.
  await new Promise((resolve) => {
    listener.close(() => resolve());
    if (typeof listener.closeAllConnections === 'function') {
      listener.closeAllConnections();
    }
  });
}

function getStatus() {
  return { running: !!server, port: runningPort, error: lastError };
}

// Single entry point for startup and config changes: start / stop / restart
// the listener so it always matches sync.lan on disk.
async function applyConfig() {
  const config = await core.loadConfig();
  const lan = config.sync?.lan || {};
  if (!lan.enabled || !lan.token) {
    if (server) await stopLanSyncServer();
    return getStatus();
  }

  const port = lan.port || DEFAULT_PORT;
  const tokenHash = sha256Hex(lan.token);
  if (server && runningPort === port && runningTokenHash === tokenHash) {
    return getStatus();
  }
  const result = await startLanSyncServer(port, lan.token);
  // A local loopback target is this hub's own storage endpoint. Keep it in
  // lockstep with an automatically assigned port; remote spokes stay intact.
  if (result.running && result.port !== port) {
    config.sync.lan = { ...lan, port: result.port };
    const localPlatform = config.sync.platforms?.lan;
    if (localPlatform?.baseUrl && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(localPlatform.baseUrl)) {
      config.sync.platforms.lan = { ...localPlatform, baseUrl: `http://127.0.0.1:${result.port}` };
    }
    await core.saveConfig(config);
  }
  return result;
}

module.exports = {
  DEFAULT_PORT,
  PORT_FALLBACK_COUNT,
  applyConfig,
  startLanSyncServer,
  stopLanSyncServer,
  getStatus,
  listLanAddresses,
  buildConnectionCode,
  getRecentPeers,
  getMachineIdentity,
  createPairingCode,
  getPendingPairing,
};
