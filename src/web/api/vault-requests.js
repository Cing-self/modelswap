/**
 * Vault credential requests — agent-issued "waiting for a secret" queue.
 *
 * Flow: an agent runs `modelswap vault request KEY@GROUP --wait`, the CLI
 * POSTs here, the request is pushed to the Chrome extension over the
 * authenticated WS channel, and the extension captures the value when the
 * user copies it on the provider console. The CLI polls GET until fulfilled.
 *
 * Security model:
 *   - Requests carry ONLY metadata (key name, group, desc, expected pattern,
 *     console URL, steps). A `value`/`values`/`secret` field in the payload
 *     is rejected outright — this channel must never become a way to smuggle
 *     a plaintext secret into a request.
 *   - Captures arrive exclusively over the extension WS (origin-gated +
 *     one-time-token), never from plain HTTP endpoints.
 *   - Patterns are length-capped AND screened for catastrophic backtracking
 *     (star height > 1 or overlapping alternation) at creation time — a
 *     hallucinating agent must not be able to hang the capture path.
 *   - The queue survives server restarts: it is persisted (metadata only)
 *     to ~/.modelswap/vault-requests.json and reloaded on startup, so an
 *     app auto-update no longer orphans a waiting `vault request --wait`.
 */

const crypto = require('crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { VaultStore } = require('../../vault/store');
const { normalizeVaultGroup } = require('../../vault/group-meta');
const { appendLog: appendVaultLog } = require('./log-writer');
const { publishDataChanged } = require('./ui-events');

const store = new VaultStore();

const REQUEST_TTL_MS = 30 * 60 * 1000; // armed requests expire after 30 min
const MAX_ITEMS = 10;
const PATTERN_MAX_LEN = 200;
const QUEUE_PATH = path.join(os.homedir(), '.modelswap', 'vault-requests.json');

// id -> request { id, items: [item], createdAt, expiresAt }
const requests = new Map();

// ─── Queue persistence (metadata only — never holds secret values) ──

let loaded = false;

async function loadQueueOnce() {
  if (loaded) return;
  loaded = true;
  try {
    if (!(await fs.pathExists(QUEUE_PATH))) return;
    const raw = await fs.readJson(QUEUE_PATH);
    for (const req of Array.isArray(raw) ? raw : []) {
      if (!req || typeof req.id !== 'string' || !Array.isArray(req.items)) continue;
      if (req.expiresAt <= Date.now()) continue; // stale on arrival
      requests.set(req.id, req);
    }
  } catch (error) {
    console.warn(`[vault-request] queue reload failed (starting empty): ${error.message}`);
  }
}

// Serialized through a tail so rapid mutations (create → capture within
// milliseconds) can never land out of order and resurrect stale state.
let writeTail = Promise.resolve();

function persistQueue() {
  writeTail = writeTail.then(async () => {
    const tempPath = `${QUEUE_PATH}.${process.pid}.tmp`;
    await fs.outputFile(tempPath, JSON.stringify([...requests.values()], null, 2));
    await fs.move(tempPath, QUEUE_PATH, { overwrite: true });
  }).catch((error) => console.warn(`[vault-request] queue persist failed: ${error.message}`));
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Conservative catastrophic-backtracking screen. Rejects the two classes
 * that make practically all real-world ReDoS: unbounded quantifiers nested
 * inside unbounded quantifiers (star height > 1) and an alternation inside
 * an unbounded quantifier where one branch's first char overlaps another's
 * (e.g. `(a|aa)*`). Deliberately conservative — a rare false positive just
 * makes the CLI ask for a simpler pattern.
 */
function isPatternSafe(pattern) {
  // Strip literals the engine treats verbatim: escapes and character classes.
  const source = pattern
    .replace(/\\[uD]/g, 'x') // \uXXXX \d \w … keep one placeholder char
    .replace(/\\\d+/g, 'x')
    .replace(/\\./g, 'x')
    .replace(/\[[^\]]*\]/g, 'x'); // character classes cannot nest/quantify inside
  // Tokenize: each open group tracks whether it contains any unbounded
  // quantifier and the first char of each alternation branch.
  const stack = [{ unboundedInside: false, branches: null }];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const top = stack[stack.length - 1];
    if (ch === '(') {
      stack.push({ unboundedInside: false, branches: [0] });
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (stack.length === 1) return false; // unbalanced — RegExp() will reject anyway
      const group = stack.pop();
      const parent = stack[stack.length - 1];
      const quantifier = source.slice(i + 1).match(/^[*+{]/);
      const unboundedHere = Boolean(quantifier) && (quantifier[0] !== '{' || /\{\d+,/.test(source.slice(i + 1)));
      if (unboundedHere) {
        // Star height > 1: an unbounded group quantifying unbounded content.
        if (group.unboundedInside) return false;
        // Alternation overlap inside an unbounded group (e.g. `(a|aa)*`).
        if (group.branches && group.branches.length > 1) {
          for (let b = 0; b < group.branches.length; b++) {
            for (let c = b + 1; c < group.branches.length; c++) {
              const fb = group.branches[b];
              const fc = group.branches[c];
              if (fb && fc && fb[0] === fc[0]) return false;
            }
          }
        }
        if (parent) parent.unboundedInside = true;
      }
      i += 1 + (quantifier ? quantifier[0].length : 0);
      continue;
    }
    if (ch === '|') {
      if (top.branches) top.branches.push(0);
      i += 1;
      continue;
    }
    if (ch === '*' || ch === '+') {
      top.unboundedInside = true;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = source.indexOf('}', i);
      const body = close === -1 ? '' : source.slice(i + 1, close);
      if (/\d+,/.test(body)) top.unboundedInside = true;
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }
    // Ordinary char: remember it as the branch-start candidate.
    const branch = top.branches;
    if (branch && branch[branch.length - 1] === 0) branch[branch.length - 1] = ch;
    i += 1;
  }
  return stack.length === 1;
}

function compilePattern(pattern) {
  if (typeof pattern !== 'string') return { error: 'pattern must be a string' };
  if (pattern.length === 0 || pattern.length > PATTERN_MAX_LEN) {
    return { error: `pattern length must be 1..${PATTERN_MAX_LEN}` };
  }
  if (!isPatternSafe(pattern)) {
    return { error: 'pattern risks catastrophic backtracking (nested or overlapping unbounded quantifiers) — simplify it' };
  }
  try {
    return { regex: new RegExp(pattern) };
  } catch (e) {
    return { error: `pattern does not compile: ${e.message}` };
  }
}

function validateItem(raw, index) {
  if (!raw || typeof raw !== 'object') return { error: `items[${index}] must be an object` };
  // The channel is metadata-only: a value field means someone is misusing it.
  for (const forbidden of ['value', 'values', 'secret', 'secrets']) {
    if (raw[forbidden] !== undefined) {
      return { error: `items[${index}].${forbidden} is not allowed — requests carry metadata only` };
    }
  }
  if (typeof raw.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw.key)) {
    return { error: `items[${index}].key is invalid (letters/digits/._- , ≤100 chars, must start alnum)` };
  }
  if (raw.group !== undefined && (typeof raw.group !== 'string' || raw.group.length > 60)) {
    return { error: `items[${index}].group is invalid` };
  }
  if (raw.desc !== undefined && (typeof raw.desc !== 'string' || raw.desc.length > 200)) {
    return { error: `items[${index}].desc too long (≤200 chars)` };
  }
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url) || raw.url.length > 500) {
      return { error: `items[${index}].url must be an http(s) URL` };
    }
  }
  const steps = raw.steps === undefined ? [] : raw.steps;
  if (!Array.isArray(steps) || steps.length > 10 || steps.some(s => typeof s !== 'string' || s.length > 200)) {
    return { error: `items[${index}].steps must be ≤10 strings of ≤200 chars` };
  }
  let pattern;
  if (raw.pattern !== undefined) {
    const compiled = compilePattern(raw.pattern);
    if (compiled.error) return { error: `items[${index}].${compiled.error}` };
    pattern = raw.pattern;
  }
  const fields = [];
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > 8) {
      return { error: `items[${index}].fields must be 1..8 entries` };
    }
    for (const f of raw.fields) {
      if (!f || typeof f.name !== 'string' || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(f.name)) {
        return { error: `items[${index}].fields[].name is invalid` };
      }
      let fieldPattern;
      if (f.pattern !== undefined) {
        const compiled = compilePattern(f.pattern);
        if (compiled.error) return { error: `items[${index}].fields[${f.name}].${compiled.error}` };
        fieldPattern = f.pattern;
      }
      fields.push({ name: f.name, pattern: fieldPattern });
    }
  }
  return {
    item: {
      key: raw.key,
      group: raw.group,
      desc: raw.desc,
      url: raw.url,
      steps,
      pattern, // string | undefined — extension re-compiles for matching
      fields: fields.length ? fields : undefined,
      replace: raw.replace === true,
      status: 'pending',
    },
  };
}

