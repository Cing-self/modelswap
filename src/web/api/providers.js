const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { backupImportantData } = require('./backup');
const { appendLog } = require('./log-writer');
const {
  QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint,
  isQianfanCodingAnthropicEndpoint,
  qianfanCodingErrorCode,
  qianfanCodingErrorMessage,
  qianfanCodingModels,
} = require('./qianfan-coding');
const {
  getAnthropicAuthMode,
  getAuthenticatedResourceFailureMessage,
  getFallbackModels,
  getProbeModels,
  isModelAccessFailure,
} = require('./endpoint-profiles');

const OKIT_DIR = path.join(os.homedir(), '.okit');
const PROVIDERS_PATH = path.join(OKIT_DIR, 'providers.json');
const USER_CONFIG_PATH = path.join(OKIT_DIR, 'user.json');

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
  _platforms = require('../../../providers/platforms');
  _routing = require('../../../providers/routing');
  _store = require('../../../providers/store');
} catch {
  // Fallback for dev mode where dist/ may not be in the expected relative position
  _platforms = require('../../../dist/providers/platforms');
  _routing = require('../../../dist/providers/routing');
  _store = require('../../../dist/providers/store');
}

// Single adapter registry (shared with the CLI). Required once at module load
// so test suites can mock '../../dist/providers/registry' reliably — the old
// lazy require inside switchProvider escaped vitest's module interception.
let _getAdapter;
try {
  _getAdapter = require('../../../providers/registry').getAdapter;
} catch {
  _getAdapter = require('../../../dist/providers/registry').getAdapter;
}

// Pre-switch config snapshots. Required once at module load (same eager-load
// pattern as the presets/registry requires above) so tests can mock the module.
let _snapshots;
try {
  _snapshots = require('../../../providers/snapshots');
} catch {
  _snapshots = require('../../../dist/providers/snapshots');
}
const { capturePreSwitchSnapshot } = _snapshots;

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
const { providerEndpointEntries, providerExecutionMode, providerSupportsAdapter, resolveModelRoute } = _routing;

async function loadProviders() {
  const providers = await _store.loadProviders();
  const codexProvider = providers.find(p => p.id === 'openai-codex');
  if (codexProvider) {
    try {
      const cachedModels = await readCodexCachedModels();
      if (cachedModels.length > 0) codexProvider.models = cachedModels;
    } catch {
      // Keep the persisted list until Codex has produced a local model cache.
    }
  }
  return providers;
}

async function saveProviders(providers) {
  await fs.ensureDir(OKIT_DIR);
  await backupImportantData('providers');
  await fs.writeFile(PROVIDERS_PATH, JSON.stringify({ providers, platforms: buildPlatforms(providers) }, null, 2));
  // Any providers.json write is a payload change for cloud sync (pull merges go
  // through cloud-sync-core's own writer, so this never fires for remote data).
  require('./sync-scheduler').markDirty('providers');
}

