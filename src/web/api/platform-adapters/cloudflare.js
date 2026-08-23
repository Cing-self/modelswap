const fetch = require('node-fetch');

const API_BASE = 'https://api.cloudflare.com/client/v4';

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

async function testConnection(config) {
  if (!config.apiToken) throw new Error('请配置 API Token');
  if (!config.storeId) throw new Error('请配置 Store ID');
  const accounts = await listAccounts(config.apiToken);
  if (accounts.length === 0) throw new Error('未找到 Cloudflare 账户');
  return `Cloudflare Secrets Store (${config.storeId}) 连接成功`;
}

async function pushSync(config, userId, encryptedBlob) {
  if (!config.apiToken || !config.storeId) throw new Error('请配置 API Token 和 Store ID');
  const accounts = await listAccounts(config.apiToken);
  const accountId = accounts[0]?.id;
  if (!accountId) throw new Error('未找到 Cloudflare 账户');

  const secretName = `okit-sync-${userId}`;
  const value = JSON.stringify(encryptedBlob);

  // Try to find existing
  let existing = [];
  try {
    const listData = await cfFetch(config.apiToken,
      `/accounts/${accountId}/secrets_store/stores/${config.storeId}/secrets`);
    existing = listData.result || [];
  } catch {}

  const found = existing.find(s => s.name === secretName);
  if (found) {
    await cfFetch(config.apiToken,
      `/accounts/${accountId}/secrets_store/stores/${config.storeId}/secrets/${found.id}`,
      { method: 'PATCH', body: JSON.stringify({ value }) });
  } else {
    await cfFetch(config.apiToken,
      `/accounts/${accountId}/secrets_store/stores/${config.storeId}/secrets`,
      { method: 'POST', body: JSON.stringify([{ name: secretName, value, scopes: ['workers'] }]) });
  }
}

async function pullSync(config, userId) {
  if (!config.apiToken || !config.storeId) throw new Error('请配置 API Token 和 Store ID');
  const accounts = await listAccounts(config.apiToken);
  const accountId = accounts[0]?.id;
  if (!accountId) throw new Error('未找到 Cloudflare 账户');

  const secretName = `okit-sync-${userId}`;

  let existing = [];
  try {
    const listData = await cfFetch(config.apiToken,
      `/accounts/${accountId}/secrets_store/stores/${config.storeId}/secrets`);
    existing = listData.result || [];
  } catch {}

  const found = existing.find(s => s.name === secretName);
  if (!found) return null;

  // Secrets Store API may not return the value via list; try to get it
  try {
    const detail = await cfFetch(config.apiToken,
      `/accounts/${accountId}/secrets_store/stores/${config.storeId}/secrets/${found.id}`);
    const value = detail.result?.value;
    if (!value) return null;
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = { name: 'Cloudflare Secrets Store', testConnection, pushSync, pullSync };
