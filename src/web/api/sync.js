const core = require('./cloud-sync-core');
const scheduler = require('./sync-scheduler');
const lanServer = require('./lan-sync-server');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Friendly machine label: the macOS ComputerName (what the user set in System
// Settings), falling back to the hostname on other platforms. Cached — it
// rarely changes and scutil shouldn't run on every status poll.
let cachedMachineName;
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

async function handlePush(req, res) {
  try {
    if (scheduler.isBusy()) return res.status(409).json({ error: '同步正在进行中，请稍候再试' });
    const { busy, error, result } = await scheduler.runExclusive(() => core.syncPush());
    if (busy) return res.status(409).json({ error: '同步正在进行中，请稍候再试' });
    if (error) throw error;
    res.json({ success: true, message: `已推送 ${result.secrets} 个密钥 → ${result.platform}`, ...result });
  } catch (error) {
    console.error('Sync push error:', error);
    res.status(500).json({ error: error.message || '推送失败' });
  }
}

async function handlePull(req, res) {
  try {
    if (scheduler.isBusy()) return res.status(409).json({ error: '同步正在进行中，请稍候再试' });
    const { busy, error, result } = await scheduler.runExclusive(() => core.syncPull());
    if (busy) return res.status(409).json({ error: '同步正在进行中，请稍候再试' });
    if (error) throw error;
    const kept = [];
    if (!result.agentApplied) kept.push('Agent 配置保留本机');
    if (!result.providersApplied) kept.push('模型商配置保留本机');
    const keptNote = kept.length > 0 ? `（${kept.join('，')}）` : '';
    res.json({
      success: true,
      message: `拉取完成：新增 ${result.added} 个，更新 ${result.updated} 个${keptNote}`,
      ...result,
    });
  } catch (error) {
    console.error('Sync pull error:', error);
    if (error.message?.includes('Unsupported state') || error.message?.includes('AUTHENTICATION_FAILED')) {
      return res.status(400).json({ error: '同步密码不正确，无法解密远端数据' });
    }
    res.status(500).json({ error: error.message || '拉取失败' });
  }
}

async function handleStatus(req, res) {
  try {
    const config = await core.loadConfig();
    const sync = config.sync || {};
    const platforms = sync.platforms || {};
    const enabledIds = Object.keys(platforms).filter(id => platforms[id]?.enabled);
    const primary = enabledIds.includes(sync.syncPlatform) ? sync.syncPlatform : enabledIds[0] || null;

    res.json({
      machineId: sync.machineId || null,
      machineName: getMachineName(),
      lastSyncAt: sync.lastSyncAt || null,
      platformId: primary,
      platforms: enabledIds,
      hasPassword: !!sync.password,
      autoSync: !!sync.autoSync,
      autoBusy: scheduler.isBusy(),
      localDirty: scheduler.hasPendingLocalChanges(sync),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
}

async function handleExportCode(req, res) {
  try {
    const result = await core.exportSyncCode(req.body?.password);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Sync code export error:', error);
    res.status(500).json({ error: error.message || '导出同步码失败' });
  }
}

async function handleImportCode(req, res) {
  try {
    const { code, password } = req.body || {};
    if (!code) return res.status(400).json({ error: '同步码不能为空' });
    const result = await core.importSyncCode(code, password);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Sync code import error:', error);
    const status = error.message?.includes('同步密码不正确') || error.message?.includes('格式不正确') ? 400 : 500;
    res.status(status).json({ error: error.message || '导入同步码失败' });
  }
}

// --- LAN peer sync ---------------------------------------------------------

const LAN_CODE_PREFIX = 'okit-lan://';

function isLoopbackUrl(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(String(baseUrl || ''));
}

// Spoke-side liveness probe of the configured peer hub, cached so the 60s UI
// poll never hammers the peer with pings.
let peerProbeCache = { at: 0, value: null };
async function probeRemotePeer(platConfig) {
  if (Date.now() - peerProbeCache.at < 30_000) return peerProbeCache.value;
  const value = await (async () => {
    try {
      const resolved = await core.resolveVaultRefs(platConfig, 'lan');
      const res = await fetch(`${resolved.baseUrl}/ping`, {
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { online: false, url: resolved.baseUrl };
      const info = await res.json();
      return { online: true, url: resolved.baseUrl, name: info.machineName || '', id: info.machineId || null };
    } catch {
      return { online: false, url: platConfig.baseUrl };
    }
  })();
  peerProbeCache = { at: Date.now(), value };
  return value;
}

// One call feeding the whole "Device Sync" settings section: machine identity,
// device list (hub: recently seen peers; spoke: probed peer), cloud platform
// summary, pairing codes. Kept separate from the legacy /status and /lan/status
// endpoints, which stay untouched.
async function handleSyncOverview(req, res) {
  try {
    const config = await core.loadConfig();
    const sync = config.sync || {};
    const platforms = sync.platforms || {};
    const lan = sync.lan || {};

    const enabledIds = Object.keys(platforms).filter(id => platforms[id]?.enabled);
    const cloudIds = enabledIds.filter(id => id !== 'lan');
    const lanPlatform = platforms.lan || null;
    const isSpoke = !!lanPlatform?.enabled && !!lanPlatform.baseUrl && !isLoopbackUrl(lanPlatform.baseUrl);

    const status = lanServer.getStatus();
    const port = status.running ? status.port : (lan.port || lanServer.DEFAULT_PORT);
    const addresses = lanServer.listLanAddresses();
    // Only an active pairing session produces codes; never embed the
    // persistent access token here.
    const pairing = lanServer.getPendingPairing();
    const codes = pairing && lan.enabled
      ? addresses.map(address => ({ address, code: lanServer.buildConnectionCode(address, port, pairing.code) }))
      : [];

    const devices = [];
    for (const peer of lanServer.getRecentPeers()) {
      if (peer.id === sync.machineId) continue; // own loopback traffic
      devices.push({ ...peer, lastSeen: new Date(peer.lastSeen).toISOString() });
    }

    let peer = null;
    if (isSpoke) {
      peer = await probeRemotePeer(lanPlatform);
    }

    res.json({
      machine: {
        id: sync.machineId || null,
        name: getMachineName(),
        role: lan.enabled ? 'hub' : (isSpoke ? 'spoke' : 'none'),
      },
      hasPassword: !!sync.password,
      autoSync: !!sync.autoSync,
      lastSyncAt: sync.lastSyncAt || null,
      lan: {
        enabled: !!lan.enabled,
        running: status.running,
        port,
        error: status.error,
        codes,
      },
      peer,
      devices,
      cloudPlatforms: cloudIds,
      lanPlatformEnabled: !!lanPlatform?.enabled,
      lanPlatformUrl: lanPlatform?.baseUrl || null,
    });
  } catch (error) {
    console.error('Sync overview error:', error);
    res.status(500).json({ error: error.message || '获取同步总览失败' });
  }
}

function parseConnectionCode(raw) {
  const code = String(raw || '').trim();
  if (!code.startsWith(LAN_CODE_PREFIX)) {
    throw new Error('配对码格式不正确，应以 okit-lan:// 开头');
  }
  let url;
  try {
    // okit-lan://host:port/token → parse by swapping in the http scheme.
    url = new URL(`http:${code.slice(LAN_CODE_PREFIX.length - 2)}`);
  } catch {
    throw new Error('配对码格式不正确');
  }
  const token = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!url.hostname || !token) throw new Error('配对码缺少对端地址或令牌');
  return {
    baseUrl: `http://${url.host}`,
    token,
    name: url.searchParams.get('name') || '',
  };
}

async function buildLanStatus() {
  const config = await core.loadConfig();
  const sync = config.sync || {};
  const lan = sync.lan || {};
  const status = lanServer.getStatus();
  const port = status.running ? status.port : (lan.port || lanServer.DEFAULT_PORT);
  const addresses = lanServer.listLanAddresses();
  // Codes come from the active pairing session only — the persistent access
  // token must never appear in any status payload.
  const pairing = lanServer.getPendingPairing();
  const codes = pairing
    ? addresses.map(address => ({ address, code: lanServer.buildConnectionCode(address, port, pairing.code) }))
    : [];
  const platformBaseUrl = sync.platforms?.lan?.baseUrl || null;
  return {
    enabled: !!lan.enabled,
    running: status.running,
    port,
    error: status.error,
    addresses,
    codes,
    peer: platformBaseUrl && !isLoopbackUrl(platformBaseUrl) ? platformBaseUrl : null,
    platformEnabled: !!sync.platforms?.lan?.enabled,
    hasPassword: !!sync.password,
    autoSync: !!sync.autoSync,
    machineName: getMachineName(),
  };
}

async function handleLanStatus(req, res) {
  try {
    res.json(await buildLanStatus());
  } catch (error) {
    console.error('LAN sync status error:', error);
    res.status(500).json({ error: error.message || '获取局域网同步状态失败' });
  }
}

async function handleLanEnable(req, res) {
  try {
    const config = await core.loadConfig();
    if (!config.sync?.password) {
      return res.status(400).json({ error: '请先设置同步密码，再开启局域网同步' });
    }

    const lan = { ...(config.sync.lan || {}) };
    if (!lan.token) lan.token = crypto.randomBytes(32).toString('hex');
    const port = Number(req.body?.port) || lan.port || lanServer.DEFAULT_PORT;
    lan.enabled = true;
    lan.port = port;

    config.sync = { ...(config.sync || {}), lan };
    config.sync.platforms = { ...(config.sync.platforms || {}) };
    // Loopback entry = this machine's own blob store as a sync platform, so
    // pushes land in the store peers read from. Never clobber an entry that
    // points at a remote peer (this machine paired as a spoke).
    const existing = config.sync.platforms.lan;
    if (!existing || isLoopbackUrl(existing.baseUrl)) {
      config.sync.platforms.lan = { baseUrl: `http://127.0.0.1:${port}`, token: lan.token, enabled: true };
    }
    if (!config.sync.syncPlatform) config.sync.syncPlatform = 'lan';
    const autoSyncTurnedOn = !config.sync.autoSync;
    if (autoSyncTurnedOn) config.sync.autoSync = true;

    await core.saveConfig(config);
    await lanServer.applyConfig();
    core.appendLog('lan-enable', 'lan', true, `port ${port}`);
    // Seed the store with current state so peers can pull immediately.
    scheduler.syncNow().catch(() => {});
    res.json({ success: true, autoSyncTurnedOn, ...(await buildLanStatus()) });
  } catch (error) {
    console.error('LAN sync enable error:', error);
    core.appendLog('lan-enable', 'lan', false, error.message);
    res.status(500).json({ error: error.message || '开启局域网同步失败' });
  }
}

async function handleLanDisable(req, res) {
  try {
    const config = await core.loadConfig();
    if (config.sync?.lan) {
      config.sync.lan = { ...config.sync.lan, enabled: false };
      if (config.sync.platforms?.lan && isLoopbackUrl(config.sync.platforms.lan.baseUrl)) {
        config.sync.platforms.lan = { ...config.sync.platforms.lan, enabled: false };
      }
      await core.saveConfig(config);
    }
    await lanServer.applyConfig();
    core.appendLog('lan-disable', 'lan', true);
    res.json({ success: true, ...(await buildLanStatus()) });
  } catch (error) {
    console.error('LAN sync disable error:', error);
    res.status(500).json({ error: error.message || '关闭局域网同步失败' });
  }
}

async function handleLanRegenerate(req, res) {
  try {
    const config = await core.loadConfig();
    if (!config.sync?.lan?.token) {
      return res.status(400).json({ error: '尚未开启局域网同步' });
    }
    const lan = { ...config.sync.lan, token: crypto.randomBytes(32).toString('hex') };
    config.sync.lan = lan;
    if (config.sync.platforms?.lan && isLoopbackUrl(config.sync.platforms.lan.baseUrl)) {
      config.sync.platforms.lan = { ...config.sync.platforms.lan, token: lan.token };
    }
    await core.saveConfig(config);
    await lanServer.applyConfig();
    core.appendLog('lan-regenerate', 'lan', true, 'token rotated; old peers must re-pair');
    res.json({ success: true, ...(await buildLanStatus()) });
  } catch (error) {
    console.error('LAN sync regenerate error:', error);
    res.status(500).json({ error: error.message || '重新生成令牌失败' });
  }
}

// Peek the active pairing session WITHOUT generating a new one. The add-device
// dialog polls this to notice when the spoke has redeemed the code.
async function handleLanPairingPeek(req, res) {
  try {
    const config = await core.loadConfig();
    const lan = config.sync?.lan || {};
    const pairing = lanServer.getPendingPairing();
    if (!pairing || !lan.enabled) return res.json({ active: false });
    const status = lanServer.getStatus();
    const port = status.running ? status.port : (lan.port || lanServer.DEFAULT_PORT);
    const codes = lanServer.listLanAddresses().map(address => ({
      address,
      code: lanServer.buildConnectionCode(address, port, pairing.code),
    }));
    res.json({ active: true, expiresAt: new Date(pairing.expiresAt).toISOString(), codes });
  } catch (error) {
    res.status(500).json({ error: error.message || '查询配对码失败' });
  }
}

// Generate a fresh 5-minute, single-use pairing session. Generating a new
// code invalidates any outstanding one.
async function handleLanPairingCreate(req, res) {
  try {
    const config = await core.loadConfig();
    const lan = config.sync?.lan || {};
    if (!lan.enabled || !lan.token) {
      return res.status(400).json({ error: '请先开启局域网同步' });
    }
    const session = lanServer.createPairingCode();
    const status = lanServer.getStatus();
    const port = status.running ? status.port : (lan.port || lanServer.DEFAULT_PORT);
    const addresses = lanServer.listLanAddresses();
    const codes = addresses.map(address => ({
      address,
      code: lanServer.buildConnectionCode(address, port, session.code),
    }));
    core.appendLog('lan-pairing-create', 'lan', true, `expires in 5 min (${addresses.length} addresses)`);
    res.json({ success: true, expiresAt: new Date(session.expiresAt).toISOString(), codes });
  } catch (error) {
    console.error('LAN pairing create error:', error);
    res.status(500).json({ error: error.message || '生成配对码失败' });
  }
}

async function handleLanPair(req, res) {
  let parsed;
  try {
    parsed = parseConnectionCode(req.body?.code);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Exchange the short-lived pairing code for the peer's persistent access
  // token. The code is single-use and expires in minutes.
  let info;
  try {
    const exchange = await fetch(`${parsed.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: parsed.token }),
      signal: AbortSignal.timeout(8000),
    });
    if (exchange.status === 401) {
      return res.status(400).json({ error: '配对码无效或已过期，请让对端重新生成配对码' });
    }
    if (!exchange.ok) throw new Error(`对端响应异常 (${exchange.status})`);
    info = await exchange.json();
  } catch (error) {
    return res.status(400).json({ error: `无法连接对端设备：${error.message}。请确认对方已开启局域网同步且网络可达` });
  }
  if (!info.token) {
    return res.status(400).json({ error: '对端未返回访问令牌，请让对端升级 OKIT 后重试' });
  }

  try {
    const config = await core.loadConfig();
    if (!config.sync?.password) {
      return res.status(400).json({ error: '请先设置同步密码（需与对端设备相同）' });
    }
    const { userId } = await core.resolveSyncKeys(config);
    if (info.userId && info.userId !== userId) {
      return res.status(400).json({ error: '两台设备的同步密码不一致，请先在两台设备上设置为相同的同步密码' });
    }

    config.sync = { ...(config.sync || {}) };
    config.sync.platforms = { ...(config.sync.platforms || {}) };
    // Pairing overwrites the lan platform entry. If this machine was itself a
    // hub (loopback entry), stand down its listener: one platform slot means a
    // machine is either a hub or a spoke, not both.
    let hubDisabled = false;
    if (config.sync.lan?.enabled && isLoopbackUrl(config.sync.platforms.lan?.baseUrl)) {
      config.sync.lan = { ...config.sync.lan, enabled: false };
      hubDisabled = true;
    }
    config.sync.platforms.lan = { baseUrl: parsed.baseUrl, token: info.token, enabled: true };
    if (!config.sync.syncPlatform) config.sync.syncPlatform = 'lan';
    const autoSyncTurnedOn = !config.sync.autoSync;
    if (autoSyncTurnedOn) config.sync.autoSync = true;

    await core.saveConfig(config);
    if (hubDisabled) await lanServer.applyConfig();
    core.appendLog('lan-pair', 'lan', true, `${parsed.baseUrl} (${info.machineName || 'unknown'})${hubDisabled ? ' hub-disabled' : ''}`);
    // Adopt the peer's state right away instead of waiting for the next cycle.
    scheduler.syncNow().catch(() => {});
    res.json({
      success: true,
      peerName: parsed.name || info.machineName || '对端设备',
      machineId: info.machineId || null,
      hubDisabled,
      autoSyncTurnedOn,
    });
  } catch (error) {
    console.error('LAN sync pair error:', error);
    res.status(500).json({ error: error.message || '配对失败' });
  }
}

module.exports = {
  handlePush, handlePull, handleStatus, handleExportCode, handleImportCode,
  handleLanStatus, handleLanEnable, handleLanDisable, handleLanRegenerate, handleLanPairingPeek, handleLanPairingCreate, handleLanPair,
  handleSyncOverview,
};
