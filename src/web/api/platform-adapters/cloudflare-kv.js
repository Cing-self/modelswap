const fetch = require('node-fetch');

const API_BASE = 'https://api.cloudflare.com/client/v4';
const KV_NAMESPACE_NAME = 'okit-sync';

async function cfFetch(token, path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!data.success) {
    const errors = (data.errors || []).map(e => e.message).join('; ');
    throw new Error(errors || `Cloudflare API error: ${res.status}`);
  }
  return data;
}

async function listAccounts(token) {
  const data = await cfFetch(token, '/accounts');
  return data.result || [];
}

async function getAccountId(token) {
  const accounts = await listAccounts(token);
  const accountId = accounts[0]?.id;
  if (!accountId) throw new Error('未找到 Cloudflare 账户');
  return accountId;
}

async function ensureNamespace(token, accountId) {
  const data = await cfFetch(token, `/accounts/${accountId}/storage/kv/namespaces`);
  const namespaces = data.result || [];
  const existing = namespaces.find(ns => ns.title === KV_NAMESPACE_NAME);
  if (existing) return existing.id;

  const created = await cfFetch(token, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: 'POST',
    body: JSON.stringify({ title: KV_NAMESPACE_NAME }),
  });
  return created.result.id;
}

async function testConnection(config) {
  if (!config.apiToken) throw new Error('请配置 API Token');
  const accountId = await getAccountId(config.apiToken);
  await ensureNamespace(config.apiToken, accountId);
  return `Cloudflare KV 连接成功 (Namespace: ${KV_NAMESPACE_NAME})`;
}

async function pushSync(config, userId, encryptedBlob) {
  if (!config.apiToken) throw new Error('请配置 API Token');
  const accountId = await getAccountId(config.apiToken);
  const nsId = await ensureNamespace(config.apiToken, accountId);
  const key = `sync/${userId}`;

  await cfFetch(config.apiToken,
    `/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
    { method: 'PUT', body: JSON.stringify(encryptedBlob) });
}

async function pullSync(config, userId) {
  if (!config.apiToken) throw new Error('请配置 API Token');
  const accountId = await getAccountId(config.apiToken);
  const nsId = await ensureNamespace(config.apiToken, accountId);
  const key = `sync/${userId}`;

  const res = await fetch(
    `${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`,
    { headers: { 'Authorization': `Bearer ${config.apiToken}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudflare KV GET failed: ${res.status}`);
  return await res.json();
}

module.exports = { name: 'Cloudflare KV', testConnection, pushSync, pullSync };
