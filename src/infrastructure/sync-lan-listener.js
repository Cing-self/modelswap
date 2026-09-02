// LAN listener infrastructure. It owns the socket, blob file and pairing
// session state; HTTP route controllers remain in web/api/sync-lan.js.
const express = require('express');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DEFAULT_PORT = 3790;
const PORT_FALLBACK_COUNT = 10;
const BLOB_BODY_LIMIT = '25mb';
const PEER_ONLINE_MS = 6 * 60 * 1000;
const PEER_TTL_MS = 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;

function createLanListener({ core, homeDir = os.homedir }) {
  const blobPath = path.join(homeDir(), '.modelswap', 'sync', 'lan-blob.json');
  let server = null;
  let runningPort = null;
  let runningTokenHash = null;
  let lastError = null;
  let blobCache = null;
  let cachedMachineName;
  let pendingPairing = null;
  let identityCache = { at: 0, value: { name: '', id: null } };
  const recentPeers = new Map();

  function getMachineName() {
    if (cachedMachineName) return cachedMachineName;
    try {
      if (process.platform === 'darwin') {
        cachedMachineName = execSync('scutil --get ComputerName', {
          timeout: 2000,
        })
          .toString()
          .trim();
      }
    } catch {}
    if (!cachedMachineName) cachedMachineName = os.hostname();
    return cachedMachineName;
  }

  function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  function isPrivateV4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
    const [a, b] = parts;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  function listLanAddresses() {
    const addresses = [];
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal && isPrivateV4(net.address)) {
          addresses.push(net.address);
        }
      }
    }
    return [...new Set(addresses)];
  }

  function buildConnectionCode(address, port, token) {
    return `modelswap-lan://${address}:${port}/${token}?name=${encodeURIComponent(getMachineName())}`;
  }

  function createPairingCode() {
    pendingPairing = {
      code: crypto.randomBytes(6).toString('hex'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    return { ...pendingPairing };
  }

  function getPendingPairing() {
    if (pendingPairing && Date.now() > pendingPairing.expiresAt) pendingPairing = null;
    return pendingPairing ? { ...pendingPairing } : null;
  }

  function trackPeer(req) {
    const header = String(req.headers['x-modelswap-machine'] || '');
    const separator = header.lastIndexOf('#');
    if (separator <= 0) return;
    const id = header.slice(separator + 1).trim();
    if (!id) return;
    let name = header.slice(0, separator);
    try {
      name = decodeURIComponent(name);
    } catch {}
    const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    for (const [existingId, peer] of recentPeers) {
      if (existingId !== id && peer.name === name && peer.address === address) {
        recentPeers.delete(existingId);
      }
    }
    recentPeers.set(id, { id, name, address, lastSeen: Date.now() });
  }

  function getRecentPeers() {
    const now = Date.now();
    const peers = [];
    for (const [id, peer] of recentPeers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        recentPeers.delete(id);
      } else {
        peers.push({ ...peer, online: now - peer.lastSeen < PEER_ONLINE_MS });
      }
    }
    return peers.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async function getMachineIdentity() {
    if (Date.now() - identityCache.at < 30_000) return identityCache.value;
    let id = null;
    try {
      id = (await core.loadConfig()).sync?.machineId || null;
    } catch {}
    identityCache = { at: Date.now(), value: { name: getMachineName(), id } };
    return identityCache.value;
  }

  function checkToken(req, token) {
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided) return false;
    const expectedHash = Buffer.from(sha256Hex(token), 'hex');
    const providedHash = Buffer.from(sha256Hex(provided), 'hex');
    return (
      expectedHash.length === providedHash.length &&
      crypto.timingSafeEqual(expectedHash, providedHash)
    );
  }

  function isValidBlobShape(blob) {
    return (
      !!blob &&
      typeof blob === 'object' &&
      ['nonce', 'ciphertext', 'tag'].every(
        (key) => typeof blob[key] === 'string' && /^[0-9a-f]+$/i.test(blob[key]),
      )
    );
  }

  async function loadPersistedBlob() {
    blobCache = null;
    try {
      if (await fs.pathExists(blobPath)) blobCache = await fs.readJson(blobPath);
    } catch {}
  }

  async function persistBlob(blob) {
    blobCache = blob;
    try {
      await fs.ensureDir(path.dirname(blobPath));
      await fs.writeJson(blobPath, blob, { spaces: 2 });
    } catch (error) {
      console.error('LAN sync blob persist failed:', error.message);
    }
  }

  function createListenerApp(token) {
    const app = express();
    app.use(express.json({ limit: BLOB_BODY_LIMIT }));
    app.post('/pair', async (req, res) => {
      const code = String(req.body?.code || '').trim();
      const claimedUserId = String(req.body?.userId || '').trim();
      const session = getPendingPairing();
      if (!session) return res.status(401).json({ error: '配对码无效或已过期' });
      const receivedHash = Buffer.from(sha256Hex(code), 'hex');
      const expectedHash = Buffer.from(sha256Hex(session.code), 'hex');
      if (
        code.length !== session.code.length ||
        !crypto.timingSafeEqual(receivedHash, expectedHash)
      ) {
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
        return res.status(403).json({
          error: '两台设备的同步密码不一致，请先在两台设备上设置为相同的同步密码',
        });
      }
      pendingPairing = null;
      core.appendLog('lan-pair-exchange', 'lan', true, 'pairing code redeemed');
      return res.json({ version: 1, token, machineName: getMachineName(), machineId, userId });
    });
    app.use((req, res, next) => {
      if (!checkToken(req, token)) return res.status(401).json({ error: 'unauthorized' });
      trackPeer(req);
      return next();
    });
    app.get('/ping', async (_req, res) => {
      try {
        const config = await core.loadConfig();
        let userId = null;
        try {
          ({ userId } = await core.resolveSyncKeys(config));
        } catch {}
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
    app.get('/blob', (_req, res) => {
      if (!blobCache) return res.status(404).json({ error: 'no data' });
      return res.json(blobCache);
    });
    app.put('/blob', async (req, res) => {
      if (!isValidBlobShape(req.body)) {
        return res.status(400).json({ error: 'invalid blob' });
      }
      await persistBlob(req.body);
      core.appendLog('lan-blob-receive', 'lan', true, `${req.body.ciphertext.length} bytes ciphertext`);
      return res.json({ success: true });
    });
    return app;
  }

  async function stopLanSyncServer() {
    if (!server) return;
    const listener = server;
    server = null;
    runningPort = null;
    runningTokenHash = null;
    await new Promise((resolve) => {
      listener.close(resolve);
      listener.closeAllConnections?.();
    });
  }

  async function startLanSyncServer(port, token, { allowPortFallback = true } = {}) {
    if (server) await stopLanSyncServer();
    lastError = null;
    await loadPersistedBlob();
    let listener = null;
    let actualPort = null;
    let lastListenError = null;
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
        if (error.code !== 'EADDRINUSE' || !allowPortFallback) break;
        candidate.removeAllListeners();
      }
    }
    if (!listener || !actualPort) {
      lastError =
        lastListenError?.code === 'EADDRINUSE'
          ? '局域网同步暂时无法启动，请稍后重试'
          : lastListenError?.message || '局域网同步服务启动失败';
      core.appendLog('lan-sync-start', 'lan', false, lastError);
      console.error(`LAN sync listener failed to start: ${lastError}`);
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

  function getStatus() {
    return { running: !!server, port: runningPort, error: lastError };
  }

  async function applyConfig() {
    const config = await core.loadConfig();
    const lan = config.sync?.lan || {};
    if (!lan.enabled || !lan.token) {
      if (server) await stopLanSyncServer();
      return getStatus();
    }
    const port = lan.port || DEFAULT_PORT;
    if (server && runningPort === port && runningTokenHash === sha256Hex(lan.token)) {
      return getStatus();
    }
    const result = await startLanSyncServer(port, lan.token);
    if (result.running && result.port !== port) {
      await core.setLanField('port', result.port);
      const localPlatform = config.sync.platforms?.lan;
      if (localPlatform?.baseUrl && /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(localPlatform.baseUrl)) {
        await core.setPlatformField('lan', 'baseUrl', `http://127.0.0.1:${result.port}`);
      }
    }
    return result;
  }

  return {
    applyConfig,
    buildConnectionCode,
    createPairingCode,
    getMachineIdentity,
    getPendingPairing,
    getRecentPeers,
    getStatus,
    listLanAddresses,
    startLanSyncServer,
    stopLanSyncServer,
  };
}

module.exports = {
  DEFAULT_PORT,
  PORT_FALLBACK_COUNT,
  createLanListener,
};