function pruneExpired() {
  const now = Date.now();
  for (const [id, req] of requests) {
    if (req.expiresAt <= now) requests.delete(id);
  }
}

function publicView(req) {
  return {
    id: req.id,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    fulfilled: req.items.every(i => i.status === 'fulfilled'),
    items: req.items.map(i => ({
      key: i.key,
      group: i.group,
      desc: i.desc,
      url: i.url,
      steps: i.steps,
      pattern: i.pattern,
      fields: i.fields,
      replace: i.replace,
      status: i.status,
      masked: i.masked,
      duplicate: i.duplicate === true,
      storedAt: i.storedAt,
    })),
  };
}

function pushSync() {
  try {
    const { pushToExtension } = require('./ws-extension');
    pruneExpired();
    pushToExtension({ type: 'vault-request-sync', requests: [...requests.values()].map(publicView) });
  } catch { /* extension bridge optional */ }
}

// ─── Masking ─────────────────────────────────────────────────────────

function maskValue(v) {
  if (typeof v !== 'string' || v.length === 0) return '';
  if (v.length <= 8) return `${v.slice(0, 2)}…`;
  return `${v.slice(0, 5)}…${v.slice(-2)}`;
}

function maskReceipt(value, fields) {
  if (fields) {
    const out = {};
    for (const [name, v] of Object.entries(fields)) out[name] = maskValue(String(v));
    return out;
  }
  return maskValue(value);
}

