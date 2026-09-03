const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { backupImportantData } = require('../web/api/backup');
const { appendLog } = require('../web/api/log-writer');
const { publishDataChanged } = require('../web/api/ui-events');
const syncCore = require('../web/api/cloud-sync-core');
const { getAgentState, migrateAgentProviders, removeSite, replaceAgentState, setSite } = require('../web/api/agent-providers');
const {
  QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint,
  isQianfanCodingAnthropicEndpoint,
  qianfanModelDirectoryUrl,
  qianfanCodingErrorCode,
  qianfanCodingErrorMessage,
} = require('../web/api/qianfan-coding');
const {
  getAnthropicAuthMode,
} = require('../web/api/endpoint-profiles');
const { createModelDiscoveryService } = require('./model-discovery-service');
const { createProviderAuthService } = require('./provider-auth-service');
const { createProviderStatusService } = require('./provider-status-service');
const { createProviderLifecycleService } = require('./provider-lifecycle-service');

const MODELSWAP_DIR = path.join(os.homedir(), '.modelswap');
const PROVIDERS_PATH = path.join(MODELSWAP_DIR, 'providers.json');
const USER_CONFIG_PATH = path.join(MODELSWAP_DIR, 'user.json');


// Sort models by "capability descending": higher version first, then size tier.
// Extracts version tuples (5.6 > 5.5 > 4.7) and size tiers from the id so
// models display high→low regardless of the provider API return order.
// Within the SAME version, "lite" variants (flash/mini/haiku) sort AFTER the
// standard model — flash is a cheaper tier, not a higher one.
function sortModels(models) {
  // Higher rank = more capable. 0 = standard (no tier word found).
  const sizeRank = { opus: 4, pro: 3, sonnet: 2, haiku: 1, flash: -1, mini: -2, nano: -3, micro: -3, lite: -3, turbo: -1 };
  const extractKey = (id) => {
    const lower = id.toLowerCase();
    const verMatch = lower.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    const ver = verMatch ? [parseInt(verMatch[1]) || 0, parseInt(verMatch[2]) || 0, parseInt(verMatch[3]) || 0] : [0, 0, 0];
    let size = 0;
    for (const [word, rank] of Object.entries(sizeRank)) {
      if (lower.includes(word)) { size = rank; break; }
    }
    return { ver, size, name: lower };
  };
  return [...models].sort((a, b) => {
    const ka = extractKey(a.id);
    const kb = extractKey(b.id);
    for (let i = 0; i < 3; i++) {
      if (ka.ver[i] !== kb.ver[i]) return kb.ver[i] - ka.ver[i];
    }
    if (ka.size !== kb.size) return kb.size - ka.size;
    return ka.name.localeCompare(kb.name);
  });
}

// Tag each model with `recent: true/false` so the frontend can default-hide
// stale / non-coding models while still letting users add them back from the
// "add models" picker. We do NOT delete them from the list — the picker needs
// the full set to restore hidden entries.
//
// Rules for `recent: false` (hidden by default):
// 1. Non-text-LLM model types (embedding/vision/audio/tts/3d/image/video/
//    character/seedream/seedance/seededit/hitem/wan) → not coding-capable.
// 2. Dated snapshots with YYMMDD suffix < 260000 (before 2026) → stale.
function tagRecentModels(models) {
  const DATE_RE = /(\d{6})$/;
  const NON_CODING_RE = /embed|vision|audio|tts|asr|3d|image|video|character|seedream|seedance|seededit|hitem|^wan|ui-tars|voice|speak|realtime|terminus|distill|preview|-7b-|-14b-|-32b-|-72b-|-6b-|-8b-/i;
  return models.map(m => {
    let recent = true;
    if (NON_CODING_RE.test(m.id)) recent = false;
    const match = m.id.match(DATE_RE);
    if (match && parseInt(match[1]) < 260000) recent = false;
    return { ...m, recent };
  });
}

// Default model budget for newly added sites: keep the first N models of the

