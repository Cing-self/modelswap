// Scan agent config files for plaintext API keys that are NOT managed by
// the OKIT vault, and import them into the vault on request.
//
// Why this matters: OKIT rewrites agent config files whenever the user
// switches providers or curates models — a key that lives ONLY in the file
// can be clobbered by such a write, and rotation / sync / backup never see
// it. The home page therefore shows a persistent banner until every found
// key is either imported or the entry is explicitly left external.

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { VaultStore } = require('../../vault/store');
const { appendLog } = require('./log-writer');

const store = new VaultStore();

// Agent config files worth scanning (superset of the config-viewer mapping:
// the auth.json sidecars hold keys too). Paths relative to the home dir.
const SCAN_FILES = [
  { agentId: 'claude', file: '.claude/settings.json', kind: 'json' },
  { agentId: 'codex', file: '.codex/config.toml', kind: 'toml' },
  { agentId: 'codex', file: '.codex/auth.json', kind: 'json' },
  { agentId: 'codex', file: '.codex/.env', kind: 'env' },
  { agentId: 'opencode', file: '.config/opencode/opencode.json', kind: 'json' },
  { agentId: 'opencode', file: '.local/share/opencode/auth.json', kind: 'json' },
  { agentId: 'openclaw', file: '.openclaw/openclaw.json', kind: 'json' },
  { agentId: 'workbuddy', file: '.workbuddy/models.json', kind: 'json' },
  { agentId: 'zcode', file: '.zcode/v2/config.json', kind: 'json' },
  { agentId: 'zcode', file: '.zcode/cli/config.json', kind: 'json' },
  { agentId: 'hermes', file: '.hermes/config.json', kind: 'json' },
  { agentId: 'kimi-code', file: '.kimi-code/config.toml', kind: 'toml' },
  { agentId: 'grok', file: '.grok/config.toml', kind: 'toml' },
  { agentId: 'mimo-code', file: '.config/mimocode/mimocode.jsonc', kind: 'jsonc' },
];

// Field names whose string values carry a secret.
const SECRET_FIELD_RE = /(?:^|[^a-z])(api[-_]?key|apikey|secret|token|password)(?:[^a-z]|$)/i;
// Values that are never secrets (public literals, placeholders).
const NON_SECRET_VALUES = new Set(['public', '', 'your_api_key', 'sk-xxx', 'xxx', 'changeme']);
const MIN_SECRET_LEN = 12;

function maskValue(v) {
  if (v.length <= 10) return v.slice(0, 1) + '…';
  return v.slice(0, 6) + '…' + v.slice(-4);
}