// ─── HTTP handlers (CLI only — captures never come through here) ─────

async function createRequests(req, res) {
  try {
    await loadQueueOnce();
    pruneExpired();
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    if (rawItems.length > MAX_ITEMS) {
      return res.status(400).json({ error: `too many items (max ${MAX_ITEMS})` });
    }
    const items = [];
    for (let i = 0; i < rawItems.length; i++) {
      const result = validateItem(rawItems[i], i);
      if (result.error) return res.status(400).json({ error: result.error });
      items.push(result.item);
    }
    const id = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    // A new ask for the same key supersedes the old one: without this, a stale
    // pending item (its CLI waiter long gone) would hijack the capture and the
    // new waiter would never see fulfillment.
    const newKeys = new Set(items.map(i => i.key));
    for (const [oldId, old] of requests) {
      if (old.items.some(i => newKeys.has(i.key) && i.status === 'pending')) {
        requests.delete(oldId);
        console.log(`[vault-request] superseded ${oldId} (duplicate pending key)`);
      }
    }
    const record = { id, items, createdAt: Date.now(), expiresAt: Date.now() + REQUEST_TTL_MS };
    requests.set(id, record);
    persistQueue();
    console.log(`[vault-request] ${id}: ${items.map(i => i.key).join(', ')} — pushed to extension`);
    pushSync();
    // Tell the caller whether anyone is actually listening — an honest
    // dead-end beats a CLI that "notifies the extension" into the void.
    let extensionConnected = false;
    try {
      extensionConnected = require('./ws-extension').isExtensionConnected();
    } catch { /* bridge unavailable */ }
    res.json({ id, request: publicView(record), extensionConnected });
  } catch (error) {
    console.error('Error creating vault request:', error);
    res.status(500).json({ error: 'Failed to create vault request' });
  }
}

