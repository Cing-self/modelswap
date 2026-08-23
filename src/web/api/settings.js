const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { backupImportantData } = require('./backup');
const { appendLog } = require('./log-writer');

const CONFIG_PATH = path.join(os.homedir(), '.okit', 'user.json');

const SENSITIVE_KEYS = ['accessKeySecret', 'password', 'token'];

async function loadConfig() {
  try {
    if (!(await fs.pathExists(CONFIG_PATH))) return {};
    return await fs.readJson(CONFIG_PATH);
  } catch { return {}; }
}

async function saveConfig(config) {
  await fs.ensureDir(path.dirname(CONFIG_PATH));
  await backupImportantData('settings');
  await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
}

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
    const { sync } = req.body;
    if (!sync) return res.status(400).json({ error: 'sync is required' });

    const config = await loadConfig();
    const autoSyncWasOn = !!config.sync?.autoSync;
    const prevLan = JSON.stringify(config.sync?.lan || null);

    if (sync) {
      const merged = mergeSensitive(config.sync, sync);
      config.sync = {
        ...config.sync,
        ...merged,
        platforms: {
          ...config.sync?.platforms,
          ...merged.platforms,
        },
      };
    }

    await saveConfig(config);
    const changes = [];
    if (sync) changes.push(...Object.keys(sync.platforms || {}));
    appendLog('settings-update', changes.join(',') || 'settings', true);
    res.json({ success: true, sync: maskConfig(config.sync) });

    // Toggling auto-sync on should adopt remote + flush pending without a restart
    if (sync && typeof sync.autoSync === 'boolean' && sync.autoSync && !autoSyncWasOn) {
      require('./sync-scheduler').syncNow().catch(() => {});
    }
    // LAN listener follows sync.lan changes without a server restart
    if (sync?.lan && JSON.stringify(config.sync?.lan || null) !== prevLan) {
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
    const config = await loadConfig();
    if (!config.hints) config.hints = {};
    config.hints.onboardingDone = true;
    await saveConfig(config);
    appendLog('onboarding-dismiss', 'onboarding', true);
    res.json({ success: true });
  } catch (error) {
    appendLog('onboarding-dismiss', 'onboarding', false, error.message);
    res.status(500).json({ error: 'Failed to dismiss onboarding' });
  }
}

async function resetOnboarding(req, res) {
  try {
    const config = await loadConfig();
    if (config.hints) delete config.hints.onboardingDone;
    await saveConfig(config);
    appendLog('onboarding-reset', 'onboarding', true);
    res.json({ success: true });
  } catch (error) {
    appendLog('onboarding-reset', 'onboarding', false, error.message);
    res.status(500).json({ error: 'Failed to reset onboarding' });
  }
}

module.exports = { getSettings, updateSettings, testPlatformConnection, getPresets, getOnboarding, dismissOnboarding, resetOnboarding };
