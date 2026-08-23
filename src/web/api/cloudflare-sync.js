const execa = require('execa');
const fs = require('fs');
const path = require('path');
const { VaultStore } = require('../../vault/store');
const { appendLog: appendSyncLog } = require('./log-writer');

const vault = new VaultStore();

const LOG_FILE = path.join(process.env.HOME || '/tmp', '.okit-cf-sync.log');

function cfLog(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log('[cf-sync]', ...args);
}
cfLog('=== cloudflare-sync module loaded ===');

// Strip ANSI escape codes
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
}

async function runWrangler(args, timeout = 30000) {
  const { stdout, stderr } = await execa.command(`wrangler ${args}`, {
    shell: true,
    timeout,
  });
  return stripAnsi((stdout || '') + '\n' + (stderr || '')).trim();
}

// Run wrangler with array arguments (no shell) and optional env overrides
async function runWranglerDirect(argv, env, timeout = 30000) {
  const { stdout, stderr } = await execa('wrangler', argv, {
    timeout,
    env: { ...process.env, ...env },
    extendEnv: false,
  });
  return stripAnsi((stdout || '') + '\n' + (stderr || '')).trim();
}

// Parse wrangler table output (│-delimited rows)
function parseTable(output, columns) {
  const rows = [];
  let isFirstData = true;
  for (const line of output.split('\n')) {
    if (!line.includes('│')) continue;
    if (line.match(/^[├┼└┌┬]/)) continue; // separator lines
    const cells = line.split('│').map(c => c.trim());
    // Remove leading/trailing empty elements (from │ at line edges)
    while (cells.length && cells[0] === '') cells.shift();
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    // Keep empty middle cells — they represent null columns like Comment
    if (cells.length >= columns.length) {
      if (isFirstData) { isFirstData = false; continue; } // skip header row
      const row = {};
      columns.forEach((col, i) => { row[col] = cells[i] || ''; });
      rows.push(row);
    }
  }
  return rows;
}

async function checkWrangler(req, res) {
  try {
    const output = await runWrangler('--version', 10000);
    res.json({ available: true, version: output.split('\n')[0] });
  } catch {
    res.json({ available: false });
  }
}

async function listStores(req, res) {
  try {
    const output = await runWrangler('secrets-store store list --remote --per-page 100');
    const stores = parseTable(output, ['name', 'id', 'accountId', 'created', 'modified']);
    res.json({ stores });
  } catch (error) {
    const msg = stripAnsi((error.stderr || error.message || '')).trim();
    if (msg.includes('not authenticated') || msg.includes('Not authenticated') || msg.includes('not logged in')) {
      return res.status(401).json({ error: 'Wrangler 未登录，请先运行 wrangler login' });
    }
    if (msg.includes('command not found') || msg.includes('ENOENT')) {
      return res.status(400).json({ error: 'Wrangler 未安装，请先安装 Wrangler CLI' });
    }
    res.status(500).json({ error: msg || '获取 Cloudflare Stores 失败' });
  }
}

async function listStoreSecrets(req, res) {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId is required' });

  try {
    const output = await runWrangler(`secrets-store secret list ${storeId} --remote --per-page 100`);
    const secrets = parseTable(output, ['name', 'id', 'comment', 'scopes', 'status', 'created', 'modified']);
    res.json({ secrets });
  } catch (error) {
    const msg = stripAnsi((error.stderr || error.message || '')).trim();
    // Empty store returns exit 1 with "no secrets"
    if (msg.includes('no secrets') || msg.includes('returned no')) {
      return res.json({ secrets: [] });
    }
    res.status(500).json({ error: msg || '获取 Store Secrets 失败' });
  }
}