async function listRequests(_req, res) {
  await loadQueueOnce();
  pruneExpired();
  res.json({ requests: [...requests.values()].map(publicView) });
}

async function cancelRequest(req, res) {
  await loadQueueOnce();
  const { id } = req.body || {};
  if (typeof id !== 'string' || !requests.has(id)) {
    return res.status(404).json({ error: 'Request not found' });
  }
  requests.delete(id);
  persistQueue();
  pushSync();
  res.json({ success: true });
}

// ─── Capture (extension WS only) ─────────────────────────────────────

/**
 * Handle {type:'vault-capture'} from the authenticated extension socket.
 * `confirmed:true` means the user explicitly approved this value (confirm
 * dialog or manual paste) — it bypasses pattern/key-exists soft gates.
 */
async function captureFromExtension(msg) {
  await loadQueueOnce();
  pruneExpired();
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const key = typeof msg.key === 'string' ? msg.key : null;
  if (!key) return { ok: false, error: 'key required' };

  // Locate the request: explicit id first, else the pending item by key name.
  let record = requestId ? requests.get(requestId) : null;
  let item = record?.items.find(i => i.key === key && i.status === 'pending');
  if (!item) {
    for (const req of requests.values()) {
      const found = req.items.find(i => i.key === key && i.status === 'pending');
      if (found) { record = req; item = found; break; }
    }
  }
  if (!item) return { ok: false, code: 'no-pending-request', error: `no pending request for ${key}` };

  const confirmed = msg.confirmed === true;
  let valueToStore;
  let receipt;

  if (item.fields) {
    const fields = msg.fields && typeof msg.fields === 'object' ? msg.fields : null;
    if (!fields) return { ok: false, code: 'fields-required', error: `${key} expects fields: ${item.fields.map(f => f.name).join(', ')}` };
    const missing = item.fields.filter(f => typeof fields[f.name] !== 'string' || fields[f.name].trim().length === 0);
    if (missing.length > 0) {
      return { ok: false, code: 'fields-missing', error: `missing fields: ${missing.map(f => f.name).join(', ')}` };
    }
    for (const f of item.fields) {
      const v = fields[f.name].trim();
      if (v.length > 4096) return { ok: false, code: 'value-too-long', error: `field ${f.name} too long` };
      if (f.pattern && !new RegExp(f.pattern).test(v) && !confirmed) {
        return { ok: false, code: 'pattern-mismatch', error: `field ${f.name} does not match the expected pattern` };
      }
    }
    const clean = {};
    for (const f of item.fields) clean[f.name] = fields[f.name].trim();
    valueToStore = JSON.stringify(clean);
    receipt = maskReceipt(null, clean);
  } else {
    if (typeof msg.value !== 'string') return { ok: false, error: 'value required' };
    const value = msg.value.trim();
    if (value.length < 8 || value.length > 4096) {
      return { ok: false, code: 'value-invalid', error: 'value length must be 8..4096' };
    }
    if (item.pattern && !new RegExp(item.pattern).test(value) && !confirmed) {
      return { ok: false, code: 'pattern-mismatch', error: 'value does not match the expected pattern — confirm to store anyway' };
    }
    valueToStore = value;
    receipt = maskValue(value);
  }

  // Overwrite guard: silent auto-capture must not clobber an existing key.
  const existing = await store.get(item.key);
  if (existing !== null && existing !== valueToStore && !item.replace && !confirmed) {
    return { ok: false, code: 'key-exists', error: `${item.key} already exists — confirm to overwrite` };
  }
  const duplicate = existing === valueToStore;

  await store.set(
    item.key,
    valueToStore,
    item.group !== undefined ? normalizeVaultGroup(item.group, item.key) : undefined,
    undefined,
    item.desc,
  );
  appendVaultLog('vault-capture', item.key, true);
  publishDataChanged(['secrets']);
  try { require('./sync-scheduler').markDirty('secrets'); } catch { /* optional */ }

  // A changed key value must reach agents whose configs embed it. Same
  // fire-and-forget contract as the web setVault handler.
  void Promise.resolve()
    .then(() => require('../../application/provider-service').reconcileVaultKey({ vaultKey: item.key }))
    .catch(error => console.warn(`[vault-capture] agent reconcile failed for ${item.key}: ${error.message}`));

  item.status = 'fulfilled';
  item.masked = receipt;
  item.duplicate = duplicate;
  item.storedAt = Date.now();
  console.log(`[vault-request] captured ${item.key}${duplicate ? ' (duplicate value, no change)' : ''}`);
  persistQueue();
  pushSync();
  return { ok: true, key: item.key, masked: receipt, duplicate };
}

