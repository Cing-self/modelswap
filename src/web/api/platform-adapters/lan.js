// LAN peer adapter: talks to another OKIT instance's lan-sync-server. The
// remote endpoint is a dumb encrypted-blob store (like a WebDAV file), so
// push/pull semantics match every other platform adapter exactly.
const lanServer = require('../lan-sync-server');

const REQUEST_TIMEOUT_MS = 8000;

function normalizeConfig(config) {
  const normalized = { ...config };
  normalized.baseUrl = String(normalized.baseUrl || '').trim().replace(/\/+$/, '');
  normalized.token = String(normalized.token || '').trim();
  return normalized;
}

function assertConfig(config) {
  if (!config.baseUrl) throw new Error('请配置对端设备地址');
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    throw new Error('对端地址必须以 http:// 或 https:// 开头');
  }
  if (!config.token) throw new Error('请配置连接令牌');
}

// Identify ourselves so the peer's device list can show who's talking.
async function machineHeader() {
  try {
    const { name, id } = await lanServer.getMachineIdentity();
    if (!id) return {};
    return { 'x-okit-machine': `${encodeURIComponent(name)}#${id}` };
  } catch {
    return {};
  }
}

async function request(config, pathname, options = {}) {
  const res = await fetch(`${config.baseUrl}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, ...(await machineHeader()), ...(options.headers || {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('局域网连接令牌无效，请重新配对');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`局域网同步请求失败: ${res.status} ${text}`.trim());
  }
  return res;
}

async function testConnection(config) {
  config = normalizeConfig(config);
  assertConfig(config);
  let info;
  try {
    const res = await request(config, '/ping');
    info = await res.json();
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error(`无法连接对端设备 (${config.baseUrl})，请确认对方已开启局域网同步`);
    }
    throw error;
  }
  return `已连接 ${info.machineName || '对端设备'} (${config.baseUrl})`;
}

async function pushSync(config, userId, encryptedBlob) {
  config = normalizeConfig(config);
  assertConfig(config);
  const res = await request(config, '/blob', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encryptedBlob),
  });
  await res.json().catch(() => {});
}

async function pullSync(config, userId) {
  config = normalizeConfig(config);
  assertConfig(config);
  const res = await fetch(`${config.baseUrl}/blob`, {
    headers: { Authorization: `Bearer ${config.token}`, ...(await machineHeader()) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error('局域网连接令牌无效，请重新配对');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`局域网同步拉取失败: ${res.status} ${text}`.trim());
  }
  return res.json();
}

module.exports = { name: '局域网', testConnection, pushSync, pullSync };