async function syncToCloudflare(req, res) {
  const { storeId, accountId, keys, deleteKeys } = req.body;
  cfLog('sync request received, storeId:', storeId, 'accountId:', accountId, 'keys:', keys, 'deleteKeys:', deleteKeys);
  if (!storeId) return res.status(400).json({ error: 'storeId is required' });
  if ((!Array.isArray(keys) || keys.length === 0) && (!Array.isArray(deleteKeys) || deleteKeys.length === 0)) {
    return res.status(400).json({ error: 'keys or deleteKeys is required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');

  function send(obj) {
    cfLog('send:', JSON.stringify(obj));
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {
      cfLog('write error:', e.message);
    }
  }

  // Resolve accountId if not provided
  let resolvedAccountId = accountId;
  if (!resolvedAccountId) {
    try {
      const storeOutput = await runWrangler('secrets-store store list --remote --per-page 100');
      const stores = parseTable(storeOutput, ['name', 'id', 'accountId', 'created', 'modified']);
      const store = stores.find(s => s.id === storeId);
      if (store && store.accountId) {
        resolvedAccountId = store.accountId;
        cfLog(' resolved accountId from store list:', resolvedAccountId);
      }
    } catch (e) {
      cfLog(' failed to resolve accountId:', e.message);
    }
  }

  const envOverrides = {};
  if (resolvedAccountId) {
    envOverrides.CLOUDFLARE_ACCOUNT_ID = resolvedAccountId;
  }

  // Load vault secrets
  let allSecrets;
  try {
    allSecrets = await vault.exportAll();
    cfLog(' vault loaded, secrets count:', allSecrets.length);
  } catch (e) {
    cfLog(' vault error:', e.message);
    send({ type: 'error', message: '无法读取 Vault 密钥' });
    return res.end();
  }

  // Get existing secrets from Cloudflare for update detection
  let existingSecrets = [];
  try {
    const output = await runWranglerDirect(
      ['secrets-store', 'secret', 'list', storeId, '--remote', '--per-page', '100'],
      envOverrides,
    );
    existingSecrets = parseTable(output, ['name', 'id', 'comment', 'scopes', 'status', 'created', 'modified']);
    cfLog(' existing secrets:', existingSecrets.length);
  } catch (e) {
    cfLog(' list existing failed:', e.message);
  }

  const existingMap = new Map();
  for (const s of existingSecrets) {
    existingMap.set(s.name, s.id);
  }

  let created = 0, updated = 0, failed = 0;

  for (const key of keys) {
    const entry = allSecrets.find(s => s.key === key);

    if (!entry || !entry.value) {
      cfLog(' key not found in vault:', key);
      send({ type: 'progress', key, action: 'skip', success: false, message: '密钥不存在或无值' });
      failed++;
      continue;
    }

    const existingId = existingMap.get(key);
    cfLog(' syncing key:', key, 'action:', existingId ? 'update' : 'create');

    try {
      let output;
      if (existingId) {
        output = await runWranglerDirect(
          ['secrets-store', 'secret', 'update', storeId,
           '--secret-id', existingId,
           '--value', entry.value,
           '--remote'],
          envOverrides,
          30000,
        );
      } else {
        output = await runWranglerDirect(
          ['secrets-store', 'secret', 'create', storeId,
           '--name', key,
           '--value', entry.value,
           '--scopes', 'workers',
           '--remote'],
          envOverrides,
          30000,
        );
      }
      cfLog(' wrangler output for', key, ':', output);

      // Verify success from wrangler output
      const success = /Created secret|Updated secret|✅|Success/i.test(output);
      if (success) {
        send({ type: 'progress', key, action: existingId ? 'update' : 'create', success: true });
        existingId ? updated++ : created++;
      } else {
        cfLog(' wrangler output does not indicate success for', key);
        send({ type: 'progress', key, action: existingId ? 'update' : 'create', success: false, message: output || '未知错误' });
        failed++;
      }
    } catch (error) {
      const msg = stripAnsi((error.stderr || error.message || '')).trim();
      cfLog(' sync failed for', key, ':', msg);
      send({ type: 'progress', key, action: existingId ? 'update' : 'create', success: false, message: msg });
      failed++;
    }
  }

  // Delete secrets that exist in Cloudflare but not in Vault
  let deleted = 0;
  if (Array.isArray(deleteKeys) && deleteKeys.length > 0) {
    for (const key of deleteKeys) {
      const existingId = existingMap.get(key);
      if (!existingId) {
        cfLog(' delete skipped, not found in CF:', key);
        send({ type: 'progress', key, action: 'delete', success: false, message: 'Cloudflare 上不存在' });
        failed++;
        continue;
      }

      cfLog(' deleting key:', key, 'secretId:', existingId);
      try {
        const output = await runWranglerDirect(
          ['secrets-store', 'secret', 'delete', storeId,
           '--secret-id', existingId,
           '--remote'],
          envOverrides,
          30000,
        );
        cfLog(' delete output for', key, ':', output);
        const success = /Deleted secret|✅|Success/i.test(output);
        if (success) {
          send({ type: 'progress', key, action: 'delete', success: true });
          deleted++;
        } else {
          send({ type: 'progress', key, action: 'delete', success: false, message: output || '未知错误' });
          failed++;
        }
      } catch (error) {
        const msg = stripAnsi((error.stderr || error.message || '')).trim();
        cfLog(' delete failed for', key, ':', msg);
        send({ type: 'progress', key, action: 'delete', success: false, message: msg });
        failed++;
      }
    }
  }

  const totalOps = (keys ? keys.length : 0) + (deleteKeys ? deleteKeys.length : 0);
  cfLog(' done — created:', created, 'updated:', updated, 'deleted:', deleted, 'failed:', failed);
  const syncSuccess = failed === 0;
  appendSyncLog('cf-sync', `store:${storeId}`, syncSuccess,
    `created:${created} updated:${updated} deleted:${deleted} failed:${failed}`);
  send({ type: 'done', total: totalOps, created, updated, deleted, failed });
  res.end();
}

module.exports = { checkWrangler, listStores, listStoreSecrets, syncToCloudflare };
