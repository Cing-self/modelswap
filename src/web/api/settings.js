const { appendLog } = require('./log-writer');

const SENSITIVE_KEYS = ['accessKeySecret', 'password', 'token'];

const core = () => require('./cloud-sync-core');
async function loadConfig() { return core().loadConfig(); }

function maskConfig(sync) {
  if (!sync) return sync;
  const masked = JSON.parse(JSON.stringify(sync));
  if (masked.password) masked.password = '***';
  if (masked.lan?.token) masked.lan.token = '***';
  if (!masked.platforms) return masked;
  for (const [, plat] of Object.entries(masked.platforms)) {
    for (const key of SENSITIVE_KEYS) {
      if (plat[key] && plat[key].length > 0) {
        plat[key] = '***';
      }
    }
  }
  return masked;
}

function mergeSensitive(current, patch) {
  if (!patch || !current) return patch || current;
  const merged = { ...patch };
  // Merge sync-level sensitive fields
  if (merged.password === '***' && current.password) {
    merged.password = current.password;
  }
  // sync.lan is patched as a whole object; shallow-merge it so partial
  // patches (e.g. {enabled:false}) never drop the stored token/port.
  if (merged.lan || current.lan) {
    merged.lan = { ...(current.lan || {}), ...(merged.lan || {}) };
    if (merged.lan.token === '***' && current.lan?.token) {
      merged.lan.token = current.lan.token;
    }
  }
  for (const [platName, platConfig] of Object.entries(merged.platforms || {})) {
    if (!platConfig || !current.platforms?.[platName]) continue;
    for (const key of SENSITIVE_KEYS) {
      if (platConfig[key] === '***' && current.platforms[platName][key]) {
        platConfig[key] = current.platforms[platName][key];
      }
    }
  }
  return merged;
}

async function getSettings(req, res) {
  try {
    const config = await loadConfig();
    const sync = config.sync || { autoSync: false, platforms: {} };
    res.json({ sync: maskConfig(sync) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
}

async function updateSettings(req, res) {
  try {
    const operations = req.body?.operations;
    if (!Array.isArray(operations) || operations.length === 0) return res.status(400).json({ error: 'operations are required' });
    if (operations.length > 50) return res.status(400).json({ error: 'too many operations' });
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sync')) return res.status(400).json({ error: 'snapshot sync updates are not accepted' });
    // Structural pre-validation for the whole batch: nothing is applied unless
    // every operation is at least shape-correct, so an invalid trailing item
    // cannot leave the earlier ones partially committed.
    const validValue = value => (['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)));
    const validTarget = operation => (
      operation.kind === 'platform'
        ? typeof operation.platformId === 'string' && operation.platformId !== '' && typeof operation.field === 'string' && operation.field !== ''
        : typeof operation.field === 'string' && operation.field !== ''
    );
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return res.status(400).json({ error: 'Invalid settings operation' });
      if (!['sync', 'platform', 'lan'].includes(operation.kind)) return res.status(400).json({ error: 'Invalid settings operation' });
      if (!validTarget(operation) || !validValue(operation.value)) return res.status(400).json({ error: 'Invalid settings operation' });
    }
    const before = await loadConfig();
    const autoSyncWasOn = !!before.sync?.autoSync;
    const prevLan = JSON.stringify(before.sync?.lan || null);
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') throw new Error('Invalid settings operation');
      if (operation.kind === 'sync') await core().setSyncField(operation.field, operation.value);
      else if (operation.kind === 'platform') await core().setPlatformField(operation.platformId, operation.field, operation.value);
      else if (operation.kind === 'lan') await core().setLanField(operation.field, operation.value);
      else throw new Error('Invalid settings operation');
    }
    const config = await loadConfig();
    const changes = operations.filter(item => item.kind === 'platform').map(item => item.platformId);
    appendLog('settings-update', changes.join(',') || 'settings', true);
    res.json({ success: true, sync: maskConfig(config.sync) });

    // Toggling auto-sync on should adopt remote + flush pending without a restart
    if (config.sync?.autoSync && !autoSyncWasOn) {
      require('./sync-scheduler').syncNow().catch(() => {});
    }
    // LAN listener follows sync.lan changes without a server restart
    if (JSON.stringify(config.sync?.lan || null) !== prevLan) {
      require('./lan-sync-server').applyConfig().catch(() => {});
    }
  } catch (error) {
    console.error('Error updating settings:', error);
    appendLog('settings-update', 'settings', false, error.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
}

async function testPlatformConnection(req, res) {
  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform is required' });
  try {
    const core = require('./cloud-sync-core');
    const result = await core.testConnection(platform);
    res.json({ success: true, message: result });
  } catch (error) {
    appendLog('platform-test', platform, false, error.message);
    res.json({ success: false, message: error.message });
  }
}

const PRESETS = [
  {
    id: 'claude-starter',
    name: 'Claude 全家桶',
    desc: '一键配齐 Claude Code，开始用 AI 写代码、写文案',
    icon: '✦',
    color: '#d97706',
    tools: ['claude-code'],
    requiredKeys: [
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', hint: '从 console.anthropic.com 获取' },
    ],
  },
  {
    id: 'ai-creative',
    name: 'AI 创意工坊',
    desc: 'Cursor + Claude 双工具，多种 AI 任你选',
    icon: '◆',
    color: '#7c3aed',
    tools: ['claude-code', 'cursor'],
    requiredKeys: [
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', hint: '从 platform.openai.com 获取' },
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', hint: '从 console.anthropic.com 获取' },
    ],
  },
  {
    id: 'ai-automation',
    name: 'AI 自动化',
    desc: 'Claude Code + Codex，让 AI 自动跑任务',
    icon: '⚡',
    color: '#0891b2',
    tools: ['claude-code', 'codex'],
    requiredKeys: [
      { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', hint: '从 platform.openai.com 获取' },
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', hint: '从 console.anthropic.com 获取' },
    ],
  },
];

async function getPresets(req, res) {
  res.json({ presets: PRESETS });
}

async function getOnboarding(req, res) {
  try {
    const config = await loadConfig();
    const done = !!config.hints?.onboardingDone;
    res.json({ done });
  } catch {
    res.json({ done: false });
  }
}

async function dismissOnboarding(req, res) {
  try {
    await core().setPreference('onboardingDone', true);
    appendLog('onboarding-dismiss', 'onboarding', true);
    res.json({ success: true });
  } catch (error) {
    appendLog('onboarding-dismiss', 'onboarding', false, error.message);
    res.status(500).json({ error: 'Failed to dismiss onboarding' });
  }
}

async function resetOnboarding(req, res) {
  try {
    await core().setPreference('onboardingDone', false);
    appendLog('onboarding-reset', 'onboarding', true);
    res.json({ success: true });
  } catch (error) {
    appendLog('onboarding-reset', 'onboarding', false, error.message);
    res.status(500).json({ error: 'Failed to reset onboarding' });
  }
}

module.exports = { getSettings, updateSettings, testPlatformConnection, getPresets, getOnboarding, dismissOnboarding, resetOnboarding };