function looksLikeSecret(value) {
  return typeof value === 'string'
    && value.length >= MIN_SECRET_LEN
    && !NON_SECRET_VALUES.has(value.toLowerCase())
    && !/^env\./i.test(value)   // env references, not literals
    && !/^\$\{/.test(value)     // template placeholders
    && !/^https?:\/\//i.test(value); // URLs
}

// Walk a parsed JSON object collecting secret-looking string leaves.
function walkJson(node, trail, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJson(v, `${trail}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const t = trail ? `${trail}.${k}` : k;
      if (v && typeof v === 'object') { walkJson(v, t, out); continue; }
      if (typeof v === 'string' && SECRET_FIELD_RE.test(k) && looksLikeSecret(v)) {
        out.push({ path: t, value: v });
      }
    }
  }
}

function scanJson(text) {
  try { const out = []; walkJson(JSON.parse(text), '', out); return out; }
  catch { return []; }
}

function scanJsonc(text) {
  return scanJson(text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''));
}

function scanToml(text) {
  const out = [];
  const re = /^\s*([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password)[A-Za-z0-9_.-]*)\s*=\s*"([^"]+)"/gim;
  let m;
  while ((m = re.exec(text))) {
    if (looksLikeSecret(m[2])) out.push({ path: m[1], value: m[2] });
  }
  return out;
}

function scanEnv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*"?([^"\n]+?)"?\s*$/);
    if (!m) continue;
    // OKIT writes OKIT_* env vars FROM the vault — never a finding.
    if (m[1].startsWith('OKIT_')) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (looksLikeSecret(value)) out.push({ path: m[1], value });
  }
  return out;
}

// Best-effort provider id from the JSON path / TOML key context.
function providerFromPath(p) {
  const parts = p.split('.');
  // provider.<id>.options.apiKey / provider.<id>.apiKey
  if (parts[0] === 'provider' && parts.length > 1) return parts[1];
  // opencode auth.json shape: <providerId>.key
  if (parts.length === 2 && parts[1] === 'key') return parts[0];
  // env.<NAME> — no provider context
  return undefined;
}

// Lazy access to the provider store (compiled path layout matches
// providers.js's own requires).
let _providerStore;

// Classify a finding as a MODEL-invocation key or not. Users only want model
// API keys in the vault — Discord/Tavily/Brave/Stripe-MCP/gateway tokens are
// app credentials, not LLM access, and stay untouched in their files.
// Model = under an OKIT provider id, a zcode builtin plan, or an agent's
// model-provider section (models.providers.*).
function isModelKey(finding, okitProviderIds) {
  if (finding.providerId) {
    if (finding.providerId.startsWith('builtin:')) return true;
    if (okitProviderIds && okitProviderIds.has(finding.providerId)) return true;
  }
  if (/^models\.providers\./.test(finding.path)) return true;
  return false;
}

// Internal scan: returns raw values (never leaves the server unmasked).
async function scanRaw() {
  const entries = await store.list();
  const vaultByValue = new Map(); // raw value → vault key name
  for (const e of entries) {
    try {
      const v = await store.get(e.key);
      if (v) vaultByValue.set(v, e.key);
    } catch { /* unreadable entry — skip */ }
  }
  // Known OKIT provider ids for model-key classification.
  let okitProviderIds = null;
  try {
    if (!_providerStore) _providerStore = require('../../../providers/store');
    const provs = await _providerStore.loadProviders();
    okitProviderIds = new Set((provs || []).map(p => p.id));
  } catch { /* fall back to path-based classification */ }
  const findings = [];
  for (const t of SCAN_FILES) {
    const full = path.join(os.homedir(), t.file);
    let text;
    try { text = await fs.readFile(full, 'utf-8'); } catch { continue; }
    const hits = t.kind === 'toml' ? scanToml(text)
      : t.kind === 'env' ? scanEnv(text)
      : t.kind === 'jsonc' ? scanJsonc(text)
      : scanJson(text);
    for (const h of hits) {
      // codex auth.json `tokens.*` are ChatGPT OAuth session tokens — the
      // CLI owns and rotates them itself; they are not vault material.
      if (t.file === '.codex/auth.json' && h.path.startsWith('tokens.')) continue;
      const finding = {
        agentId: t.agentId,
        file: t.file,
        path: h.path,
        providerId: providerFromPath(h.path) || undefined,
        value: h.value,
        masked: maskValue(h.value),
        inVault: vaultByValue.has(h.value),
        vaultKey: vaultByValue.get(h.value) || undefined,
      };
      // Model-invocation key vs app credential (discord/search/mcp/gateway).
      finding.model = isModelKey(finding, okitProviderIds);
      findings.push(finding);
    }
  }
  // Collapse repeats of the SAME key value within one file (workbuddy writes
  // it on every model entry; toml has one api_key per model table).
  const seen = new Set();
  return findings.filter(f => {
    const id = `${f.file}|${f.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function scanAgentKeys(_req, res) {
  try {
    // Masked for the client — raw values never leave the server.
    const findings = (await scanRaw()).map(({ value, ...rest }) => rest);
    res.json({ findings, filesScanned: SCAN_FILES.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function importAgentKeys(req, res) {
  try {
    const { items } = req.body; // [{agentId, file, path}]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] required' });
    }
    // Resolve live values from a fresh scan — never trust client-sent
    // secrets (the client only ever sees masked previews).
    const all = await scanRaw();
    const existing = new Set((await store.list()).map(e => e.key));
    const created = [];
    const skipped = [];
    const importedValues = new Set();
    for (const item of items) {
      const hit = all.find(f => f.agentId === item.agentId && f.file === item.file && f.path === item.path);
      if (!hit) { skipped.push({ ...item, reason: 'not-found' }); continue; }
      if (hit.inVault || importedValues.has(hit.value)) {
        skipped.push({ ...item, reason: 'already-in-vault' });
        continue;
      }
      // Name from the provider id, or the last meaningful path segment (e.g.
      // mcp.servers.stripe.env.STRIPE_SECRET_KEY → STRIPE_SECRET_KEY).
      const tail = item.path.split('.').filter(Boolean).pop() || 'key';
      let base = `${item.agentId}-${hit.providerId || tail}`
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      let name = base;
      let n = 2;
      while (existing.has(name)) { name = `${base}-${n++}`; }
      existing.add(name);
      importedValues.add(hit.value);
      await store.set(name, hit.value, 'Agent 导入', undefined, `从 ${hit.file} 导入`);
      created.push({ key: name, agentId: hit.agentId, providerId: hit.providerId, masked: hit.masked, file: hit.file });
    }
    appendLog('agent-keys-import', `${created.length} created`, true,
      skipped.length ? `skipped ${skipped.length}` : undefined);
    // Auto-sync: vault contents changed.
    try { require('./sync-scheduler').markDirty('secrets'); } catch { /* scheduler optional */ }
    res.json({ success: true, created, skipped });
  } catch (err) {
    appendLog('agent-keys-import', '', false, err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { scanAgentKeys, importAgentKeys };