async function loadUserConfig() {
  try {
    if (!(await fs.pathExists(USER_CONFIG_PATH))) return {};
    const content = await fs.readFile(USER_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch { return {}; }
}

async function saveUserConfig(config) {
  await fs.ensureDir(OKIT_DIR);
  await backupImportantData('user');
  await fs.writeFile(USER_CONFIG_PATH, JSON.stringify(config, null, 2));
}

let _agentsMeta;
try {
  _agentsMeta = require('../../../providers/agentsMeta');
} catch {
  _agentsMeta = require('../../../dist/providers/agentsMeta');
}
const ADAPTERS = _agentsMeta.AGENTS_META;

// Additive agents: their config files hold entries from MANY providers at
// once and the user switches between them inside the agent's own UI. For
// these, adding a provider to the home page writes its models into the agent
// config, and removing/disabling removes them. Exclusive agents
// (claude/codex/...) keep single-active-switch semantics.
const ADDITIVE_AGENTS = new Set(['workbuddy', 'zcode', 'kimi-code', 'grok', 'mimo-code', 'opencode']);

// Cap for models auto-recorded after a successful switch.
const RECENT_MODELS_MAX = 10;

function adapterSupportsProvider(adapter, provider) {
  return providerSupportsAdapter(provider, adapter);
}

async function listProviders(req, res) {
  try {
    const providers = await loadProviders();
    const config = await loadUserConfig();
    const providersConfig = config.providers || {};

    // Attach current selection info
    const result = providers.map(p => {
      return {
        ...p,
        models: sortModels(p.models || []),
        usedBy: ADAPTERS
          .filter(a => adapterSupportsProvider(a, p) && providersConfig[a.id]?.providerId === p.id)
          .map(a => ({ id: a.id, name: a.name, modelId: providersConfig[a.id]?.modelId })),
      };
    });

    const sortedResult = sortProviders(result);
    res.json({ providers: sortedResult, platforms: buildPlatforms(sortedResult) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getAdaptersList(req, res) {
  try {
    const providers = await loadProviders();
    const config = await loadUserConfig();
    const providersConfig = config.providers || {};

    const result = await Promise.all(ADAPTERS.map(async adapter => {
      const sel = providersConfig[adapter.id];
      // All type-compatible providers that are configured (have a key / verified /
      // oauth-eligible). These are candidates for the "add to home" picker.
      const isProviderReady = (p) => {
        if (sel?.providerId === p.id) return true;
        if (p.authMode === 'none') return true;
        if (p.authVerified) return true;
        if (p.vaultKey) return true;
        if (p.authMode === 'oauth' || p.authMode === 'both') return true;
        return false;
      };
      const allCompatible = providers.filter(p => adapterSupportsProvider(adapter, p) && isProviderReady(p));

      // The home list is user-curated: only provider ids the user explicitly
      // added via addHomeProvider. Empty/absent = render nothing (the user adds
      // their own from the "+ 添加" button).
      const homeIds = Array.isArray(config.homeProviders?.[adapter.id]) ? config.homeProviders[adapter.id] : [];
      const homeSet = new Set(homeIds);
      const homeProviders = allCompatible.filter(p => homeSet.has(p.id));

      // Additive agents keep MANY sites enabled at once — ask the adapter which
      // provider ids are actually present/enabled in its config so each card's
      // toggle reflects the real state instead of the single "current" pick.
      let enabledSet = new Set();
      let activeModel = null;
      if (ADDITIVE_AGENTS.has(adapter.id)) {
        const instance = _getAdapter(adapter.id);
        if (instance && typeof instance.listEnabledProviders === 'function') {
          try {
            enabledSet = new Set(await instance.listEnabledProviders());
          } catch (err) {
            console.warn(`[getAdaptersList] listEnabledProviders(${adapter.id}) failed: ${err.message}`);
          }
        }
        // Prefer the model the agent is ACTUALLY using (ZCode records it per
        // task in its sqlite index) over OKIT's last-written selection.
        if (instance && typeof instance.getActiveModel === 'function') {
          try {
            const active = await instance.getActiveModel();
            if (active?.providerId && active?.modelId) {
              activeModel = active;
            }
          } catch (err) {
            console.warn(`[getAdaptersList] getActiveModel(${adapter.id}) failed: ${err.message}`);
          }
        }
      }
      const currentSel = activeModel || (sel?.providerId && sel?.modelId
        ? { providerId: sel.providerId, modelId: sel.modelId }
        : null);
      const currentProvider = currentSel?.providerId ? providers.find(p => p.id === currentSel.providerId) : null;

      return {
        ...adapter,
        launchType: adapter.launchType || 'cli',
        canLaunch: !!adapter.command,
        installed: adapter.launchType === 'app' ? true : (adapter.command ? !!findCommand(adapter.command) : false),
        additive: ADDITIVE_AGENTS.has(adapter.id),
        current: currentSel
          ? { providerId: currentSel.providerId, providerName: currentProvider?.name || currentSel.providerId, modelId: currentSel.modelId }
          : null,
        // Providers shown on the home page (user-curated subset), sorted.
        compatibleProviders: sortProviders(homeProviders).map(p => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
          models: tagRecentModels(sortModels(p.models || [])),
          // Additive: real per-site enabled state (many can be on at once).
          // Exclusive agents: mirrors the single current selection.
          enabled: ADDITIVE_AGENTS.has(adapter.id)
            ? enabledSet.has(p.id) || sel?.providerId === p.id
            : sel?.providerId === p.id,
        })),
        // All configured-and-compatible providers, for the "+ 添加" picker.
        // Excludes the official subscription presets (anthropic-agent /
        // openai-codex) — those are the built-in fallback for
        // single-type agents and don't need to be added manually. Sorted.
        availableProviders: sortProviders(allCompatible
          .filter(p => !['anthropic-agent', 'openai-codex'].includes(p.id))
        ).map(p => ({
            id: p.id, name: p.name, type: p.type,
            added: homeSet.has(p.id),
          })),
        // Reconciliation: entries living in the agent's own config file but
        // NOT on the home list — written by old OKIT versions before the
        // home-list curation existed, orphaned when ownership tracking was
        // lost, or created by the user outside OKIT. Entries under a known
        // OKIT provider id can be adopted into the home list or removed;
        // unknown ids are the user's own and surface read-only (never
        // touched).
        externalSites: ADDITIVE_AGENTS.has(adapter.id)
          ? [...enabledSet]
              .filter(id => !homeSet.has(id) && !id.startsWith('builtin:'))
              .map(id => {
                const known = providers.find(p => p.id === id);
                return { id, name: (known && known.name) || id, known: !!known };
              })
              .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
          : [],
      };
    }));

    res.json({ adapters: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function launchAgent(req, res) {
  const { agentId, cwd } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const adapter = ADAPTERS.find(a => a.id === agentId);
  if (!adapter) return res.status(404).json({ error: `Agent not found: ${agentId}` });
  if (!adapter.command) return res.status(400).json({ error: `${adapter.name} 不支持一键打开` });

  try {
    if (adapter.launchType === 'app') {
      const appName = adapter.appName || adapter.name;
      const { spawn } = require('child_process');
      if (os.platform() === 'darwin') {
        spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' }).unref();
      } else if (os.platform() === 'win32') {
        spawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore', shell: true }).unref();
      } else {
        spawn(adapter.command, [], { detached: true, stdio: 'ignore' }).unref();
      }
      res.json({ success: true, agentId, launched: 'app', appName });
      return;
    }

    const commandPath = findCommand(adapter.command);
    if (!commandPath) {
      return res.status(404).json({ error: `${adapter.name} CLI 未安装或不在 PATH 中` });
    }

    const launchDir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
    const command = `cd ${shellQuote(launchDir)} && ${shellQuote(commandPath)}`;

    await openTerminal(command);
    res.json({ success: true, agentId, command: adapter.command });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function openTerminal(command) {
  // safe: command is internally generated, not from user input
  if (typeof command !== 'string') throw new Error('command must be a string');
  const { spawn } = require('child_process');
  const platform = os.platform();

  if (platform === 'darwin') {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script ${appleScriptQuote(command)}`,
      'end tell',
    ].join('\n');
    return spawnDetached('osascript', ['-e', script]);
  }

  if (platform === 'linux') {
    // safe: command is internally generated, not from user input. bash -lc is intentional
    // for terminal launch; the command is constructed from validated paths in launchAgent.
    const terminals = [
      ['gnome-terminal', ['--', 'bash', '-lc', `${command}; exec bash`]],
      ['konsole', ['-e', 'bash', '-lc', `${command}; exec bash`]],
      ['xterm', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ];
    const found = terminals.find(([cmd]) => findCommand(cmd));
    if (!found) throw new Error('未找到可用终端应用');
    return spawnDetached(found[0], found[1]);
  }

  if (platform === 'win32') {
    return spawnDetached('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command]);
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function createProvider(req, res) {
  try {
    const providers = await loadProviders();
    const { id, name, type, baseUrl, endpoints, vaultKey, authMode, models, executionMode, nativeAgentIds } = req.body;

    if (!id || !name) {
      return res.status(400).json({ error: 'Missing required fields: id, name' });
    }

    const provider = {
      id,
      name,
      type: type || (endpoints && endpoints[0] ? endpoints[0].type : 'openai'),
      baseUrl: baseUrl || (endpoints && endpoints[0] ? endpoints[0].baseUrl : ''),
      endpoints: endpoints || undefined,
      vaultKey: vaultKey || undefined,
      authMode: authMode || 'api_key',
      executionMode: executionMode || 'http_endpoint',
      nativeAgentIds: executionMode === 'agent_native' && Array.isArray(nativeAgentIds) ? nativeAgentIds : undefined,
      models: models || [],
    };

    const idx = providers.findIndex(p => p.id === id);
    if (idx >= 0) providers[idx] = provider;
    else providers.push(provider);

    await saveProviders(providers);
    res.json({ success: true, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateProvider(req, res) {
  try {
    const { id } = req.params;
    const providers = await loadProviders();
    const idx = providers.findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Provider not found' });

    const current = providers[idx];
    const editableFields = ['name', 'type', 'baseUrl', 'endpoints', 'vaultKey', 'authMode', 'models', 'executionMode', 'nativeAgentIds'];
    const patch = {};
    for (const field of editableFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) patch[field] = req.body[field];
    }
    const routeOrCredentialChanged = ['type', 'baseUrl', 'endpoints', 'vaultKey', 'authMode', 'executionMode']
      .some(field => Object.prototype.hasOwnProperty.call(patch, field) && JSON.stringify(patch[field]) !== JSON.stringify(current[field]));
    providers[idx] = { ...current, ...patch, id };
    if (routeOrCredentialChanged) {
      providers[idx].authVerified = undefined;
      providers[idx].authVerifiedKey = undefined;
      providers[idx].authVerifiedAt = undefined;
      providers[idx].authLastCheckedAt = undefined;
      providers[idx].authLastCheckedKey = undefined;
      providers[idx].authLastError = undefined;
      providers[idx].authState = undefined;
      providers[idx].authVerifiedEndpointIds = [];
      providers[idx].authEndpointStates = {};
    }
    await saveProviders(providers);
    res.json({ success: true, provider: providers[idx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function deleteProviderRoute(req, res) {
  try {
    const { id } = req.params;
    const providers = await loadProviders();
    const idx = providers.findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Provider not found' });

    providers.splice(idx, 1);
    await saveProviders(providers);

    // Deleting a provider globally must not orphan additive agents: remove the
    // entries OKIT wrote for it in each affected agent's own config (snapshotted
    // first) and drop it from the per-agent home lists.
    const config = await loadUserConfig();
    const home = { ...(config.homeProviders || {}) };
    let homeChanged = false;
    for (const agentId of Object.keys(home)) {
      const list = Array.isArray(home[agentId]) ? home[agentId] : [];
      if (!list.includes(id)) continue;
      if (ADDITIVE_AGENTS.has(agentId)) {
        try {
          const agentAdapter = _getAdapter(agentId);
          if (agentAdapter && typeof agentAdapter.removeProvider === 'function') {
            await snapBeforeWrite(agentId, 'deleteProvider');
            await agentAdapter.removeProvider(id);
          }
        } catch (e) {
          console.warn(`[deleteProvider] removeProvider(${agentId}) failed: ${e.message}`);
        }
      }
      const next = list.filter(p => p !== id);
      if (next.length === 0) delete home[agentId];
      else home[agentId] = next;
      homeChanged = true;
    }
    if (homeChanged) {
      config.homeProviders = home;
      await saveUserConfig(config);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function switchProvider(req, res) {
  try {
    const { agentId, providerId, modelId } = req.body;
    if (!agentId || !providerId || !modelId) {
      return res.status(400).json({ error: 'Missing required fields: agentId, providerId, modelId' });
    }

    const adapter = ADAPTERS.find(a => a.id === agentId);
    if (!adapter) return res.status(404).json({ error: `Agent not found: ${agentId}` });

    const providers = await loadProviders();
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return res.status(404).json({ error: `Provider not found: ${providerId}` });

    if (!adapterSupportsProvider(adapter, provider)) {
      return res.status(400).json({ error: `${adapter.name} does not support ${provider.type} providers` });
    }

    let route;
    try {
      route = resolveModelRoute(provider, modelId, adapter);
    } catch (routeError) {
      return res.status(400).json({ error: routeError.message, code: 'MODEL_ROUTE_UNAVAILABLE' });
    }

    const auth = await ensureProviderAuth(provider, providers, route.endpointId);
    if (!auth.ok) {
      return res.status(401).json({ error: auth.message, code: auth.code });
    }

    // Apply config to agent via the TS adapter registry (single source of truth,
    // shared with the CLI). The JS writer functions that used to live here were
    // deleted because they had drifted from the TS adapters and were untested.
    const agentAdapter = _getAdapter(agentId);
    if (!agentAdapter) return res.status(404).json({ error: `Adapter not implemented: ${agentId}` });
    // Snapshot the current agent config before overwriting it, so a bad switch
    // can be reverted. A snapshot failure must not block the switch.
    try {
      await capturePreSwitchSnapshot(agentId);
    } catch (snapErr) {
      console.warn(`[switchProvider] snapshot failed: ${snapErr.message}`);
    }
    try {
      // Filtered provider: the card's visible model set + the model being
      // switched to. Adapters write provider.models into agent configs and
      // must not receive the platform's full catalog.
      const visibilityConfig = await loadUserConfig();
      const agentProvider = providerForAgentWrite(visibilityConfig, provider, [modelId]);
      await agentAdapter.applyConfig(agentProvider, route.remoteModelId);
    } catch (applyErr) {
      appendLog('provider-switch', `${agentId}:${providerId}`, false, `applyConfig failed: ${applyErr.message}`);
      throw applyErr;
    }

    // Save selection. Merge — adapters for additive agents (workbuddy) store
    // their managedModels tracking under the same key, and a plain replace
    // here would wipe it right after applyConfig wrote it.
    const config = await loadUserConfig();
    if (!config.providers) config.providers = {};
    config.providers[agentId] = { ...config.providers[agentId], providerId, modelId };

    // For Claude, also update legacy path
    if (agentId === 'claude') {
      config.claude = { ...config.claude, name: provider.name, model: modelId };
    }

    // Auto-record this switch in recentModels (prepend, dedupe by
    // providerId+modelId, cap at RECENT_MODELS_MAX).
    const entry = { providerId, modelId, agentId, lastUsedAt: new Date().toISOString() };
    const recent = Array.isArray(config.recentModels) ? config.recentModels : [];
    config.recentModels = [
      entry,
      ...recent.filter(m => !(m.providerId === providerId && m.modelId === modelId)),
    ].slice(0, RECENT_MODELS_MAX);

    await saveUserConfig(config);

    appendLog('provider-switch', `${agentId}:${providerId}`, true, `model=${modelId}`);

    res.json({
      success: true,
      agentId,
      providerId,
      modelId,
      route: { executionMode: route.executionMode, endpointId: route.endpointId, remoteModelId: route.remoteModelId },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// --- Home-page provider list (curated per agent) ---------------------------
//
// The home page only shows providers the user explicitly added — not every
// configured provider. This keeps the daily-driver surface small. Adding a
// provider to the home list does NOT switch to it; it just surfaces it for
// quick switching. Removing hides it from the home list without deleting it.

// ─── Model visibility: inclusion model ─────────────────────────────────────
//
// One list per provider — codexCatalogVisible — holding the model ids the
// user ADDED to the card. Default (absent) = empty card; the user curates by
// adding, never by hiding. Replaced the old exclusion model (hide list +
// stealth-restore list + recent auto-hide gating): with an empty-by-default
// card those mechanisms are redundant — the picker simply lists everything
// not added yet, with the recent flag as a display-ordering hint only.

// Legacy → inclusion migration. visible = (recent && not hidden) ∪ restored.
// Providers without any legacy state keep their "all recent visible" cards.
// Runs once; drops the legacy fields afterwards.
async function migrateVisibility(config) {
  if (config.codexCatalogVisibleMigrated) return config;
  const providers = await loadProviders();
  const visible = {};
  for (const p of providers) {
    const excluded = new Set((config.codexCatalogExcluded || {})[p.id] || []);
    const extra = new Set((config.codexCatalogExtra || {})[p.id] || []);
    visible[p.id] = tagRecentModels(p.models || [])
      .filter(m => extra.has(m.id) || (!excluded.has(m.id) && m.recent))
      .map(m => m.id);
  }
  config.codexCatalogVisible = visible;
  config.codexCatalogVisibleMigrated = true;
  delete config.codexCatalogExcluded;
  delete config.codexCatalogExtra;
  return config;
}

// The visible ids for one provider; falls back to legacy computation if the
// migration hasn't run yet (write paths must stay correct even pre-migration).
function visibleIdsFor(config, provider) {
  if (config.codexCatalogVisibleMigrated) {
    return (config.codexCatalogVisible || {})[provider.id] || [];
  }
  const excluded = new Set((config.codexCatalogExcluded || {})[provider.id] || []);
  const extra = new Set((config.codexCatalogExtra || {})[provider.id] || []);
  return tagRecentModels(provider.models || [])
    .filter(m => extra.has(m.id) || (!excluded.has(m.id) && m.recent))
    .map(m => m.id);
}

// The provider object handed to agent adapters carries ONLY the card's
// visible (user-added) model set — adapters write provider.models into the
// agent's own config, so passing the full catalog would flood the agent's
// model picker. The batch being written and any model an agent currently has
// selected on this provider are always included (an in-use model must never
// be dropped from the agent's config just because it's off the card).
function providerForAgentWrite(config, provider, extraIds) {
  const visible = new Set([...visibleIdsFor(config, provider), ...(extraIds || [])]);
  const active = new Set(
    Object.values(config.providers || {})
      .filter(sel => sel && sel.providerId === provider.id && sel.modelId)
      .map(sel => sel.modelId),
  );
  const models = (provider.models || []).filter(m => visible.has(m.id) || active.has(m.id));
  return { ...provider, models };
}

async function addHomeProvider(req, res) {
  try {
    const { agentId } = req.params;
    const { providerId } = req.body;
    if (!agentId || !providerId) {
      return res.status(400).json({ error: 'Missing agentId or providerId' });
    }
    const config = await loadUserConfig();
    const home = { ...(config.homeProviders || {}) };
    const list = Array.isArray(home[agentId]) ? [...home[agentId]] : [];
    if (!list.includes(providerId)) list.push(providerId);
    home[agentId] = list;
    config.homeProviders = home;

    const providers = await loadProviders();
    const provider = providers.find(p => p.id === providerId);

    // Adding a site starts EMPTY: no visible-models entry is created, and any
    // earlier entry for this provider is dropped — re-adding = fresh start.
    await migrateVisibility(config);
    if (config.codexCatalogVisible && providerId in config.codexCatalogVisible) {
      const nextVisible = { ...config.codexCatalogVisible };
      delete nextVisible[providerId];
      config.codexCatalogVisible = nextVisible;
    }

    // Additive agents (workbuddy/zcode): adding a provider to the home list
    // also writes its models into the agent's own config so the agent's model
    // picker offers them. Which models follow the home card's visibility
    // rules (recent + not manually hidden); ids colliding with entries OKIT
    // didn't write are skipped by the adapter, never overwritten.
    //
    // The agent-config write happens BEFORE the home list is persisted: if the
    // write fails we must NOT report success — otherwise the UI shows a site
    // that was never configured in the agent (fake success).
    let skippedModels;
    if (ADDITIVE_AGENTS.has(agentId)) {
      let entries = null;
      try {
        const jsAdapter = ADAPTERS.find(a => a.id === agentId);
        const agentAdapter = _getAdapter(agentId);
        if (jsAdapter && agentAdapter && typeof agentAdapter.applyModels === 'function' && provider) {
          const visible = new Set(visibleIdsFor(config, provider));
          const candidates = (provider.models || []).filter(m => visible.has(m.id));
          // Fresh add = empty card → nothing to write yet. The user checks
          // models in the "add models" view, which writes them via
          // applyAgentModels — no empty provider entry here.
          if (candidates.length > 0) {
            // Hand the adapter a provider whose model list is exactly the
            // visible set — adapters write provider.models into the agent
            // config and must not see the full catalog.
            const writeProvider = { ...provider, models: candidates };
            entries = [];
            for (const m of candidates) {
              try {
                const route = resolveModelRoute(provider, m.id, jsAdapter);
                entries.push({ provider: writeProvider, modelId: route.remoteModelId });
              } catch { /* model not routable for this agent — skip */ }
            }
            await snapBeforeWrite(agentId, 'addHomeProvider');
            const result = await agentAdapter.applyModels(entries);
            skippedModels = result.skipped;
          }
        }
      } catch (e) {
        appendLog('home-provider-add', `${agentId}:${providerId}`, false, `agent config write failed: ${e.message}`);
        return res.status(500).json({
          error: `写入 ${agentId} 配置失败: ${e.message}`,
          code: 'AGENT_WRITE_FAILED',
        });
      }
    }

    await saveUserConfig(config);
    appendLog('home-provider-add', `${agentId}:${providerId}`, true,
      skippedModels ? `skipped ${skippedModels.length} model(s)` : undefined);
    res.json({ success: true, homeProviders: list, skippedModels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function removeHomeProvider(req, res) {
  try {
    const { agentId, providerId } = req.params;
    if (!agentId || !providerId) {
      return res.status(400).json({ error: 'Missing agentId or providerId' });
    }
    const config = await loadUserConfig();
    const home = { ...(config.homeProviders || {}) };
    const list = Array.isArray(home[agentId]) ? [...home[agentId]].filter(id => id !== providerId) : [];

    // Additive agents: removing a provider from the home list also removes
    // the entries OKIT wrote for it in the agent's own config (including
    // their keys). Entries not written by OKIT are never touched.
    //
    // The agent-config removal happens BEFORE the home list is persisted: a
    // failure must surface as an error, not leave the UI believing the site
    // was removed while the agent still has it configured (fake success).
    if (ADDITIVE_AGENTS.has(agentId)) {
      try {
        const agentAdapter = _getAdapter(agentId);
        if (agentAdapter && typeof agentAdapter.removeProvider === 'function') {
          await snapBeforeWrite(agentId, 'removeHomeProvider');
          await agentAdapter.removeProvider(providerId);
        }
      } catch (e) {
        appendLog('home-provider-remove', `${agentId}:${providerId}`, false, `agent config write failed: ${e.message}`);
        return res.status(500).json({
          error: `从 ${agentId} 配置移除失败: ${e.message}`,
          code: 'AGENT_WRITE_FAILED',
        });
      }
    }

    if (list.length === 0) {
      delete home[agentId];
    } else {
      home[agentId] = list;
    }
    config.homeProviders = home;

    // Deleting a site deletes its state: once the provider is no longer on
    // ANY agent's home list, drop its visible-models list so a later re-add
    // is a genuine fresh start. Still listed on another agent → stays (the
    // list is shared per provider, not per agent).
    await migrateVisibility(config);
    const stillListed = Object.values(home).some(l => Array.isArray(l) && l.includes(providerId));
    if (!stillListed && config.codexCatalogVisible && providerId in config.codexCatalogVisible) {
      const nextVisible = { ...config.codexCatalogVisible };
      delete nextVisible[providerId];
      config.codexCatalogVisible = nextVisible;
    }
    await saveUserConfig(config);

    const warnings = [];

    // If the user removed the LAST provider OR the currently-active provider
    // for a single-type agent (claude / codex), auto-switch back to
    // the official subscription so the CLI doesn't keep using stale config.
    // Single-type agents are exclusive — the active provider must always be
    // one that still exists in the home list. This is a convenience re-target,
    // not the requested action — failures degrade to a warning, never to a
    // fake success of the removal itself (which did succeed).
    const SINGLE_TYPE_AGENTS = {
      'claude': { providerId: 'anthropic-agent', modelId: 'claude-sonnet-4-6' },
      'codex': { providerId: 'openai-codex', modelId: 'gpt-5.6-sol' },
    };
    const currentSel = config.providers?.[agentId];
    const removedWasCurrent = currentSel?.providerId === providerId;
    const shouldFallback = list.length === 0 || removedWasCurrent;
    if (shouldFallback && SINGLE_TYPE_AGENTS[agentId]) {
      try {
        const fallback = SINGLE_TYPE_AGENTS[agentId];
        const adapter = ADAPTERS.find(a => a.id === agentId);
        const providers = await loadProviders();
        const provider = providers.find(p => p.id === fallback.providerId);
        if (adapter && provider && adapterSupportsProvider(adapter, provider)) {
          const agentAdapter = _getAdapter(agentId);
          if (agentAdapter) {
            try {
              await capturePreSwitchSnapshot(agentId);
            } catch (snapErr) {
              console.warn(`[removeHomeProvider] snapshot failed: ${snapErr.message}`);
            }
            await agentAdapter.applyConfig(provider, fallback.modelId);
            const cfg = await loadUserConfig();
            if (!cfg.providers) cfg.providers = {};
            cfg.providers[agentId] = { providerId: fallback.providerId, modelId: fallback.modelId };
            await saveUserConfig(cfg);
          }
        }
      } catch (e) {
        warnings.push(`已从列表移除，但回退官方订阅失败: ${e.message}`);
        appendLog('home-provider-fallback', `${agentId}:${providerId}`, false, e.message);
      }
    }

    appendLog('home-provider-remove', `${agentId}:${providerId}`, true,
      warnings.length ? warnings.join('; ') : undefined);
    res.json({ success: true, homeProviders: list, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Write specific models of a home provider into an additive agent's own
// config. Called when the user checks models in the "add models" picker —
// with the empty-by-default add flow this is the moment models actually enter
// the agent. Append-only by design (adapters don't support per-model removal);
// unchecking a model later only hides it from the OKIT card.
async function applyAgentModels(req, res) {
  try {
    const { agentId } = req.params;
    const { providerId, modelIds } = req.body;
    if (!agentId || !providerId || !Array.isArray(modelIds) || modelIds.length === 0) {
      return res.status(400).json({ error: 'Missing agentId, providerId or modelIds' });
    }
    if (!ADDITIVE_AGENTS.has(agentId)) {
      // Non-additive agents don't keep per-model entries — switching writes
      // the single selected model. Nothing to do here.
      return res.json({ success: true, skipped: [] });
    }
    const jsAdapter = ADAPTERS.find(a => a.id === agentId);
    const agentAdapter = _getAdapter(agentId);
    if (!jsAdapter || !agentAdapter || typeof agentAdapter.applyModels !== 'function') {
      return res.status(404).json({ error: `Agent not supported: ${agentId}` });
    }
    const providers = await loadProviders();
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return res.status(404).json({ error: `Provider 不存在: ${providerId}` });

    const entries = [];
    const skipped = [];
    // Filtered provider: visible set + the batch, so adapters write exactly
    // what the user curated (not the platform's full catalog).
    const writeConfig = await loadUserConfig();
    const writeProvider = providerForAgentWrite(writeConfig, provider, modelIds);
    for (const modelId of modelIds) {
      try {
        const route = resolveModelRoute(provider, modelId, jsAdapter);
        entries.push({ provider: writeProvider, modelId: route.remoteModelId });
      } catch { skipped.push(modelId); }
    }
    if (entries.length === 0) {
      return res.status(400).json({ error: '没有可写入的模型', skipped });
    }
    await snapBeforeWrite(agentId, 'applyAgentModels');
    const result = await agentAdapter.applyModels(entries);
    appendLog('agent-models-apply', `${agentId}:${providerId}`, true,
      result.skipped && result.skipped.length ? `skipped ${result.skipped.length}` : undefined);
    res.json({ success: true, skipped: [...skipped, ...(result.skipped || [])] });
  } catch (err) {
    appendLog('agent-models-apply', `${req.params.agentId}:${(req.body || {}).providerId}`, false, err.message);
    res.status(500).json({ error: err.message });
  }
}

// Additive agents only (workbuddy/zcode): turn a site OFF in the agent's own
// config. The provider STAYS in the home list — this is the "switch off" for
// a site. Agents whose config supports an enabled flag (zcode) keep the
// entries and only flip enabled:false; agents without one (workbuddy) remove
// the entries entirely. Toggling back on rewrites via switchProvider.
// Exclusive agents don't support per-site disabling (their config only holds
// one active provider).
async function disableAgentProvider(req, res) {
  try {
    const { agentId } = req.params;
    const { providerId } = req.body || {};
    if (!agentId || !providerId) {
      return res.status(400).json({ error: 'Missing agentId or providerId' });
    }
    if (!ADDITIVE_AGENTS.has(agentId)) {
      return res.status(400).json({ error: `${agentId} 不支持按站点停用` });
    }
    const agentAdapter = _getAdapter(agentId);
    if (!agentAdapter) return res.status(404).json({ error: `Adapter not implemented: ${agentId}` });
    await snapBeforeWrite(agentId, 'disableAgentProvider');
    if (typeof agentAdapter.setProviderEnabled === 'function') {
      // Keep the entries, flip the enabled flag (zcode).
      await agentAdapter.setProviderEnabled(providerId, false);
    } else if (typeof agentAdapter.removeProvider === 'function') {
      // No enabled flag in the agent's config — remove the entries (workbuddy).
      await agentAdapter.removeProvider(providerId);
    } else {
      return res.status(400).json({ error: `${agentId} adapter 不支持停用站点` });
    }
    appendLog('provider-disable', `${agentId}:${providerId}`, true);
    res.json({ success: true, agentId, providerId });
  } catch (err) {
    appendLog('provider-disable', `${agentId}:${req.params.providerId}`, false, err.message);
    res.status(500).json({ error: err.message });
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
  // kernel's settings file where OKIT mirrors modelCatalog.overrides
  // (supportsImages gating for text-only models).
  'zcode': ['.zcode/v2/config.json', '.zcode/cli/config.json'],
  'hermes': ['.hermes/config.json'],
  'kimi-code': ['.kimi-code/config.toml'],
  'grok': ['.grok/config.toml'],
  'mimo-code': ['.config/mimocode/mimocode.jsonc'],
};

const MASKED_PLACEHOLDER = '___OKIT_MASKED___';

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

async function getAgentConfigFiles(req, res) {
  try {
    const { agentId } = req.params;
    const relPaths = AGENT_CONFIG_FILES[agentId];
    if (!relPaths) {
      return res.status(404).json({ error: `No config files mapped for agent: ${agentId}` });
    }
    const reveal = req.query.reveal === '1';
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
    res.json({ agentId, files, revealed: reveal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Save edited config file content. Only paths registered in AGENT_CONFIG_FILES
// for the given agent are writable — this prevents arbitrary file writes. The
// client sends the `~`-prefixed path it got from GET; we strip the prefix and
// match against the whitelist before touching disk.
async function saveAgentConfigFile(req, res) {
  try {
    const { agentId } = req.params;
    const { filePath, content } = req.body;
    const relPaths = AGENT_CONFIG_FILES[agentId];
    if (!relPaths) {
      return res.status(404).json({ error: `No config files mapped for agent: ${agentId}` });
    }
    if (!filePath || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing filePath or content' });
    }
    // Normalize: strip leading ~/ then match exactly against the whitelist.
    const rel = filePath.startsWith('~/') ? filePath.slice(2) : filePath;
    if (!relPaths.includes(rel)) {
      return res.status(403).json({ error: `Path not in writable whitelist: ${filePath}` });
    }
    // Reject masked-placeholder content and syntactically broken files before
    // they can corrupt the agent's config.
    const validationError = validateConfigContent(content, rel);
    if (validationError) {
      return res.status(400).json({ error: validationError, code: 'CONFIG_INVALID' });
    }
    const fullPath = path.join(os.homedir(), rel);
    // Snapshot before the manual edit lands, so viewer edits are revertible
    // exactly like provider switches.
    await snapBeforeWrite(agentId, 'saveAgentConfigFile');
    // Refuse to follow symlinks or escape the home dir.
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    appendLog('config-file-save', `${agentId}:${rel}`, true);
    res.json({ success: true, path: `~/${rel}` });
  } catch (err) {
    appendLog('config-file-save', `${agentId}:${req.body?.filePath || ''}`, false, err.message);
    res.status(500).json({ error: err.message });
  }
}

// --- Codex model-catalog exclusion -----------------------------------------
//
// Users choose which of a provider's models appear in Codex's /model list by
// unchecking them in the UI. We persist the UNCHECKED ids (not the checked
// ones) so that a brand-new model on the provider defaults to "checked =
// visible" without the user having to opt in. Toggling rewrites the catalog
// immediately so the change is reflected next time Codex reads it.

// Per-provider list of model ids the user ADDED to the card (inclusion
// model — see migrateVisibility). Absent entry = empty card.
async function setCatalogVisible(req, res) {
  try {
    const { providerId } = req.params;
    const { visible } = req.body; // string[] of model ids to show
    if (!providerId || !Array.isArray(visible)) {
      return res.status(400).json({ error: 'Missing providerId or visible[]' });
    }
    const config = await loadUserConfig();
    await migrateVisibility(config);
    if (!config.codexCatalogVisible) config.codexCatalogVisible = {};
    config.codexCatalogVisible[providerId] = visible;
    await saveUserConfig(config);
    res.json({ success: true, providerId, visible });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getCatalogVisible(_req, res) {
  try {
    const config = await loadUserConfig();
    await migrateVisibility(config);
    await saveUserConfig(config); // persist the one-time migration
    res.json({ visible: config.codexCatalogVisible || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// --- Claude Code tier mapping ------------------------------------------------
//
// Claude Code uses ANTHROPIC_MODEL + DEFAULT_HAIKU/SONNET/OPUS_MODEL. For
// third-party providers the user can map each tier to a different model id so
// Claude Code's internal tier-switching (fast/standard/powerful) routes to the
// right model on the gateway. We persist per-provider overrides; switching to
// a provider without overrides defaults all tiers to the selected model.

async function getTierMaps(_req, res) {
  try {
    const config = await loadUserConfig();
    res.json({ tierMaps: config.claudeTierMaps || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function setTierMap(req, res) {
  try {
    const { providerId } = req.params;
    const { haiku, sonnet, opus } = req.body;
    if (!providerId) {
      return res.status(400).json({ error: 'Missing providerId' });
    }
    const config = await loadUserConfig();
    if (!config.claudeTierMaps) config.claudeTierMaps = {};
    // Empty string / null = clear that tier (fall back to ANTHROPIC_MODEL).
    const map = {};
    if (haiku) map.haiku = haiku;
    if (sonnet) map.sonnet = sonnet;
    if (opus) map.opus = opus;
    if (Object.keys(map).length === 0) {
      delete config.claudeTierMaps[providerId];
    } else {
      config.claudeTierMaps[providerId] = map;
    }
    await saveUserConfig(config);
    res.json({ success: true, providerId, tierMap: map });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function resolveVaultKey(vaultKey) {
  try {
    const store = require('../../vault/store').VaultStore;
    const instance = new store();
    return await instance.get(vaultKey);
  } catch {
    return undefined;
  }
}

function missingVaultKeyPrefix(vaultKey) {
  const match = String(vaultKey || '').match(/^(.+)-([a-z0-9]{4})$/i);
  return match ? match[1] : null;
}

function resetProviderAuthState(provider) {
  provider.authVerified = undefined;
  provider.authVerifiedKey = undefined;
  provider.authVerifiedAt = undefined;
  provider.authLastCheckedAt = undefined;
  provider.authLastCheckedKey = undefined;
  provider.authLastError = undefined;
  provider.authState = undefined;
  provider.authVerifiedEndpointIds = [];
  provider.authEndpointStates = {};
}

/**
 * Repair a provider that still points at a deleted auto-generated Vault key.
 *
 * Auto-created keys use a stable prefix plus a four-character uniqueness
 * suffix. If the old reference disappeared and exactly one replacement with
 * the same prefix remains, rebinding is deterministic. Multiple candidates
 * are deliberately left untouched so a user's manually-created keys are
 * never silently swapped.
 */
async function repairMissingVaultBindings(providers, dependencies = {}) {
  const listVaultKeys = dependencies.listVaultKeys || (async () => {
    const { VaultStore } = require('../../vault/store');
    return new VaultStore().list();
  });
  const secrets = await listVaultKeys();
  const keys = Array.isArray(secrets) ? secrets.map(secret => secret.key).filter(Boolean) : [];
  const keySet = new Set(keys);
  let changed = false;

  for (const provider of providers || []) {
    if (!provider.vaultKey || keySet.has(provider.vaultKey)) continue;
    const prefix = missingVaultKeyPrefix(provider.vaultKey);
    if (!prefix) continue;
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const candidatePattern = new RegExp(`^${escapedPrefix}-[a-z0-9]{4}$`, 'i');
    const candidates = keys.filter(key => key !== provider.vaultKey && candidatePattern.test(key));
    if (candidates.length !== 1) continue;

    provider.vaultKey = candidates[0];
    resetProviderAuthState(provider);
    changed = true;
  }

  return { changed };
}

const AUTH_REVALIDATION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function supportsApiKey(p) {
  return p.authMode === 'api_key' || p.authMode === 'both' || !p.authMode;
}

function supportsOAuth(p) {
  return p.authMode === 'oauth' || p.authMode === 'both';
}

function providerEndpoints(p) {
  return providerEndpointEntries(p);
}

function isCredentialFailure(message) {
  return /API Key 无效|invalid[ _-]*(?:api[ _-]*)?key|incorrect api key|invalid access token|token (?:已过期|expired)|尚未登录|无可用密钥|unauthori[sz]ed|authentication failed|\b401\b/i.test(String(message || ''));
}

function isFreshAuth(p, endpointId) {
  if (p.authVerified !== true || !p.vaultKey) return false;
  if (p.authVerifiedKey && p.authVerifiedKey !== p.vaultKey) return false;
  if (endpointId) {
    const endpointState = p.authEndpointStates?.[endpointId];
    return endpointState?.state === 'verified'
      && Date.now() - Date.parse(endpointState.checkedAt) < AUTH_REVALIDATION_TTL_MS;
  }
  if (!p.authVerifiedAt) return false;
  return Date.now() - Date.parse(p.authVerifiedAt) < AUTH_REVALIDATION_TTL_MS;
}

async function revalidateProviderAuth(p, { force = false, endpointId, probe } = {}) {
  if (!supportsApiKey(p) || !p.vaultKey) return { checked: false, changed: false };

  const lastChecked = p.authLastCheckedAt ? Date.parse(p.authLastCheckedAt) : 0;
  const shouldCheck = force || !isFreshAuth(p, endpointId);
  if (!shouldCheck) return { checked: false, changed: false };
  const selectedEndpointHasState = !endpointId || Boolean(p.authEndpointStates?.[endpointId]);
  if (!force && selectedEndpointHasState && p.authLastCheckedKey === p.vaultKey && lastChecked && Date.now() - lastChecked < AUTH_RETRY_COOLDOWN_MS) {
    return { checked: false, changed: false };
  }

  const endpoints = providerEndpoints(p).filter(entry => !endpointId || entry.id === endpointId);
  if (endpoints.length === 0) return { checked: false, changed: false };

  // Lazy-load vault.js so provider validation tests can exercise routing logic
  // without loading the filesystem-backed VaultStore module.
  const testApiKeyResult = probe || require('./vault').testApiKeyResult;
  const results = await Promise.all(endpoints.map(async ({ id, endpoint }) => ({
    endpointId: id,
    endpoint,
    ...(await testApiKeyResult({
      baseUrl: endpoint.baseUrl,
      type: endpoint.type,
      protocol: endpoint.protocol,
      vaultKey: p.vaultKey,
    })),
  })));
  const checkedAt = new Date().toISOString();
  const allOk = results.length > 0 && results.every(result => result.success === true);
  const successful = results.filter(result => result.success === true);
  const credentialFailures = results.filter(result => !result.success && isCredentialFailure(result.message));
  const previous = JSON.stringify({
    authVerified: p.authVerified,
    authVerifiedKey: p.authVerifiedKey,
    authVerifiedAt: p.authVerifiedAt,
    authLastCheckedAt: p.authLastCheckedAt,
    authLastCheckedKey: p.authLastCheckedKey,
    authLastError: p.authLastError,
    authState: p.authState,
    authVerifiedEndpointIds: p.authVerifiedEndpointIds,
    authEndpointStates: p.authEndpointStates,
  });

  p.authLastCheckedAt = checkedAt;
  p.authLastCheckedKey = p.vaultKey;
  p.authEndpointStates = { ...(p.authEndpointStates || {}) };
  const currentEndpointIds = new Set(providerEndpoints(p).map(entry => entry.id));
  for (const storedEndpointId of Object.keys(p.authEndpointStates)) {
    if (!currentEndpointIds.has(storedEndpointId)) delete p.authEndpointStates[storedEndpointId];
  }
  for (const result of results) {
    const previousState = p.authEndpointStates[result.endpointId];
    p.authEndpointStates[result.endpointId] = result.success
      ? { state: 'verified', checkedAt }
      : isCredentialFailure(result.message)
        ? { state: 'invalid', checkedAt, error: result.message }
        : { state: previousState?.state === 'verified' ? 'stale' : 'unknown', checkedAt, error: result.message };
  }
  p.authVerifiedEndpointIds = Object.entries(p.authEndpointStates)
    .filter(([, state]) => state.state === 'verified' || state.state === 'stale')
    .map(([id]) => id);
  if (allOk) {
    p.authVerified = true;
    p.authVerifiedKey = p.vaultKey;
    p.authVerifiedAt = checkedAt;
    p.authLastError = undefined;
    p.authState = 'verified';
  } else if (successful.length > 0) {
    p.authVerified = true;
    p.authVerifiedKey = p.vaultKey;
    p.authVerifiedAt = checkedAt;
    p.authLastError = results.find(result => !result.success)?.message;
    p.authState = 'partial';
  } else if (credentialFailures.length === results.length) {
    p.authVerified = false;
    p.authLastError = credentialFailures[0]?.message;
    p.authState = 'invalid';
  } else {
    // Network/server errors do not invalidate a previously good key. Keep the
    // last known good state and expose it as stale so switching can continue.
    p.authLastError = results.find(result => !result.success)?.message || '连接复核失败';
    p.authState = p.authVerified === true ? 'stale' : 'needs_verification';
  }

  const current = JSON.stringify({
    authVerified: p.authVerified,
    authVerifiedKey: p.authVerifiedKey,
    authVerifiedAt: p.authVerifiedAt,
    authLastCheckedAt: p.authLastCheckedAt,
    authLastCheckedKey: p.authLastCheckedKey,
    authLastError: p.authLastError,
    authState: p.authState,
    authVerifiedEndpointIds: p.authVerifiedEndpointIds,
    authEndpointStates: p.authEndpointStates,
  });
  return { checked: true, changed: previous !== current, success: allOk, invalid: credentialFailures.length === results.length, results };
}

function authStateForProvider(p, { hasApiKey, oauthLoggedIn }) {
  if (p.authMode === 'none') return 'verified';
  if (supportsOAuth(p) && oauthLoggedIn === true) {
    return p.authVerified === true && hasApiKey ? 'mixed' : 'oauth_verified';
  }
  if (supportsApiKey(p)) {
    if (!hasApiKey) return supportsOAuth(p) ? 'oauth_required' : 'unconfigured';
    if (p.authState === 'invalid' || p.authVerified === false) return 'invalid';
    if (p.authState === 'stale') return 'stale';
    if (p.authState === 'partial') return 'partial';
    if (p.authVerified === true) return 'verified';
    return 'needs_verification';
  }
  return supportsOAuth(p) ? 'oauth_required' : 'unconfigured';
}

async function getProviderAuthSnapshot(p, endpointId, dependencies = {}) {
  const revalidation = await revalidateProviderAuth(p, { endpointId, probe: dependencies.probe });
  let hasApiKey = false;
  if (p.vaultKey) {
    const apiKey = await (dependencies.resolveVaultKey || resolveVaultKey)(p.vaultKey);
    hasApiKey = Boolean(apiKey);
  }
  const oauthLoggedIn = supportsOAuth(p)
    ? await (dependencies.detectOAuth || detectOAuth)(p.id)
    : null;
  return {
    id: p.id,
    name: p.name,
    hasApiKey,
    authVerified: p.authVerified === true,
    oauthLoggedIn,
    authMode: p.authMode,
    authState: authStateForProvider(p, { hasApiKey, oauthLoggedIn }),
    authVerifiedAt: p.authVerifiedAt,
    authLastCheckedAt: p.authLastCheckedAt,
    authLastError: p.authLastError,
    authEndpointStates: p.authEndpointStates || {},
    revalidation,
  };
}

async function ensureProviderAuth(p, allProviders, endpointId, dependencies = {}) {
  const snapshot = await getProviderAuthSnapshot(p, endpointId, dependencies);
  if (snapshot.revalidation?.changed && Array.isArray(allProviders)) {
    await saveProviders(allProviders);
  }
  const oauthOk = snapshot.oauthLoggedIn === true;
  const endpointState = endpointId ? snapshot.authEndpointStates?.[endpointId]?.state : undefined;
  const apiOk = snapshot.hasApiKey
    && snapshot.authVerified === true
    && snapshot.authState !== 'invalid'
    && (!endpointId || endpointState === 'verified' || endpointState === 'stale');
  if (oauthOk || apiOk || (!supportsApiKey(p) && !supportsOAuth(p))) {
    return { ok: true, snapshot };
  }
  if (supportsOAuth(p) && !oauthOk && !snapshot.hasApiKey) {
    return { ok: false, code: 'OAUTH_REQUIRED', message: '请先完成 OAuth 登录' };
  }
  if (!snapshot.hasApiKey) {
    return { ok: false, code: 'AUTH_REQUIRED', message: '请先绑定 API Key' };
  }
  if (snapshot.authState === 'invalid') {
    return { ok: false, code: 'AUTH_INVALID', message: snapshot.authLastError || 'API Key 已失效，请重新认证' };
  }
  if (endpointId && endpointState === 'invalid') {
    return { ok: false, code: 'AUTH_INVALID', message: snapshot.authEndpointStates[endpointId]?.error || '该模型来源端点的 API Key 已失效' };
  }
  return { ok: false, code: 'AUTH_VERIFICATION_REQUIRED', message: 'API Key 尚未完成认证，请先连接一次' };
}

async function getAuthStatus(req, res) {
  try {
    const providers = await loadProviders();
    const repaired = await repairMissingVaultBindings(providers);
    if (repaired.changed) await saveProviders(providers);
    const snapshots = await Promise.all(providers.map(p => getProviderAuthSnapshot(p)));
    if (snapshots.some(snapshot => snapshot.revalidation?.changed)) {
      await saveProviders(providers);
    }
    const results = snapshots.map(({ revalidation, ...status }) => status);

    res.json({ statuses: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function verifyProviderAuth(req, res) {
  try {
    const providers = await loadProviders();
    const provider = providers.find(item => item.id === req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    if (!supportsApiKey(provider)) {
      return res.status(400).json({ error: '该 Offering 不使用 API Key 认证' });
    }
    if (!provider.vaultKey) {
      return res.status(400).json({ error: '请先绑定 API Key' });
    }
    const revalidation = await revalidateProviderAuth(provider, { force: true });
    if (revalidation.changed) await saveProviders(providers);
    const snapshot = await getProviderAuthSnapshot(provider);
    const { revalidation: _ignored, ...status } = snapshot;
    res.json({
      success: status.authVerified && status.authState !== 'invalid',
      status,
      results: revalidation.results || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function triggerOAuthLogin(req, res) {
  const { providerId } = req.body;
  if (!providerId) return res.status(400).json({ error: 'providerId required' });

  const os = require('os');
  const platform = os.platform();

  // Platform-specific OAuth URLs and CLI commands
  const entries = {
    anthropic: { name: 'Claude Code', cli: 'claude', cliArgs: ['auth', 'login', '--claudeai'] },
    'anthropic-agent': { name: 'Claude Code', cli: 'claude', cliArgs: ['auth', 'login', '--claudeai'] },
    'openai-codex': { name: 'ChatGPT', url: 'https://chatgpt.com/', cli: 'codex', cliArgs: ['auth', 'login'] },
    'xai-grok-build': { name: 'SuperGrok', cli: 'grok', cliArgs: ['login'] },
    'github-copilot': { name: 'GitHub Copilot', cli: 'copilot', cliArgs: ['login'] },
  };

  const entry = entries[providerId];
  if (!entry) {
    return res.status(400).json({ error: `${providerId} 不支持 OAuth 登录` });
  }

  // Try CLI login first (if installed), fall back to opening URL.
  // safe: cliArgs comes from the hardcoded `entries` registry above, not user input.
  // Still validate each arg is a string to defend against any unexpected mutation.
  const cliPath = findCommand(entry.cli);
  if (cliPath) {
    if (!Array.isArray(entry.cliArgs) || entry.cliArgs.some(a => typeof a !== 'string')) {
      return res.status(500).json({ error: 'invalid cliArgs' });
    }
    const launched = launchInteractiveCli(platform, cliPath, entry.cliArgs);
    if (!launched) {
      return res.status(500).json({
        error: `无法打开交互式终端，请手动运行：${entry.cli} ${entry.cliArgs.join(' ')}`,
      });
    }
    return res.json({
      success: true,
      message: `已在终端打开 ${entry.name} OAuth 登录`,
    });
  }

  // A normal web login cannot create local CLI credentials. Providers without
  // a browser-only fallback must tell the user which CLI login to run instead
  // of opening an unrelated account console.
  if (!entry.url) {
    return res.status(400).json({
      error: `未检测到 ${entry.name} CLI，请先安装 ${entry.cli}，再运行：${entry.cli} ${entry.cliArgs.join(' ')}`,
    });
  }

  // Browser-only fallback for providers whose login can complete without a
  // local CLI callback.
  // Validate the URL scheme before spawning to prevent injection via crafted URLs.
  const url = entry.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'invalid oauth url' });
  }
  const openCmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  // No shell: pass URL as a discrete argument to avoid shell interpolation.
  if (openCmd === 'start') {
    // Windows `start` requires a leading title arg; spawn directly without shell.
    spawn(openCmd, ['', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(openCmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }

  res.json({ success: true, message: `已打开 ${entry.name} 控制台，完成登录后刷新状态` });
}

function launchInteractiveCli(platform, cliPath, args) {
  const { spawn } = require('child_process');
  const env = { ...process.env, FORCE_COLOR: '1' };

  if (platform === 'darwin') {
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const command = [cliPath, ...args].map(quote).join(' ');
    const child = spawn('/usr/bin/osascript', [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`,
    ], { detached: true, stdio: 'ignore', env });
    child.unref();
    return true;
  }

  if (platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return true;
  }

  const terminalCandidates = [
    { command: 'x-terminal-emulator', args: ['-e'] },
    { command: 'gnome-terminal', args: ['--'] },
    { command: 'konsole', args: ['-e'] },
  ];
  for (const terminal of terminalCandidates) {
    const terminalPath = findCommand(terminal.command);
    if (!terminalPath) continue;
    const child = spawn(terminalPath, [...terminal.args, cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return true;
  }
  return false;
}

function findCommand(cmd) {
  // Validate command name to prevent injection: only allow alphanumerics, dash, underscore.
  if (typeof cmd !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(cmd)) return null;
  const { spawnSync } = require('child_process');
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      // No shell: pass args as array. `where` is the Windows equivalent of `which`.
      const result = spawnSync('where', [cmd], { encoding: 'utf-8', timeout: 5000 });
      const out = (result.stdout || '').trim();
      return out.split(/\r?\n/)[0] || null;
    }
    const result = spawnSync('which', [cmd], { encoding: 'utf-8', timeout: 5000 });
    const out = (result.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

function timestampIsValid(value) {
  if (value === undefined || value === null || value === '') return true;
  const numeric = typeof value === 'number' ? value : Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  return !Number.isFinite(timestamp) || timestamp > Date.now() + 30_000;
}

function jwtIsValid(token) {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return true;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !payload.exp || payload.exp * 1000 > Date.now() + 30_000;
  } catch {
    return true;
  }
}

async function detectOAuth(providerId) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();

  try {
    switch (providerId) {
      case 'anthropic':
      case 'anthropic-agent': {
        const credPath = path.join(home, '.claude', '.credentials.json');
        if (!fs.existsSync(credPath)) return false;
        const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        const oauth = data.claudeAiOauth || data.oauth || data;
        const token = oauth.accessToken || oauth.access_token || data.accessToken || data.claudeApiKey || data.apiKey;
        return jwtIsValid(token) && timestampIsValid(oauth.expiresAt || oauth.expires_at || oauth.expiry_date);
      }
      case 'openai':
      case 'openai-codex': {
        const authPath = path.join(home, '.codex', 'auth.json');
        if (!fs.existsSync(authPath)) return false;
        const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        const token = data.tokens?.access_token;
        return jwtIsValid(token) && timestampIsValid(data.tokens?.expires_at || data.tokens?.expiry_date);
      }
      case 'xai-grok-build': {
        const authPath = path.join(home, '.grok', 'auth.json');
        if (!fs.existsSync(authPath)) return false;
        const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        const credentials = [data, ...Object.values(data || {})]
          .filter(value => value && typeof value === 'object' && !Array.isArray(value));
        return credentials.some(credential => !!(
          credential.key
          || credential.refresh_token
          || credential.access_token
          || credential.accessToken
          || credential.tokens?.access_token
        ));
      }
      case 'github-copilot': {
        if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
        if (os.platform() === 'darwin') {
          const { spawnSync } = require('child_process');
          const result = spawnSync('security', ['find-generic-password', '-s', 'copilot-cli'], {
            stdio: 'ignore',
            timeout: 5000,
          });
          if (result.status === 0) return true;
        }
        for (const filename of ['auth.json', 'config.json']) {
          const credentialPath = path.join(home, '.copilot', filename);
          if (!fs.existsSync(credentialPath)) continue;
          const data = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
          if (data.access_token || data.accessToken || data.oauth_token || data.token) return true;
        }
        return false;
      }
      default:
        return null;
    }
  } catch {
    return false;
  }
}

async function readCodexCachedModels() {
  const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (!(await fs.pathExists(cachePath))) {
    throw new Error('未找到 Codex 模型缓存，请先完成 OAuth 登录并启动一次 Codex');
  }

  let cache;
  try {
    cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
  } catch {
    throw new Error('Codex 模型缓存无法读取');
  }

  const entries = Array.isArray(cache) ? cache : cache.models;
  if (!Array.isArray(entries)) throw new Error('Codex 模型缓存格式无效');

  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : (entry?.slug || entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof entry === 'string' ? entry : (entry.display_name || entry.name || id),
    });
  }
  if (models.length === 0) throw new Error('Codex 模型缓存中没有可用模型');
  return models;
}

async function readGrokCliModels() {
  const cliPath = findCommand('grok');
  if (!cliPath) throw new Error('未检测到 Grok CLI，请先安装 Grok');
  const { spawnSync } = require('child_process');
  const result = spawnSync(cliPath, ['models'], {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || 'Grok 模型列表读取失败');
  const marker = 'Available models:';
  const output = String(result.stdout || '');
  const lines = output.includes(marker) ? output.slice(output.indexOf(marker) + marker.length).split(/\r?\n/) : [];
  const models = lines.map(line => {
    const match = line.match(/^\s*[*-]\s+([^\s(]+)/);
    return match ? { id: match[1], name: match[1] } : null;
  }).filter(Boolean);
  if (!models.length) throw new Error('Grok CLI 没有返回可用模型，请先完成 grok login');
  return models;
}

async function readCopilotCliModels() {
  const cliPath = findCommand('copilot');
  if (!cliPath) throw new Error('未检测到 GitHub Copilot CLI，请先安装 Copilot CLI');

  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    useLoggedInUser: true,
    workingDirectory: process.cwd(),
    logLevel: 'error',
  });

  try {
    await client.start();
    const entries = await client.listModels();
    const seen = new Set();
    const models = entries
      .filter(entry => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
      .map(entry => ({ id: entry.id, name: entry.name || entry.label || entry.id }));
    if (models.length === 0) throw new Error('Copilot 当前账号没有返回可用模型');
    return models;
  } finally {
    await client.stop().catch(() => client.forceStop());
  }
}

function withNativeAvailability(provider, models, source = 'static') {
  const now = new Date().toISOString();
  return models.map(model => ({
    ...model,
    availability: [{
      executionMode: 'agent_native',
      nativeAgentIds: provider.nativeAgentIds || [],
      remoteModelId: model.id,
      status: 'available',
      source,
      discoveredAt: now,
      lastSeenAt: now,
    }],
  }));
}

// Full-replace refresh semantics for remote-origin models. After a successful
// /models fetch, the platform's list is the source of truth: ids the platform
// no longer returns are DROPPED (keeping them would let users select models
// that 404), while user-added models (origin 'user') and any model an agent
// currently has selected on THIS provider survive untouched. Legacy entries
// (no origin) are treated as remote. Availability is rebuilt from this
// fetch's discoveries for refreshed models, preserved for survivors.
function replaceRemoteModels(provider, discoveries, activeModelIds) {
  const now = new Date().toISOString();
  const byId = new Map();
  for (const d of discoveries) {
    if (!byId.has(d.model.id)) byId.set(d.model.id, []);
    byId.get(d.model.id).push(d);
  }
  const next = [];
  const seen = new Set();
  for (const model of provider.models || []) {
    const fresh = byId.get(model.id);
    const survives = model.origin === 'user' || activeModelIds.has(model.id);
    if (!fresh && !survives) continue; // delisted — drop
    const entry = { ...model };
    if (fresh) {
      entry.origin = 'remote';
      entry.name = model.name || fresh[0].model.name || model.id;
      entry.availability = fresh.map(d => ({
        executionMode: 'http_endpoint',
        endpointId: d.endpointId,
        remoteModelId: d.model.id,
        status: 'available',
        source: 'remote',
        discoveredAt: now,
        lastSeenAt: now,
      }));
    }
    if (!Array.isArray(entry.availability) || entry.availability.length === 0) {
      entry.availability = [{
        executionMode: 'http_endpoint',
        remoteModelId: model.id,
        status: 'unknown',
        source: 'legacy_unknown',
      }];
    }
    next.push(entry);
    seen.add(model.id);
  }
  for (const [id, list] of byId) {
    if (seen.has(id)) continue;
    next.push({
      id,
      name: list[0].model.name || id,
      origin: 'remote',
      availability: list.map(d => ({
        executionMode: 'http_endpoint',
        endpointId: d.endpointId,
        remoteModelId: d.model.id,
        status: 'available',
        source: 'remote',
        discoveredAt: now,
        lastSeenAt: now,
      })),
    });
  }
  return next;
}

async function fetchModels(req, res) {
  const { providerId, endpoints: requestedEndpoints, vaultKey: requestedVaultKey } = req.body;
  const previewConfig = Array.isArray(requestedEndpoints) || Object.prototype.hasOwnProperty.call(req.body, 'vaultKey');
  if (!providerId && !previewConfig) return res.status(400).json({ error: 'providerId required' });

  try {
    const providers = await loadProviders();
    const p = providerId ? providers.find(x => x.id === providerId) : undefined;
    if (!p && !previewConfig) return res.status(404).json({ error: 'Provider 不存在' });

    if (p?.id === 'openai-codex' && !previewConfig) {
      // The ChatGPT subscription exposes no list-models API — Codex's own
      // runtime cache is the only fresh source. But OKIT must not HARD-depend
      // on another tool having run: when the cache isn't there yet, fall back
      // to the bundled preset list instead of failing the whole fetch.
      let cached = [];
      try {
        cached = await readCodexCachedModels();
      } catch { /* not run yet — preset list stands in */ }
      const source = cached.length ? cached : (p.models || []);
      if (source.length) {
        p.models = withNativeAvailability(p, source, 'cli');
        await saveProviders(providers);
      }
      return res.json({
        success: source.length > 0,
        models: p.models || source,
        kept: source.length === 0 ? p.models : undefined,
      });
    }

    if (p?.id === 'xai-grok-build' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 Grok 登录');
      const models = withNativeAvailability(p, await readGrokCliModels(), 'cli');
      p.models = models;
      await saveProviders(providers);
      return res.json({ success: true, models });
    }

    if (p?.id === 'github-copilot' && !previewConfig) {
      if (!(await detectOAuth(p.id))) throw new Error('请先完成 GitHub Copilot 登录');
      const models = withNativeAvailability(p, await readCopilotCliModels(), 'cli');
      p.models = models;
      await saveProviders(providers);
      return res.json({ success: true, models });
    }

    if (p && providerExecutionMode(p) === 'agent_native' && !previewConfig) {
      const models = withNativeAvailability(p, p.models || [], 'static');
      p.models = models;
      await saveProviders(providers);
      return res.json({ success: models.length > 0, models });
    }

    const apiKey = previewConfig
      ? (requestedVaultKey ? await resolveVaultKey(requestedVaultKey) : undefined)
      : (p?.vaultKey ? await resolveVaultKey(p.vaultKey) : undefined);
    const endpointEntries = Array.isArray(requestedEndpoints) && requestedEndpoints.length
      ? requestedEndpoints.map((endpoint, index) => ({ id: endpoint.id || `${providerId || 'preview'}:endpoint:${index}`, endpoint }))
      : (p ? providerEndpointEntries(p) : []);
    if (!endpointEntries.length) return res.status(400).json({ error: '至少需要一个有效端点' });
    const allModels = [];
    const discoveries = [];
    const successfulEndpointIds = new Set();
    const errors = [];

    for (const { id: endpointId, endpoint: ep } of endpointEntries) {
      try {
        let models = [];
        if (ep.type === 'openai') {
          models = isQianfanCodingEndpoint(ep.baseUrl)
            ? await fetchQianfanCodingModels(ep.baseUrl, apiKey)
            : await fetchOpenAIModels(ep.baseUrl, apiKey);
        } else if (ep.type === 'anthropic') {
          models = isQianfanCodingAnthropicEndpoint(ep.baseUrl)
            ? await fetchQianfanCodingAnthropicModels(ep.baseUrl, apiKey)
            : await fetchAnthropicModels(ep.baseUrl, apiKey);
        }
        successfulEndpointIds.add(endpointId);
        for (const m of models) {
          if (!allModels.find(x => x.id === m.id)) allModels.push(m);
          discoveries.push({ endpointId, model: m });
        }
      } catch (err) {
        errors.push({ endpoint: ep.baseUrl, error: err.message });
      }
    }

    if (allModels.length > 0 && p && !previewConfig) {
      // Refresh = full replace of remote models (delisted ids drop out).
      // Models any agent currently has selected on this provider survive so
      // an in-flight selection never dangles.
      const userConfig = await loadUserConfig();
      const activeModelIds = new Set(
        Object.values(userConfig.providers || {})
          .filter(sel => sel && sel.providerId === providerId && sel.modelId)
          .map(sel => sel.modelId),
      );
      p.models = replaceRemoteModels(p, discoveries, activeModelIds);
      // models.dev enrichment: platform /models gives bare ids — attach
      // context/output/tool/reasoning/multimodal metadata from the catalog.
      try {
        p.models = await require('./models-dev').enrichModels(p, p.models);
      } catch (enrichErr) {
        console.warn(`[fetchModels] models.dev enrichment failed: ${enrichErr.message}`);
      }
      // Drop visible ids the platform no longer lists (delisted models must
      // leave the card, not linger as ghost chips).
      const userCfg = await loadUserConfig();
      await migrateVisibility(userCfg);
      if (userCfg.codexCatalogVisible && Array.isArray(userCfg.codexCatalogVisible[providerId])) {
        const freshIds = new Set(p.models.map(m => m.id));
        const pruned = userCfg.codexCatalogVisible[providerId].filter(id => freshIds.has(id));
        if (pruned.length !== userCfg.codexCatalogVisible[providerId].length) {
          userCfg.codexCatalogVisible = { ...userCfg.codexCatalogVisible, [providerId]: pruned };
          await saveUserConfig(userCfg);
        }
      }
      await saveProviders(providers);
    }

    res.json({
      success: allModels.length > 0,
      models: p && !previewConfig && allModels.length > 0 ? p.models : allModels,
      errors: errors.length > 0 ? errors : undefined,
      kept: allModels.length === 0 && p ? p.models : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function fetchOpenAIModels(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const result = await httpReq(url, { method: 'GET', headers, timeout: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.status === 200) {
    const d = JSON.parse(result.body);
    const models = (d.data || []).map(m => ({ id: m.id, name: m.id }));
    if (models.length) return models;
  }
  // Some deployments return 200 with an empty list, or 404/403/405 when the
  // /models endpoint is not exposed. For Coding Plan providers we probe the
  // chat endpoint with a plan-specific model and return the known fallback
  // list on success so the UI shows usable models instead of "sync failed".
  const fallback = getFallbackModels(baseUrl);
  if (fallback && (result.status === 200 || result.status === 404 || result.status === 403 || result.status === 405)) {
    let probeResult;
    for (const probeModel of getProbeModels(baseUrl)) {
      const probeBody = JSON.stringify({
        model: probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      probeResult = await httpReq(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers, body: probeBody, timeout: 10000,
      });
      if (probeResult.error) throw new Error(probeResult.error);
      // 200 or 400 (bad request for max_tokens=1 etc.) both mean the key is
      // valid and the endpoint is reachable — return the known model list.
      if (probeResult.status === 200 || probeResult.status === 400) return fallback;
      if (isModelAccessFailure(probeResult.status, probeResult.body)) continue;
      if (getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body)) return fallback;
      if (probeResult.status === 401) throw new Error('API Key 无效');
      break;
    }
    // A model-level denial means authentication succeeded. Keep the offering
    // catalog visible; entitlement is evaluated when the user selects a model.
    if (probeResult && isModelAccessFailure(probeResult.status, probeResult.body)) return fallback;
    throw new Error(`HTTP ${probeResult?.status || 0}`);
  }
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  return [];
}

async function fetchQianfanCodingModels(baseUrl, apiKey) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const listResult = await httpReq(`${root}/models`, { method: 'GET', headers, timeout: 10000 });
  if (listResult.error) throw new Error(listResult.error);

  const listCode = qianfanCodingErrorCode(listResult.body);
  const listMessage = qianfanCodingErrorMessage(listCode);
  if (listMessage) throw new Error(listMessage);
  if (listResult.status === 200) {
    const data = JSON.parse(listResult.body);
    const models = (data.data || []).map(m => ({ id: m.id, name: m.id }));
    if (models.length) return models;
  }

  // The Coding Plan documentation guarantees the chat route and model names,
  // but some deployments do not expose /models. Validate the key with the
  // documented model and use the known list only after the probe succeeds.
  if (listResult.status === 404 || listResult.status === 405 || listResult.status === 200) {
    const probeBody = JSON.stringify({
      model: QIANFAN_CODING_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const probeResult = await httpReq(`${root}/chat/completions`, {
      method: 'POST', headers, body: probeBody, timeout: 10000,
    });
    if (probeResult.error) throw new Error(probeResult.error);
    const probeCode = qianfanCodingErrorCode(probeResult.body);
    const probeMessage = qianfanCodingErrorMessage(probeCode);
    if (probeMessage) throw new Error(probeMessage);
    if (probeResult.status === 200 || probeResult.status === 400) return qianfanCodingModels();
    if (probeResult.status === 401) throw new Error('百度千帆 Coding Plan API Key 无效');
    throw new Error(`HTTP ${probeResult.status}`);
  }

  if (listResult.status === 401) throw new Error('百度千帆 Coding Plan API Key 无效');
  throw new Error(`HTTP ${listResult.status}`);
}

async function fetchQianfanCodingAnthropicModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const headers = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  const body = JSON.stringify({
    model: QIANFAN_CODING_PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const result = await httpReq(`${root}/v1/messages`, {
    method: 'POST', headers, body, timeout: 10000,
  });
  if (result.error) throw new Error(result.error);
  const code = qianfanCodingErrorCode(result.body);
  const message = qianfanCodingErrorMessage(code);
  if (message) throw new Error(message);
  if (result.status === 200 || result.status === 400) return qianfanCodingModels();
  if (result.status === 401) throw new Error('百度千帆 Token Plan API Key 无效');
  throw new Error(`HTTP ${result.status}`);
}

async function fetchAnthropicModels(baseUrl, apiKey) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${root}/v1/models`;
  const headers = {};
  if (getAnthropicAuthMode(baseUrl) === 'bearer') {
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (/^https?:\/\/api\.minimax(?:i\.com|\.io)\/anthropic\/?$/i.test(String(baseUrl || '').trim())) {
    if (apiKey) headers['X-Api-Key'] = apiKey;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  if (/^https?:\/\/api\.z\.ai\/api\/anthropic\/?$/i.test(String(baseUrl || '').trim())) {
    headers['accept-language'] = 'en-US,en';
  }
  headers['anthropic-version'] = '2023-06-01';
  const result = await httpReq(url, { method: 'GET', headers, timeout: 10000 });
  if (result.error) throw new Error(result.error);
  if (result.status === 401) throw new Error('API Key 无效');
  if (result.status === 200) {
    const d = JSON.parse(result.body);
    const models = (d.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
    if (models.length) return models;
  }

  const fallback = getFallbackModels(baseUrl);
  if (fallback && (result.status === 200 || result.status === 403 || result.status === 404 || result.status === 405)) {
    headers['content-type'] = 'application/json';
    let probeResult;
    for (const probeModel of getProbeModels(baseUrl)) {
      const body = JSON.stringify({
        model: probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      probeResult = await httpReq(`${root}/v1/messages`, {
        method: 'POST', headers, body, timeout: 10000,
      });
      if (probeResult.error) throw new Error(probeResult.error);
      if (probeResult.status === 200 || probeResult.status === 400) return fallback;
      if (isModelAccessFailure(probeResult.status, probeResult.body)) continue;
      if (getAuthenticatedResourceFailureMessage(probeResult.status, probeResult.body)) return fallback;
      if (probeResult.status === 401) throw new Error('API Key 无效');
      break;
    }
    if (probeResult && isModelAccessFailure(probeResult.status, probeResult.body)) return fallback;
    throw new Error(`HTTP ${probeResult?.status || 0}`);
  }
  if (result.status === 404 || result.status === 405) throw new Error('不支持模型列表接口');
  throw new Error(`HTTP ${result.status}`);
}

function httpReq(url, options) {
  return new Promise((resolve) => {
    const parsed = new (require('url').URL)(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', err => resolve({ status: 0, error: err.message }));
    if (options.body) req.write(options.body);
    req.setTimeout(options.timeout || 10000, () => { req.destroy(); resolve({ status: 0, error: 'Timeout' }); });
    req.end();
  });
}

// ─── Deep Link: Provider Export / Import ───

const PROVIDER_CODE_PREFIX = 'okit-provider:';
const PROVIDER_CODE_SALT = 'okit-provider-salt';

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

async function exportProviderCode(req, res) {
  try {
    const { id, password } = req.body || {};
    if (!id) return res.status(400).json({ error: '请指定要导出的 provider id' });
    const providers = await loadProviders();
    const provider = providers.find(p => p.id === id);
    if (!provider) return res.status(404).json({ error: `未找到 provider: ${id}` });

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
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function importProviderCode(req, res) {
  try {
    const { code, password } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Provider 码不能为空' });
    const provider = decryptProviderPayload(code, password);
    if (!provider.id || !provider.name) {
      return res.status(400).json({ error: 'Provider 码内容无效：缺少 id 或 name' });
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
    res.json({ success: true, provider: full, created: !existed });
  } catch (err) {
    const status = err.message?.includes('密码不正确') || err.message?.includes('格式不正确') || err.message?.includes('需要密码') ? 400 : 500;
    res.status(status).json({ error: err.message });
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
  getAdaptersList,
  createProvider,
  updateProvider,
  deleteProvider: deleteProviderRoute,
  switchProvider,
  addHomeProvider,
  removeHomeProvider,
  applyAgentModels,
  disableAgentProvider,
  getAgentConfigFiles,
  saveAgentConfigFile,
  agentConfigPresence,
  setCatalogVisible,
  getCatalogVisible,
  getTierMaps,
  setTierMap,
  launchAgent,
  getAuthStatus,
  verifyProviderAuth,
  triggerOAuthLogin,
  fetchModels,
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
  },
};
