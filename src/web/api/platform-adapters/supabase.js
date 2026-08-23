const fetch = require('node-fetch');

const TABLE_NAME = 'okit_sync';

function getBaseUrl(config) {
  const rawProjectId = String(config.projectId || '').replace(/\s+/g, '').trim();
  if (!rawProjectId) throw new Error('请配置 Supabase 项目 ID');

  if (/^https?:\/\//i.test(rawProjectId)) {
    try {
      const url = new URL(rawProjectId);
      if (!url.hostname.endsWith('.supabase.co')) {
        throw new Error('请填写 Supabase 项目地址，例如 https://abcdefghijklmnopqrst.supabase.co');
      }
      return `${url.protocol}//${url.hostname}`;
    } catch (error) {
      throw new Error(error.message || 'Supabase 项目地址格式不正确');
    }
  }

  const projectId = rawProjectId.replace(/\.supabase\.co\/?$/i, '').toLowerCase();
  if (/^(proj-123|project-id|your-project-id|example)$/i.test(projectId)) {
    throw new Error('当前 Supabase 项目 ID 还是占位值，请填写 Supabase 控制台 Project Settings → API 里的 Project URL/Project ref');
  }
  if (!/^[a-z0-9]{15,30}$/.test(projectId)) {
    throw new Error('Supabase 项目 ID 格式不正确。请填写 Project URL 中 https:// 和 .supabase.co 之间的那段项目 ref');
  }

  return `https://${projectId}.supabase.co`;
}

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    'apikey': apiKey,
    'Authorization': `Bearer ${apiKey}`,
    'Prefer': 'resolution=merge-duplicates',
  };
}

async function sbFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (error) {
    throw new Error(`无法连接 Supabase：${error.message || error}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase error (${res.status}): ${text}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function testConnection(config) {
  if (!config.apiKey) throw new Error('请配置 Secret Key');
  const base = getBaseUrl(config);
  const h = headers(config.apiKey);
  // Verify table exists by selecting from it
  try {
    await sbFetch(`${base}/rest/v1/${TABLE_NAME}?select=id&limit=1`, { headers: h });
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('does not exist') || e.message.includes('relation')) {
      throw new Error(`表 ${TABLE_NAME} 不存在，请先在配置指南中复制建表 SQL 到 SQL Editor 执行`);
    }
    throw e;
  }
  return 'Supabase 连接成功（表已就绪）';
}

async function pushSync(config, userId, encryptedBlob) {
  if (!config.apiKey) throw new Error('请配置 Secret Key');
  const base = getBaseUrl(config);
  const h = headers(config.apiKey);
  const syncKey = `sync-${userId}`;

  // Upsert by the table's unique key column, not the generated id primary key.
  try {
    await sbFetch(`${base}/rest/v1/${TABLE_NAME}?on_conflict=key`, {
      method: 'POST',
      headers: { ...h, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: syncKey, value: encryptedBlob, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    // If table doesn't exist, provide clear error
    if (e.message.includes('404') || e.message.includes('does not exist') || e.message.includes('relation')) {
      throw new Error(`表 ${TABLE_NAME} 不存在。请在 Supabase SQL Editor 中建表后再试。`);
    }
    throw e;
  }
}

async function pullSync(config, userId) {
  if (!config.apiKey) throw new Error('请配置 Secret Key');
  const base = getBaseUrl(config);
  const h = headers(config.apiKey);
  const syncKey = `sync-${userId}`;
  try {
    const rows = await sbFetch(`${base}/rest/v1/${TABLE_NAME}?key=eq.${encodeURIComponent(syncKey)}&select=value&limit=1`, { headers: h });
    if (!rows || rows.length === 0) return null;
    return rows[0].value;
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('does not exist')) return null;
    throw e;
  }
}

module.exports = { name: 'Supabase', testConnection, pushSync, pullSync };