/** Push the current queue to a freshly (re)connected extension. */
async function pushSyncOnConnect() {
  // Reload before the push: after a server restart this is the moment the
  // extension would otherwise receive an empty queue and drop its copy.
  await loadQueueOnce();
  pushSync();
}

// ─── Direct save (extension popup, user-initiated) ───────────────────

/**
 * Handle {type:'vault-save'} from the authenticated extension socket — the
 * user explicitly composed this save in the popup (key/group/desc/value).
 * Multi-line `字段名: 值` template text auto-packs into a JSON value, matching
 * the multi-field convention used everywhere else.
 */
async function saveFromExtension(msg) {
  const key = typeof msg.key === 'string' ? msg.key.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(key)) {
    return { ok: false, error: 'key 无效（字母开头，可含 ._-= ，≤100 字符）' };
  }
  const group = typeof msg.group === 'string' ? msg.group.slice(0, 60) : undefined;
  const desc = typeof msg.desc === 'string' ? msg.desc.slice(0, 200) : undefined;
  const raw = typeof msg.value === 'string' ? msg.value : '';
  if (!raw.trim()) return { ok: false, error: 'value 不能为空' };
  if (raw.length > 4096) return { ok: false, error: 'value 太长（≤4096）' };

  // Template auto-detect: every line `name: value` → JSON-packed fields.
  const lines = raw.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const isTemplate = lines.length > 1 && lines.length <= 8 &&
    lines.every(l => /^[\w.-]{1,64}\s*[:=]\s*\S{1,1024}$/.test(l));
  let valueToStore;
  if (isTemplate) {
    const fields = {};
    for (const line of lines) {
      const m = line.match(/^([\w.-]{1,64})\s*[:=]\s*(.+)$/);
      fields[m[1]] = m[2].trim();
    }
    valueToStore = JSON.stringify(fields);
  } else {
    valueToStore = raw.trim();
    // User-initiated save: they store whatever they want. Only the transport
    // cap applies; the ≥8-char floor stays on the agent capture path.
  }

  const existing = await store.get(key);
  if (existing !== null && existing !== valueToStore && msg.force !== true) {
    return { ok: false, code: 'key-exists', error: `${key} 已存在且值不同 — 确认覆盖？` };
  }
  const duplicate = existing === valueToStore;

  await store.set(key, valueToStore, normalizeVaultGroup(group, key), undefined, desc);
  appendVaultLog('vault-save', key, true);
  publishDataChanged(['secrets']);
  try { require('./sync-scheduler').markDirty('secrets'); } catch { /* optional */ }
  void Promise.resolve()
    .then(() => require('../../application/provider-service').reconcileVaultKey({ vaultKey: key }))
    .catch(error => console.warn(`[vault-save] agent reconcile failed for ${key}: ${error.message}`));

  console.log(`[vault-save] ${key}${duplicate ? ' (duplicate value)' : ''}${isTemplate ? ' (template JSON)' : ''}`);
  return {
    ok: true, key, duplicate,
    masked: isTemplate
      ? Object.fromEntries(lines.map(line => {
          const m = line.match(/^([\w.-]{1,64})\s*[:=]\s*(.+)$/);
          return [m[1], maskValue(m[2].trim())];
        }))
      : maskValue(valueToStore),
  };
}

module.exports = {
  createRequests,
  listRequests,
  cancelRequest,
  isPatternSafe,
  captureFromExtension,
  saveFromExtension,
  pushSyncOnConnect,
};
