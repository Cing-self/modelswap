// LAN transport controllers. They own pairing protocol and HTTP responses;
// state persistence and cloud payload reconciliation remain in sync services.
const core = require('./cloud-sync-core');
const scheduler = require('./sync-scheduler');
const lanServer = require('./lan-sync-server');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const LAN_CODE_PREFIX = 'okit-lan://';
let cachedMachineName;
let peerProbeCache = { at: 0, value: null };

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

function isLoopbackUrl(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(
    String(baseUrl || ''),
  );
}

async function probeRemotePeer(platConfig) {
  if (Date.now() - peerProbeCache.at < 30_000) return peerProbeCache.value;
  const value = await (async () => {
    try {
      const resolved = await core.resolveVaultRefs(platConfig, 'lan');
      const response = await fetch(`${resolved.baseUrl}/ping`, {
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { online: false, url: resolved.baseUrl };
      const info = await response.json();
      return {
        online: true,
        url: resolved.baseUrl,
        name: info.machineName || '',
        id: info.machineId || null,
      };
    } catch {
      return { online: false, url: platConfig.baseUrl };
    }
  })();
  peerProbeCache = { at: Date.now(), value };
  return value;
}

function pairingCodes(status, lan, pairing) {
  if (!pairing || !lan.enabled) return [];
  const port = status.running ? status.port : lan.port || lanServer.DEFAULT_PORT;
  return lanServer.listLanAddresses().map((address) => ({
    address,
    code: lanServer.buildConnectionCode(address, port, pairing.code),
  }));
}

async function buildLanStatus() {
  const config = await core.loadConfig();
  const sync = config.sync || {};
  const lan = sync.lan || {};
  const status = lanServer.getStatus();
  const platformBaseUrl = sync.platforms?.lan?.baseUrl || null;
  return {
    enabled: !!lan.enabled,
    running: status.running,
    port: status.running ? status.port : lan.port || lanServer.DEFAULT_PORT,
    error: status.error,
    addresses: lanServer.listLanAddresses(),
    codes: pairingCodes(status, lan, lanServer.getPendingPairing()),
    peer:
      platformBaseUrl && !isLoopbackUrl(platformBaseUrl)
        ? platformBaseUrl
        : null,
    platformEnabled: !!sync.platforms?.lan?.enabled,
    hasPassword: !!sync.password,
    autoSync: !!sync.autoSync,
    machineName: getMachineName(),
  };
}

async function handleSyncOverview(req, res) {
  try {
    const config = await core.loadConfig();
    const sync = config.sync || {};
    const platforms = sync.platforms || {};
    const lan = sync.lan || {};
    const enabledIds = Object.keys(platforms).filter(
      (id) => platforms[id]?.enabled,
    );
    const lanPlatform = platforms.lan || null;
    const isSpoke =
      !!lanPlatform?.enabled &&
      !!lanPlatform.baseUrl &&
      !isLoopbackUrl(lanPlatform.baseUrl);
    const status = lanServer.getStatus();
    const devices = lanServer
      .getRecentPeers()
      .filter((peer) => peer.id !== sync.machineId)
      .map((peer) => ({
        ...peer,
        lastSeen: new Date(peer.lastSeen).toISOString(),
      }));
    const peer = isSpoke ? await probeRemotePeer(lanPlatform) : null;

    res.json({
      machine: {
        id: sync.machineId || null,
        name: getMachineName(),
        role: lan.enabled ? 'hub' : isSpoke ? 'spoke' : 'none',
      },
      hasPassword: !!sync.password,
      autoSync: !!sync.autoSync,
      lastSyncAt: sync.lastSyncAt || null,
      lan: {
        enabled: !!lan.enabled,
        running: status.running,
        port: status.running ? status.port : lan.port || lanServer.DEFAULT_PORT,
        error: status.error,
        codes: pairingCodes(status, lan, lanServer.getPendingPairing()),
      },
      peer,
      devices,
      cloudPlatforms: enabledIds.filter((id) => id !== 'lan'),
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
      return res
        .status(400)
        .json({ error: '请先设置同步密码，再开启局域网同步' });
    }
    const lan = { ...(config.sync.lan || {}) };
    const token = lan.token || crypto.randomBytes(32).toString('hex');
    const port = Number(req.body?.port) || lan.port || lanServer.DEFAULT_PORT;
    const autoSyncTurnedOn = !config.sync.autoSync;
    await core.enableLan(port, token);
    await lanServer.applyConfig();
    core.appendLog('lan-enable', 'lan', true, `port ${port}`);
    scheduler.syncNow().catch(() => {});
    res.json({
      success: true,
      autoSyncTurnedOn,
      ...(await buildLanStatus()),
    });
  } catch (error) {
    console.error('LAN sync enable error:', error);
    core.appendLog('lan-enable', 'lan', false, error.message);
    res.status(500).json({ error: error.message || '开启局域网同步失败' });
  }
}

async function handleLanDisable(req, res) {
  try {
    await core.disableLan();
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
    await core.rotateLanToken(crypto.randomBytes(32).toString('hex'));
    await lanServer.applyConfig();
    core.appendLog(
      'lan-regenerate',
      'lan',
      true,
      'token rotated; old peers must re-pair',
    );
    res.json({ success: true, ...(await buildLanStatus()) });
  } catch (error) {
    console.error('LAN sync regenerate error:', error);
    res.status(500).json({ error: error.message || '重新生成令牌失败' });
  }
}

async function handleLanPairingPeek(req, res) {
  try {
    const config = await core.loadConfig();
    const lan = config.sync?.lan || {};
    const status = lanServer.getStatus();
    const pairing = lanServer.getPendingPairing();
    if (!pairing || !lan.enabled || !status.running) {
      return res.json({ active: false });
    }
    const port = status.running ? status.port : lan.port || lanServer.DEFAULT_PORT;
    const codes = lanServer.listLanAddresses().map((address) => ({
      address,
      code: lanServer.buildConnectionCode(address, port, pairing.code),
    }));
    res.json({
      active: true,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      codes,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || '查询配对码失败' });
  }
}

async function handleLanPairingCreate(req, res) {
  try {
    const config = await core.loadConfig();
    const lan = config.sync?.lan || {};
    if (!lan.enabled || !lan.token) {
      return res.status(400).json({ error: '请先开启局域网同步' });
    }
    const status = lanServer.getStatus();
    if (!status.running) {
      return res.status(409).json({
        error: '这台设备暂时无法接收新的局域网同步连接，请稍后重试',
      });
    }
    const session = lanServer.createPairingCode();
    const addresses = lanServer.listLanAddresses();
    const codes = addresses.map((address) => ({
      address,
      code: lanServer.buildConnectionCode(address, status.port, session.code),
    }));
    core.appendLog(
      'lan-pairing-create',
      'lan',
      true,
      `expires in 5 min (${addresses.length} addresses)`,
    );
    res.json({
      success: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
      codes,
    });
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
  const password = String(req.body?.password || '').trim();
  if (!password) {
    return res
      .status(400)
      .json({ error: '请输入同步密码（需与对端设备相同）' });
  }

  let candidateUserId;
  try {
    const config = await core.loadConfig();
    ({ userId: candidateUserId } = await core.resolveSyncKeys({
      ...config,
      sync: { ...(config.sync || {}), password },
    }));
  } catch (error) {
    return res.status(500).json({ error: error.message || '无法验证同步密码' });
  }

  let info;
  try {
    const exchange = await fetch(`${parsed.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: parsed.token, userId: candidateUserId }),
      signal: AbortSignal.timeout(8000),
    });
    if (exchange.status === 401) {
      return res
        .status(400)
        .json({ error: '配对码无效或已过期，请让对端重新生成配对码' });
    }
    if (exchange.status === 403) {
      const detail = await exchange.json().catch(() => ({}));
      return res
        .status(400)
        .json({ error: detail.error || '两台设备的同步密码不一致' });
    }
    if (!exchange.ok) throw new Error(`对端响应异常 (${exchange.status})`);
    info = await exchange.json();
  } catch (error) {
    return res.status(400).json({
      error: `无法连接对端设备：${error.message}。请确认对方已开启局域网同步且网络可达`,
    });
  }
  if (!info.token) {
    return res
      .status(400)
      .json({ error: '对端未返回访问令牌，请让对端升级 OKIT 后重试' });
  }

  try {
    const config = await core.loadConfig();
    const { userId } = await core.resolveSyncKeys({
      ...config,
      sync: { ...(config.sync || {}), password },
    });
    if (info.userId && info.userId !== userId) {
      return res.status(400).json({
        error: '两台设备的同步密码不一致，请先在两台设备上设置为相同的同步密码',
      });
    }
    let hubDisabled = false;
    if (
      config.sync.lan?.enabled &&
      isLoopbackUrl(config.sync.platforms.lan?.baseUrl)
    ) {
      config.sync.lan = { ...config.sync.lan, enabled: false };
      hubDisabled = true;
    }
    const autoSyncTurnedOn = !config.sync.autoSync;
    await core.pairLan(password, parsed.baseUrl, info.token);
    if (hubDisabled) await lanServer.applyConfig();
    core.appendLog(
      'lan-pair',
      'lan',
      true,
      `${parsed.baseUrl} (${info.machineName || 'unknown'})${hubDisabled ? ' hub-disabled' : ''}`,
    );
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
  handleLanDisable,
  handleLanEnable,
  handleLanPair,
  handleLanPairingCreate,
  handleLanPairingPeek,
  handleLanRegenerate,
  handleLanStatus,
  handleSyncOverview,
};