// Sort all providers alphabetically by display name. Chinese names sort by
// pinyin (zh-Hans-CN), English names sort A-Z, mixed lists interleave.
function sortProviders(arr) {
  return [...arr].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN')
  );
}

// Try dist/ first (production), then fall back to src compiled output.
let _platforms;
let _routing;
let _store;
try {
  _platforms = require('../providers/platforms');
  _routing = require('../providers/routing');
  _store = require('../providers/store');
} catch {
  // Fallback for dev mode where dist/ may not be in the expected relative position
  _platforms = require('../../dist/providers/platforms');
  _routing = require('../../dist/providers/routing');
  _store = require('../../dist/providers/store');
}

// Single adapter registry (shared with the CLI). Required once at module load
// so test suites can mock '../../dist/providers/registry' reliably — the old
// lazy require inside switchProvider escaped vitest's module interception.
let _getAdapter;
try {
  _getAdapter = require('../providers/registry').getAdapter;
} catch {
  _getAdapter = require('../../dist/providers/registry').getAdapter;
}

// Pre-switch config snapshots. Required once at module load (same eager-load
// pattern as the presets/registry requires above) so tests can mock the module.
let _snapshots;
try {
  _snapshots = require('../providers/snapshots');
} catch {
  _snapshots = require('../../dist/providers/snapshots');
}
const { capturePreSwitchSnapshot, restoreSnapshot } = _snapshots;

// Snapshot before ANY agent-config write, not just provider switches (config
// viewer edits, additive site add/remove). Failures warn and never block.
async function snapBeforeWrite(agentId, label) {
  try {
    await capturePreSwitchSnapshot(agentId);
  } catch (e) {
    console.warn(`[${label}] snapshot failed: ${e.message}`);
  }
}

const buildPlatforms = _platforms.buildPlatforms;
const { providerEndpointEntries, providerExecutionMode, providerSupportsAdapter, resolveModelRoute, resolveModel } = _routing;
let _codexMap;
try {
  _codexMap = require('../providers/mappings/codex.json');
} catch {
  _codexMap = require('../../dist/providers/mappings/codex.json');
}

function enrichCodexOfficialModels(models) {
  const profiles = new Map(
    (_codexMap?.officialModelSupport?.runtimeCatalog?.observedOfficialModels || [])
      .map(profile => [profile.id, profile]),
  );
  return models.map(model => {
    const profile = profiles.get(model.id);
    if (!profile) return model;
    return {
      ...model,
      meta: {
        source: 'remote',
        ...(Number.isFinite(profile.contextWindow) ? { context: profile.contextWindow } : {}),
        reasoning: Array.isArray(profile.reasoning) && profile.reasoning.length > 0,
        ...(Array.isArray(profile.reasoning) ? { reasoningOptions: [{ type: 'effort', values: profile.reasoning }] } : {}),
        ...(Array.isArray(profile.inputModalities) ? {
          modalities: { input: profile.inputModalities },
          attachment: profile.inputModalities.some(value => /image|video/i.test(value)),
        } : {}),
      },
    };
  });
}

async function loadProviders() {
  const providers = await _store.loadProviders();
  const codexProvider = providers.find(p => p.id === 'openai-codex');
  if (codexProvider) {
    try {
      const cachedModels = await modelDiscoveryService.readCodexCachedModels();
      if (cachedModels.length > 0) {
        codexProvider.models = withNativeAvailability(codexProvider, enrichCodexOfficialModels(cachedModels), 'cli');
      }
    } catch {
      // Keep the persisted list until Codex has produced a local model cache.
    }
  }
  return providers;
}

async function saveProviders(providers, options) {
  // Store owns the versioned providers file and its independent model cache.
  // A web action must never reconstruct or downgrade either JSON document.
  // A completed model discovery has already persisted only models-cache.json
  // through the cache store. It is not a site/configuration
  // change, so do not rewrite providers.json or schedule a cloud-sync push.
  // We still notify the UI so keep-alive pages reload the fresh cache.
  if (options?.persistModels === false) {
    publishDataChanged(['providers']);
    return;
  }
  await _store.saveProviders(providers);
  publishDataChanged(['providers']);
  // Any providers.json write is a payload change for cloud sync (pull merges go
  // through cloud-sync-core's own writer, so this never fires for remote data).
  require('../web/api/sync-scheduler').markDirty('providers');
}

