// Vault binding and provider authentication are application concerns.
function createProviderAuthService(deps) {
  const { fs, path, os, _store, loadProviders, saveProviders, buildPlatforms, getAnthropicAuthMode, providerEndpointEntries, appendLog } = deps;

async function resolveVaultKey(vaultKey) {
  try {
    const store = require('../vault/store').VaultStore;
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
    const { VaultStore } = require('../vault/store');
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
  const testApiKeyResult = probe || require('../web/api/vault').testApiKeyResult;
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
  // Finder/Dock-launched desktop builds inherit launchd's minimal PATH —
  // `which` would miss npm-global/homebrew/nvm-installed CLIs. agent-path
  // appends the standard install locations before resolving.
  const { detectionEnv } = require('../web/api/agent-path');
  try {
    if (platform === 'win32') {
      // No shell: pass args as array. `where` is the Windows equivalent of `which`.
      const result = spawnSync('where', [cmd], { encoding: 'utf-8', timeout: 5000, env: detectionEnv() });
      const out = (result.stdout || '').trim();
      return out.split(/\r?\n/)[0] || null;
    }
    const result = spawnSync('which', [cmd], { encoding: 'utf-8', timeout: 5000, env: detectionEnv() });
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

  return { resolveVaultKey, missingVaultKeyPrefix, resetProviderAuthState, repairMissingVaultBindings, supportsApiKey, supportsOAuth, providerEndpoints, isCredentialFailure, isFreshAuth, revalidateProviderAuth, authStateForProvider, getProviderAuthSnapshot, ensureProviderAuth, getAuthStatus, verifyProviderAuth, triggerOAuthLogin, detectOAuth, findCommand };
}
module.exports = { createProviderAuthService };
