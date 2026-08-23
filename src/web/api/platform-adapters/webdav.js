const fetch = require('node-fetch');

const SYNC_DIR = 'okit-sync';

function normalizeConfig(config) {
  const normalized = { ...config };
  normalized.url = String(normalized.url || '').trim().replace(/\/+$/, '');
  normalized.username = String(normalized.username || '').trim();
  normalized.password = String(normalized.password || '');
  return normalized;
}

function assertConfig(config) {
  if (!config.url) throw new Error('请配置 WebDAV 服务器地址');
  if (!/^https?:\/\//i.test(config.url)) {
    throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头');
  }
  if (!config.username) throw new Error('请配置用户名');
  if (!config.password) throw new Error('请配置密码');
}

function authHeader(config) {
  return 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
}

function fullUrl(config, p) {
  return `${config.url}/${p}`;
}

// MKCOL is idempotent — 405 means the collection already exists.
async function ensureDir(config, dirPath) {
  const res = await fetch(fullUrl(config, dirPath + '/'), {
    method: 'MKCOL',
    headers: { Authorization: authHeader(config) },
  });
  if (!res.ok && res.status !== 405) {
    const text = await res.text().catch(() => '');
    throw new Error(`WebDAV MKCOL ${dirPath} failed: ${res.status} ${text}`.trim());
  }
}

async function testConnection(config) {
  config = normalizeConfig(config);
  assertConfig(config);
  // Probe the normalized base URL itself. Appending a path segment here would
  // produce a double slash after trailing-slash stripping (e.g. dav//), which
  // Jianguoyun answers with 404.
  const res = await fetch(config.url, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(config), Depth: '0' },
  });
  if (res.status === 401) throw new Error('WebDAV 认证失败：用户名或密码错误');
  if (res.status === 404) throw new Error('WebDAV 路径不存在');
  if (!res.ok && res.status !== 207) {
    throw new Error(`WebDAV 连接失败: ${res.status}`);
  }
  await ensureDir(config, SYNC_DIR);
  return `WebDAV 连接成功 (${config.url})`;
}

async function pushSync(config, userId, encryptedBlob) {
  config = normalizeConfig(config);
  assertConfig(config);
  await ensureDir(config, SYNC_DIR);
  const res = await fetch(fullUrl(config, `${SYNC_DIR}/sync-${userId}.json`), {
    method: 'PUT',
    body: JSON.stringify(encryptedBlob),
    headers: { Authorization: authHeader(config), 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WebDAV upload failed: ${res.status} ${text}`.trim());
  }
}

async function pullSync(config, userId) {
  config = normalizeConfig(config);
  assertConfig(config);
  const res = await fetch(fullUrl(config, `${SYNC_DIR}/sync-${userId}.json`), {
    method: 'GET',
    headers: { Authorization: authHeader(config) },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WebDAV download failed: ${res.status} ${text}`.trim());
  }
  return JSON.parse(await res.text());
}

module.exports = { name: 'WebDAV', testConnection, pushSync, pullSync };