async function loadUserConfig() {
  return syncCore.loadConfig();
}

async function persistAgentState(agentId, state) {
  await syncCore.replaceAgentState(agentId, state);
  publishDataChanged(['agents']);
  require('../web/api/sync-scheduler').markDirty('agentProviders');
}

let _agentsMeta;
try {
  _agentsMeta = require('../providers/agentsMeta');
} catch {
  _agentsMeta = require('../../dist/providers/agentsMeta');
}
const ADAPTERS = _agentsMeta.AGENTS_META;

// Additive agents: their config files hold entries from MANY providers at
// once and the user switches between them inside the agent's own UI. For
// these, adding a provider to the home page writes its models into the agent
// config, and removing/disabling removes them. Exclusive agents
// (claude/codex/...) keep single-active-switch semantics.
const ADDITIVE_AGENTS = new Set(['workbuddy', 'zcode', 'kimi-code', 'grok', 'mimo-code', 'opencode']);

// All entry points delegate Agent config work to this application service.
// Keep the web-only auth probe here and inject it, rather than letting HTTP
// handlers or cloud sync grow a second adapter-writing implementation.
const { createAgentConfigurationService } = require('./agent-config-service');
const agentConfigService = createAgentConfigurationService({
  adapters: ADAPTERS,
  getAdapter: _getAdapter,
  loadProviders,
  loadUserConfig,
  replaceAgentState: persistAgentState,
  captureSnapshot: capturePreSwitchSnapshot,
  restoreSnapshot,
  providerSupportsAdapter,
  resolveModelRoute,
  resolveModel,
  appendLog,
  authorize: (...args) => ensureProviderAuth(...args),
});

function adapterSupportsProvider(adapter, provider) {
  return providerSupportsAdapter(provider, adapter);
}

async function listProviders() {
    const providers = await loadProviders();
    const config = await loadUserConfig();

    // Attach current selection info
    const result = providers.map(p => {
      return {
        ...p,
        models: sortModels(p.models || []),
        usedBy: ADAPTERS
          .filter(a => adapterSupportsProvider(a, p) && getAgentState(config, a.id).activeProviderId === p.id)
          .map(a => {
            const state = getAgentState(config, a.id);
            return { id: a.id, name: a.name, modelId: state.activeModelId };
          }),
      };
    });

    const sortedResult = sortProviders(result);
    return { providers: sortedResult, platforms: buildPlatforms(sortedResult) };
}

const providerStatusService = createProviderStatusService({
  _store, loadProviders, loadUserConfig, ADAPTERS, ADDITIVE_AGENTS,
  adapterSupportsProvider, _getAdapter, providerExecutionMode, providerEndpointEntries,
  buildPlatforms, sortModels, sortProviders, tagRecentModels,
  enrichCodexOfficialModels, readCodexCachedModels: (...args) => modelDiscoveryService.readCodexCachedModels(...args),
  getAgentState, findCommand: (...args) => findCommand(...args), publishDataChanged,
});
const { getModelData, refreshModelData, refreshDemoProviderModels, getAdaptersList, launchAgent, normalizeRemoteModel } = providerStatusService;

async function switchProvider(input = {}) {
  try {
    const { agentId, providerId, modelId } = input;
    if (!agentId || !providerId || !modelId) {
      throw Object.assign(new Error('Missing required fields: agentId, providerId, modelId'), { status: 400 });
    }
    const config = await loadUserConfig();
    const providers = await loadProviders();
    const provider = providers.find(item => item.id === providerId);
    const selectedIds = [...new Set([...(getAgentState(config, agentId).sites?.[providerId]?.modelIds || []), modelId])];
    const result = await agentConfigService.applySelection({
      agentId, providerId, modelIds: selectedIds, primaryModelId: modelId,
      config, providers, source: 'provider-switch', activate: true,
    });
    return { ...result, modelId, route: { executionMode: result.route.executionMode, endpointId: result.route.endpointId, remoteModelId: result.route.remoteModelId } };
  } catch (err) {
    appendLog('provider-switch', `${input.agentId || ''}:${input.providerId || ''}`, false, err.message);
    const compatibilityMessage = {
      PROVIDER_NOT_FOUND: `Provider not found: ${input.providerId}`,
      UNSUPPORTED_PROVIDER: 'Adapter does not support this provider type',
      MODEL_NOT_FOUND: `Model not found: ${input.modelId}`,
    }[err.code];
    if (compatibilityMessage) err.message = compatibilityMessage;
    throw err;
  }
}

