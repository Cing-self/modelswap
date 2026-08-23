const fetch = require('node-fetch');

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DB_NAME = 'okit-sync';

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

async function ensureDatabase(token, accountId) {
  // List existing databases
  const data = await cfFetch(token, `/accounts/${accountId}/d1/database`);
  const dbs = data.result || [];
  const existing = dbs.find(db => db.name === DB_NAME);
  if (existing) return existing.uuid;

  // Create database
  const created = await cfFetch(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: DB_NAME }),
  });
  return created.result.uuid;
}

async function ensureTable(token, accountId, databaseId, tableName) {
  try {
    await cfFetch(token,
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { method: 'POST', body: JSON.stringify({ sql: `SELECT 1 FROM ${tableName} LIMIT 1` }) });
  } catch {
    await cfFetch(token,
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { method: 'POST', body: JSON.stringify({ sql: `CREATE TABLE IF NOT EXISTS ${tableName} (name TEXT PRIMARY KEY, value TEXT, updated_at TEXT)` }) });
  }
}

async function queryD1(token, accountId, databaseId, sql, params) {
  const body = { sql };
  if (params) body.params = params;
  return await cfFetch(token,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify(body) });
}

function getD1Rows(result) {
  const first = result.result?.[0];
  if (Array.isArray(first?.results)) return first.results;
  if (Array.isArray(result.result)) return result.result;
  return [];
}

async function ensureSyncTable(token, accountId, databaseId) {
  const expectedColumns = ['user_id', 'data', 'machine_id', 'updated_at'];
  let existingColumns = [];

  try {
    const info = await queryD1(token, accountId, databaseId, 'PRAGMA table_info(okit_sync)');
    existingColumns = getD1Rows(info).map(row => row.name);
  } catch {
    existingColumns = [];
  }

  const hasWrongSchema = existingColumns.length > 0
    && (existingColumns.length !== expectedColumns.length
      || expectedColumns.some(column => !existingColumns.includes(column)));

  if (hasWrongSchema) {
    await queryD1(token, accountId, databaseId, 'DROP TABLE IF EXISTS okit_sync');
  }

  await queryD1(token, accountId, databaseId,
    'CREATE TABLE IF NOT EXISTS okit_sync (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, machine_id TEXT, updated_at TEXT NOT NULL)');
}

async function testConnection(config) {
  if (!config.apiToken) throw new Error('请配置 API Token');

  const accountId = await getAccountId(config.apiToken);

  const databaseId = await ensureDatabase(config.apiToken, accountId);
  await ensureTable(config.apiToken, accountId, databaseId, 'okit_secrets');

  return `Cloudflare D1 连接成功 (数据库: ${DB_NAME})`;
}

async function pushSync(config, userId, encryptedBlob) {
  if (!config.apiToken) throw new Error('请配置 API Token');

  const accountId = await getAccountId(config.apiToken);
  const databaseId = await ensureDatabase(config.apiToken, accountId);

  await ensureSyncTable(config.apiToken, accountId, databaseId);
  const data = JSON.stringify(encryptedBlob);
  await queryD1(config.apiToken, accountId, databaseId, 'DELETE FROM okit_sync WHERE user_id = ?', [userId]);
  await queryD1(config.apiToken, accountId, databaseId,
    'INSERT INTO okit_sync (user_id, data, machine_id, updated_at) VALUES (?, ?, ?, ?)',
    [userId, data, encryptedBlob.machineId || '', new Date().toISOString()]);
}

async function pullSync(config, userId) {
  if (!config.apiToken) throw new Error('请配置 API Token');

  const accountId = await getAccountId(config.apiToken);
  const databaseId = await ensureDatabase(config.apiToken, accountId);

  await ensureSyncTable(config.apiToken, accountId, databaseId);
  try {
    const result = await cfFetch(config.apiToken,
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { method: 'POST', body: JSON.stringify({
        sql: `SELECT data FROM okit_sync WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`,
        params: [userId],
      }) });
    const rows = getD1Rows(result);
    if (!rows || rows.length === 0) return null;
    return JSON.parse(rows[0].data);
  } catch {
    return null;
  }
}

module.exports = { name: 'Cloudflare D1', testConnection, pushSync, pullSync };