// --- Agent site + model selection -----------------------------------------
//
// `agentProviders` is intentionally the only user-facing state here.  A
// provider in providers.json is merely a connection/model directory; it does
// not mean that any Agent is using it.  Saving this endpoint therefore writes
// the Agent's native config *and* atomically replaces the selected model list
// for that one site.  The home page then renders the same list verbatim.

async function configureAgentProvider({ agentId, providerId, modelIds, primaryModelId, enabled } = {}) {
  if (!agentId || !providerId || !Array.isArray(modelIds)) {
    throw Object.assign(new Error('Missing agentId, providerId or modelIds'), { status: 400 });
  }

  try {
    const result = await agentConfigService.applySelection({
      agentId, providerId, modelIds, primaryModelId, enabled, source: 'agent-provider-save', activate: true,
    });
    return result;
  } catch (error) {
    appendLog('agent-provider-save', `${agentId}:${providerId}`, false, error.message);
    throw error;
  }
}

async function removeAgentProvider({ agentId, providerId } = {}) {
  if (!agentId || !providerId) throw Object.assign(new Error('Missing agentId or providerId'), { status: 400 });
  try {
    return await agentConfigService.removeConfiguredSite({ agentId, providerId });
  } catch (error) {
    appendLog('agent-provider-remove', `${agentId}:${providerId}`, false, error.message);
    throw error;
  }
}

async function setAgentProviderEnabled({ agentId, providerId, enabled } = {}) {
  if (!agentId || !providerId || typeof enabled !== 'boolean') {
    throw Object.assign(new Error('Missing agentId, providerId or enabled'), { status: 400 });
  }
  if (enabled) {
    const config = await loadUserConfig();
    const site = getAgentState(config, agentId).sites[providerId];
    // Pass enabled: true explicitly — applySelection preserves the stored
    // flag when it is undefined, so a disabled site would stay disabled and
    // the dashboard toggle would look like a no-op.
    return configureAgentProvider({ agentId, providerId, modelIds: site?.modelIds || [], enabled: true });
  }
  try {
    return await agentConfigService.disableConfiguredSite({ agentId, providerId });
  } catch (error) {
    appendLog('agent-provider-disable', `${agentId}:${providerId}`, false, error.message);
    throw error;
  }
}

// --- Agent config file viewer (read-only) -----------------------------------
//
// Each agent writes to a well-known config file (or two). This endpoint reads
// those files so the user can verify a switch actually landed on disk, without
// leaving the UI. Read-only — never writes.
//
// Sensitive values (API keys, tokens) are MASKED by default; the raw content
// is only served for an explicit ?reveal=1 request that the frontend gates
// behind a confirmation dialog.

const AGENT_CONFIG_FILES = {
  'claude': ['.claude/settings.json'],
  'codex': ['.codex/config.toml', '.codex/.env', '.codex/model-catalogs/model-catalogs.json'],
  'opencode': ['.config/opencode/opencode.json'],
  'openclaw': ['.openclaw/openclaw.json'],
  'workbuddy': ['.workbuddy/models.json'],
  // v2/config.json holds the provider entries; cli/config.json is the agent
  // kernel's settings file where MODELSWAP mirrors modelCatalog.overrides
  // (supportsImages gating for text-only models).
  'zcode': ['.zcode/v2/config.json', '.zcode/cli/config.json'],
  'hermes': ['.hermes/config.yaml'],
  'kimi-code': ['.kimi-code/config.toml'],
  'grok': ['.grok/config.toml'],
  'mimo-code': ['.config/mimocode/mimocode.jsonc'],
};

const MASKED_PLACEHOLDER = '___MODELSWAP_MASKED___';

// Key names whose VALUES are credentials. Matched case-insensitively as
// substrings of the config key / env var name.
const SENSITIVE_KEY_RE = /api[_-]?key|apikey|access[_-]?token|authtoken|auth[_-]?token|refresh[_-]?token|secret|password|authorization|api[_-]?token/i;
const SENSITIVE_ENV_RE = /^[A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*$/;

function maskConfigContent(content, rel) {
  const base = path.basename(rel).toLowerCase();
  let count = 0;

  // "key": "value" — JSON / JSONC / TOML with quoted keys.
  let out = content.replace(/("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*")/g, (m, k, sep, v) => {
    if (SENSITIVE_KEY_RE.test(k.slice(1, -1)) && v.length > 12) {
      count++;
      return `${k}${sep}"${MASKED_PLACEHOLDER}"`;
    }
    return m;
  });

  // key = "value" — TOML with bare keys.
  if (base.endsWith('.toml')) {
    out = out.replace(/^(\s*[A-Za-z0-9_.-]+\s*=\s*)("(?:[^"\\]|\\.)*")/gm, (m, k, v) => {
      const key = k.trim().replace(/\s*=$/, '');
      if (SENSITIVE_KEY_RE.test(key) && v.length > 12) {
        count++;
        return `${k}"${MASKED_PLACEHOLDER}"`;
      }
      return m;
    });
  }

  // key: value — YAML scalar values.
  if (base.endsWith('.yaml') || base.endsWith('.yml')) {
    out = out.replace(/^(\s*[A-Za-z0-9_.-]+\s*:\s*)([^\s#'"][^\n]*)$/gm, (m, k, v) => {
      const key = k.trim().replace(/:$/, '');
      if (SENSITIVE_KEY_RE.test(key) && v.trim().length > 7) {
        count++;
        return `${k}${MASKED_PLACEHOLDER}`;
      }
      return m;
    });
  }

  // KEY=value — dotenv files.
  if (base === '.env' || base.endsWith('.env')) {
    out = out.replace(/^([A-Za-z0-9_]+)=(.*)$/gm, (m, k, v) => {
      if (SENSITIVE_ENV_RE.test(k) && v.trim().length > 0) {
        count++;
        return `${k}=${MASKED_PLACEHOLDER}`;
      }
      return m;
    });
  }

  return { content: out, maskedCount: count };
}

// Validate edited content before it lands on disk, so a manual edit cannot
// save a syntactically broken agent config. JSON is strictly parsed; formats
// without a bundled parser get lightweight sanity checks.
function validateConfigContent(content, rel) {
  const base = path.basename(rel).toLowerCase();
  if (content.includes(MASKED_PLACEHOLDER)) {
    return `内容包含脱敏占位符 ${MASKED_PLACEHOLDER}。请先点"显示敏感信息"获取原文，再编辑保存。`;
  }
  if (base.endsWith('.json')) {
    try { JSON.parse(content); } catch (e) { return `JSON 语法错误: ${e.message}`; }
  } else if (base.endsWith('.jsonc')) {
    try {
      JSON.parse(content.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    } catch (e) { return `JSONC 语法错误: ${e.message}`; }
  } else if (content.trim().length === 0) {
    return '内容为空 — 拒绝保存空配置。';
  }
  return null;
}

async function getAgentConfigFiles({ agentId, reveal = false } = {}) {
  try {
    const relPaths = AGENT_CONFIG_FILES[agentId];
    if (!relPaths) {
      throw Object.assign(new Error(`No config files mapped for agent: ${agentId}`), { status: 404 });
    }
    const home = os.homedir();
    const files = await Promise.all(relPaths.map(async (rel) => {
      const fullPath = path.join(home, rel);
      const exists = await fs.pathExists(fullPath);
      let content = null;
      let maskedCount = 0;
      if (exists) {
        try {
          content = await fs.readFile(fullPath, 'utf-8');
          // Cap at 256KB so a pathological file can't blow up the UI. Real
          // agent configs (zcode v2/config.json runs >100KB pretty-printed
          // with per-model entries) must stay intact — a truncated JSON blob
          // also loses tree view and, worse, saving it back would corrupt
          // the file (the frontend marks truncated files read-only).
          if (content.length > 262144) content = content.slice(0, 262144) + '\n…(truncated)';
          if (!reveal) {
            const masked = maskConfigContent(content, rel);
            content = masked.content;
            maskedCount = masked.maskedCount;
          }
        } catch {
          content = '(读取失败)';
        }
      }
      return { path: `~/${rel}`, exists, content, maskedCount };
    }));
    return { agentId, files, revealed: reveal };
  } catch (err) {
    throw err;
  }
}

// Save edited config file content. Only paths registered in AGENT_CONFIG_FILES
// for the given agent are writable — this prevents arbitrary file writes. The
// client sends the `~`-prefixed path it got from GET; we strip the prefix and
// match against the whitelist before touching disk.
async function saveAgentConfigFile({ agentId, filePath, content } = {}) {
  try {
    const relPaths = AGENT_CONFIG_FILES[agentId];
    if (!relPaths) {
      throw Object.assign(new Error(`No config files mapped for agent: ${agentId}`), { status: 404 });
    }
    if (!filePath || typeof content !== 'string') {
      throw Object.assign(new Error('Missing filePath or content'), { status: 400 });
    }
    // Normalize: strip leading ~/ then match exactly against the whitelist.
    const rel = filePath.startsWith('~/') ? filePath.slice(2) : filePath;
    if (!relPaths.includes(rel)) {
      throw Object.assign(new Error(`Path not in writable whitelist: ${filePath}`), { status: 403 });
    }
    // Reject masked-placeholder content and syntactically broken files before
    // they can corrupt the agent's config.
    const validationError = validateConfigContent(content, rel);
    if (validationError) {
      throw Object.assign(new Error(validationError), { status: 400, code: 'CONFIG_INVALID' });
    }
    const fullPath = path.join(os.homedir(), rel);
    // Snapshot before the manual edit lands, so viewer edits are revertible
    // exactly like provider switches.
    await snapBeforeWrite(agentId, 'saveAgentConfigFile');
    // Refuse to follow symlinks or escape the home dir.
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    appendLog('config-file-save', `${agentId}:${rel}`, true);
    return { success: true, path: `~/${rel}` };
  } catch (err) {
    appendLog('config-file-save', `${agentId}:${filePath || ''}`, false, err.message);
    throw err;
  }
}

// --- Claude Code tier mapping ------------------------------------------------
//
// Claude Code uses ANTHROPIC_MODEL + DEFAULT_HAIKU/SONNET/OPUS_MODEL. For
// third-party providers the user can map each tier to a different model id so
// Claude Code's internal tier-switching (fast/standard/powerful) routes to the
// right model on the gateway. We persist per-provider overrides; switching to
// a provider without overrides defaults all tiers to the selected model.

async function getTierMaps() {
  try {
    const config = await loadUserConfig();
    const state = getAgentState(config, 'claude');
    const tierMaps = Object.fromEntries(Object.entries(state.sites)
      .filter(([, site]) => site?.tierMap)
      .map(([providerId, site]) => [providerId, site.tierMap]));
    return { tierMaps };
  } catch (err) {
    throw err;
  }
}

async function setTierMap({ providerId, haiku, sonnet, opus } = {}) {
  try {
    if (!providerId) {
      throw Object.assign(new Error('Missing providerId'), { status: 400 });
    }
    // Empty string / null = clear that tier (fall back to ANTHROPIC_MODEL).
    const map = {};
    if (haiku) map.haiku = haiku;
    if (sonnet) map.sonnet = sonnet;
    if (opus) map.opus = opus;
    const result = await agentConfigService.setClaudeTierMap({ providerId, tierMap: map });
    return { success: true, providerId, tierMap: map, snapshotAvailable: result.snapshotAvailable };
  } catch (err) {
    throw err;
  }
}

const providerAuthService = createProviderAuthService({
  fs, path, os, _store, loadProviders, saveProviders, buildPlatforms, getAnthropicAuthMode, providerEndpointEntries, appendLog,
});
const {
  resolveVaultKey, missingVaultKeyPrefix, resetProviderAuthState,
  repairMissingVaultBindings, supportsApiKey, supportsOAuth, providerEndpoints,
  isCredentialFailure, isFreshAuth, revalidateProviderAuth, authStateForProvider,
  getProviderAuthSnapshot, ensureProviderAuth, getAuthStatus, verifyProviderAuth,
  triggerOAuthLogin, detectOAuth, findCommand,
} = providerAuthService;

const providerLifecycleService = createProviderLifecycleService({
  loadProviders, saveProviders, loadUserConfig, removeProviderConfiguration: syncCore.removeProviderConfiguration, agentConfigService,
});
const { createProvider, updateProvider, deleteProvider } = providerLifecycleService;


const modelDiscoveryService = createModelDiscoveryService({
  fs, path, os, _store, loadProviders, saveProviders, loadUserConfig,
  providerEndpointEntries, providerExecutionMode, QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint, isQianfanCodingAnthropicEndpoint,
  qianfanModelDirectoryUrl,
  qianfanCodingErrorCode, qianfanCodingErrorMessage,
  getAnthropicAuthMode, publishDataChanged, tagRecentModels, sortModels, normalizeRemoteModel,
  detectOAuth, resolveVaultKey, findCommand: (...args) => findCommand(...args),
});
const {
  readCodexCachedModels, readGrokCliModels, readCopilotCliModels,
  withNativeAvailability, replaceRemoteModels, fetchModels, discoverMissingConfiguredModels,
} = modelDiscoveryService;



function deriveProviderCodeKey(password) {
  const crypto = require('crypto');
  return crypto.pbkdf2Sync(password, PROVIDER_CODE_SALT, 100000, 32, 'sha256');
}

function encryptProviderPayload(payload, password) {
  const crypto = require('crypto');
  const json = JSON.stringify(payload);
  // No password = plain base64url (for public preset-style links without secrets)
  if (!password) {
    return `${PROVIDER_CODE_PREFIX}${Buffer.from(json).toString('base64url')}`;
  }
  const key = deriveProviderCodeKey(password);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PROVIDER_CODE_PREFIX}${Buffer.from(JSON.stringify({
    v: 1, encrypted: true,
    nonce: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  })).toString('base64url')}`;
}

function decryptProviderPayload(code, password) {
  const crypto = require('crypto');
  const raw = String(code || '').trim();
  if (!raw.startsWith(PROVIDER_CODE_PREFIX)) throw new Error('Provider 码格式不正确');
  const encoded = raw.slice(PROVIDER_CODE_PREFIX.length);
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  let blob;
  try { blob = JSON.parse(decoded); } catch {
    throw new Error('Provider 码格式不正确');
  }
  // Plain (unencrypted) payload
  if (!blob.encrypted) return blob;
  // Encrypted payload — require password
  if (!password) throw new Error('此 Provider 码需要密码才能导入');
  const key = deriveProviderCodeKey(password);
  const iv = Buffer.from(blob.nonce, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const ciphertext = Buffer.from(blob.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    throw new Error('密码不正确，无法解密 Provider 码');
  }
}

async function exportProviderCode({ id, password } = {}) {
  try {
    if (!id) throw Object.assign(new Error('请指定要导出的 provider id'), { status: 400 });
    const providers = await loadProviders();
    const provider = providers.find(p => p.id === id);
    if (!provider) throw Object.assign(new Error(`未找到 provider: ${id}`), { status: 404 });

    // Strip vault-resolved secrets; keep vaultKey reference only
    const safe = {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      endpoints: provider.endpoints,
      vaultKey: provider.vaultKey,
      authMode: provider.authMode,
      models: provider.models,
    };
    const code = encryptProviderPayload(safe, password);
    return { success: true, code };
  } catch (err) {
    throw err;
  }
}

async function importProviderCode({ code, password } = {}) {
  try {
    if (!code) throw Object.assign(new Error('Provider 码不能为空'), { status: 400 });
    const provider = decryptProviderPayload(code, password);
    if (!provider.id || !provider.name) {
      throw Object.assign(new Error('Provider 码内容无效：缺少 id 或 name'), { status: 400 });
    }
    // Upsert into providers.json (same logic as createProvider)
    const providers = await loadProviders();
    const idx = providers.findIndex(p => p.id === provider.id);
    const existed = idx >= 0;
    const full = {
      id: provider.id,
      name: provider.name,
      type: provider.type || (provider.endpoints && provider.endpoints[0] ? provider.endpoints[0].type : 'openai'),
      baseUrl: provider.baseUrl || (provider.endpoints && provider.endpoints[0] ? provider.endpoints[0].baseUrl : ''),
      endpoints: provider.endpoints || undefined,
      vaultKey: provider.vaultKey || undefined,
      authMode: provider.authMode || 'api_key',
      models: provider.models || [],
    };
    if (idx >= 0) providers[idx] = full;
    else providers.push(full);
    await saveProviders(providers);
    return { success: true, provider: full, created: !existed };
  } catch (err) {
    if (!err.status && (err.message?.includes('密码不正确') || err.message?.includes('格式不正确') || err.message?.includes('需要密码'))) err.status = 400;
    throw err;
  }
}

// Kimi Code self-heal: kimi's config re-serializer drops the REQUIRED `model`
// field from every [models.*] entry whose provider is not the current default
// whenever it rewrites config.toml (thinking toggle, /model switch, session
// create), which crashes kimi at startup / on model switch. Poll the file and
// restore the missing fields right after kimi touches it.
const KIMI_CODE_CONFIG = path.join(os.homedir(), '.kimi-code', 'config.toml');
let _kimiLastMtimeMs = 0;
let _kimiHealTimer = null;
function startKimiCodeHealer() {
  if (_kimiHealTimer) return;
  _kimiHealTimer = setInterval(async () => {
    try {
      const st = await fs.stat(KIMI_CODE_CONFIG).catch(() => null);
      if (!st || st.mtimeMs === _kimiLastMtimeMs) return;
      _kimiLastMtimeMs = st.mtimeMs;
      const adapter = _getAdapter('kimi-code');
      if (adapter && typeof adapter.healModelFields === 'function') {
        await adapter.healModelFields();
      }
    } catch {}
  }, 4000);
  _kimiHealTimer.unref();
}
startKimiCodeHealer();

// Existence check for every registered agent's config files — powers the
// diagnostics summary (which agents are actually present on this machine).
function agentConfigPresence() {
  const home = os.homedir();
  return Object.entries(AGENT_CONFIG_FILES).map(([id, rels]) => ({
    id,
    files: rels.map(rel => ({ path: `~/${rel}`, exists: fs.existsSync(path.join(home, rel)) })),
  }));
}

module.exports = {
  listProviders,
  getModelData,
  refreshModelData,
  refreshDemoProviderModels,
  getAdaptersList,
  createProvider,
  updateProvider,
  deleteProvider,
  switchProvider,
  configureAgentProvider,
  removeAgentProvider,
  setAgentProviderEnabled,
  getAgentConfigFiles,
  saveAgentConfigFile,
  agentConfigPresence,
  getTierMaps,
  setTierMap,
  launchAgent,
  getAuthStatus,
  verifyProviderAuth,
  triggerOAuthLogin,
  fetchModels,
  discoverMissingConfiguredModels,
  reconcileVaultKey: input => agentConfigService.reconcileVaultKey(input),
  exportProviderCode,
  importProviderCode,
  __testing: {
    authStateForProvider,
    ensureProviderAuth,
    getProviderAuthSnapshot,
    isCredentialFailure,
    missingVaultKeyPrefix,
    repairMissingVaultBindings,
    revalidateProviderAuth,
    replaceRemoteModels,
  },
};
