const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { createUsageApiStrategies } = require('../../application/usage-api-strategies');
const { createUsageBrowserStrategies } = require('../../application/usage-browser-strategies');
const { createUsageCloudStrategies } = require('../../application/usage-cloud-strategies');
const { createUsageProviderRegistry } = require('../../application/usage-provider-registry');
const parsers = require('../../application/usage-parsers');
const PROVIDERS_PATH = path.join(os.homedir(), '.okit', 'providers.json');
const MIMO_CONSOLE_URL = 'https://platform.xiaomimimo.com/console/plan-manage';
const MIMO_BALANCE_CONSOLE_URL = 'https://platform.xiaomimimo.com/console/balance';
const MIMO_BALANCE_URL = 'https://platform.xiaomimimo.com/api/v1/balance';
const MIMO_SESSION_VAULT_KEY = 'XIAOMI_MIMO_TOKEN_PLAN_SESSION_COOKIE';
const SUPPORTED = new Set([
  'anthropic',        // Anthropic API (console-only billing)
  'openai-codex',    // Codex (ChatGPT subscription)
  'openai',           // OpenAI API (organization billing)
  'anthropic-agent', // Claude Code Agent subscription (Pro/Max)
  'xai-grok-build',  // Grok subscription (console-only stats)
  'github-copilot',  // GitHub Copilot subscription (GitHub billing stats)
  'glm-coding',      // GLM Coding Plan
  'zai-global-coding', // Z.AI Coding Plan
  'kimi-coding-plan',// Kimi Coding Plan
  'minimax-coding',  // Legacy provider ID; product name is MiniMax Token Plan
  'minimax-global-coding', // Legacy provider ID; product name is MiniMax Token Plan (international)
  'minimax',         // MiniMax API (console-only balance)
  'minimax-global',  // MiniMax API (international, console-only balance)
  'zai',              // 智谱 API (console-only balance)
  'zai-global',       // Z.AI API (console-only balance)
  'kimi-coding',     // Kimi API balance
  'openrouter',      // OpenRouter (prepaid balance)
  'volcengine',      // 火山引擎 API account balance
  'volcengine-coding', // 火山引擎 Coding Plan (needs AK/SK)
  'volcengine-agent', // 火山引擎 Agent Plan (needs AK/SK)
  'qwen-coding',      // 阿里云百炼 Coding Plan (console-only usage)
  'qwen-token-plan',  // 阿里云百炼 Token Plan (console-only usage)
  'qianfan-coding',   // 百度千帆 Token Plan (console-only usage)
  'tencent-token-plan', // 腾讯云 Token Plan (console-only usage)
  'opencode-go',      // OpenCode Go (console-only usage)
  'xiaomi-coding',    // 小米 MiMo Token Plan (console-only usage)
  'xiaomi',           // 小米 MiMo API (console-only balance)
  'qianfan',          // 百度千帆 API account balance
  'tencent',          // 腾讯云 API/TokenHub billing
  'xai',              // xAI API prepaid balance
  'stepfun',          // 阶跃星辰 (console-only balance)
  'stepfun-global',   // StepFun Global (console-only balance)
  // Goal ①: prepaid / pay-as-you-go balance providers.
  'deepseek',        // DeepSeek (充值制)
  'siliconflow',     // 硅基流动 (充值制)
  'moonshot',        // Moonshot (充值制)
  'mistral',         // Mistral (充值制)
  'qwen',            // 通义千问 (充值制)
]);

// Goal ①: classifies each supported provider so the frontend can split the
// usage page into Subscription (percentage + reset) vs Prepaid (balance) tabs.
// SUBSCRIPTION = quota-limited with a reset window (reported as usedPercent).
// PREPAID      = pay-as-you-go balance (reported as absolute credit amounts).
const UsageKind = { SUBSCRIPTION: 'subscription', PREPAID: 'prepaid' };
const PROVIDER_KIND = {
  // Subscription / coding-plan providers
  'anthropic': UsageKind.PREPAID,
  'openai': UsageKind.PREPAID,
  'openai-codex': UsageKind.SUBSCRIPTION,
  'anthropic-agent': UsageKind.SUBSCRIPTION,
  'xai-grok-build': UsageKind.SUBSCRIPTION,
  'github-copilot': UsageKind.SUBSCRIPTION,
  'glm-coding': UsageKind.SUBSCRIPTION,
  'zai-global-coding': UsageKind.SUBSCRIPTION,
  'kimi-coding-plan': UsageKind.SUBSCRIPTION,
  'minimax-coding': UsageKind.SUBSCRIPTION,
  'minimax-global-coding': UsageKind.SUBSCRIPTION,
  'qwen-coding': UsageKind.SUBSCRIPTION,
  'qwen-token-plan': UsageKind.SUBSCRIPTION,
  'qianfan-coding': UsageKind.SUBSCRIPTION,
  'tencent-token-plan': UsageKind.SUBSCRIPTION,
  'opencode-go': UsageKind.SUBSCRIPTION,
  'volcengine-coding': UsageKind.SUBSCRIPTION,
  'volcengine-agent': UsageKind.SUBSCRIPTION,
  'volcengine': UsageKind.PREPAID,
  'xiaomi-coding': UsageKind.SUBSCRIPTION,
  'minimax': UsageKind.PREPAID,
  'minimax-global': UsageKind.PREPAID,
  'zai': UsageKind.PREPAID,
  'zai-global': UsageKind.PREPAID,
  'kimi-coding': UsageKind.PREPAID,
  'xiaomi': UsageKind.PREPAID,
  'qianfan': UsageKind.PREPAID,
  'tencent': UsageKind.PREPAID,
  'xai': UsageKind.PREPAID,
  'stepfun': UsageKind.PREPAID,
  'stepfun-global': UsageKind.PREPAID,
  // Prepaid / balance providers
  'openrouter': UsageKind.PREPAID,
  'deepseek': UsageKind.PREPAID,
  'siliconflow': UsageKind.PREPAID,
  'moonshot': UsageKind.PREPAID,
  'mistral': UsageKind.PREPAID,
  'qwen': UsageKind.PREPAID,
};
function httpRequest(url, options) { return new Promise(resolve => { const parsed = new (require('url').URL)(url); const mod = parsed.protocol === 'https:' ? require('https') : require('http'); const request = mod.request(url, options, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body })); }); request.on('error', error => resolve({ status: 0, error: error.message })); if (options.body) request.write(options.body); request.setTimeout(options.timeout || 10000, () => { request.destroy(); resolve({ status: 0, error: 'Timeout' }); }); request.end(); }); }
// Keep the production composition at the HTTP edge. The lazy require lets
// Vitest import parser-only usage exports without loading TypeScript storage.
const createVaultStore = () => {
  const { VaultStore } = require('../../vault/store');
  return new VaultStore();
};
const api = createUsageApiStrategies({ fs, path, os, providersPath: PROVIDERS_PATH, createVaultStore, round1: parsers.round1, round4: parsers.round4, epochToISO: parsers.epochToISO });
const cloud = createUsageCloudStrategies({ resolveCredentialPair: api.resolveCredentialPair, resolveVaultKey: api.resolveVaultKey, httpRequest, accountBalanceResult: parsers.accountBalanceResult, managementCredentialNotice: api.managementCredentialNotice, round1: parsers.round1, epochToISO: parsers.epochToISO });
const browser = createUsageBrowserStrategies({ resolveVaultKey: api.resolveVaultKey, createVaultStore, httpRequest, queryConsoleOnlyUsage: cloud.queryConsoleOnlyUsage, round1: parsers.round1, round4: parsers.round4, epochToISO: parsers.epochToISO, accountBalanceResult: parsers.accountBalanceResult, MIMO_CONSOLE_URL, MIMO_BALANCE_CONSOLE_URL, MIMO_BALANCE_URL, MIMO_SESSION_VAULT_KEY });
const registry = createUsageProviderRegistry({ api, browser, cloud });
async function getUsage(req, res) { const providerId = req.params.providerId; if (!providerId) return res.status(400).json({ error: 'providerId required' }); try { const result = await registry.queryUsage(providerId); if (result && result.supported !== false) result.kind = PROVIDER_KIND[providerId] || UsageKind.SUBSCRIPTION; return res.json(result); } catch (error) { return res.json({ supported: false, error: error.message }); } }
const MANUAL_ONLY_USAGE = ['opencode-go'];
function getSupportedUsageProviders(_req, res) { return res.json({ providers: Array.from(SUPPORTED), manualOnly: MANUAL_ONLY_USAGE }); }
async function openXiaomiLogin(req, res) { if (req.params.providerId !== 'xiaomi-coding') return res.status(400).json({ success: false, error: '该 Provider 不支持浏览器登录' }); try { const { sendCommand, isExtensionConnected } = require('./ws-extension'); if (!isExtensionConnected()) return res.status(503).json({ success: false, error: 'OKIT 浏览器插件未连接，请先启动插件' }); const navigation = await sendCommand('navigate', { url: MIMO_CONSOLE_URL, workspace: 'okit' }, 30000); if (!navigation?.ok) return res.status(502).json({ success: false, error: navigation?.error || '无法打开 MiMo 控制台' }); await sendCommand('focus-window', { workspace: 'okit', hold: true }, 10000).catch(() => {}); return res.json({ success: true, tabId: navigation.data?.tabId, url: MIMO_CONSOLE_URL }); } catch (error) { return res.status(503).json({ success: false, error: error.message || String(error) }); } }
async function closeXiaomiLoginWindow(req, res) { if (req.params.providerId !== 'xiaomi-coding') return res.status(400).json({ success: false, error: '该 Provider 不支持此操作' }); try { const { sendCommand, isExtensionConnected } = require('./ws-extension'); if (!isExtensionConnected()) return res.status(503).json({ success: false, error: 'OKIT 浏览器插件未连接' }); const closed = await sendCommand('close-window', { workspace: 'okit' }, 10000); if (!closed?.ok) return res.status(502).json({ success: false, error: closed?.error || '无法关闭控制台窗口' }); return res.json({ success: true }); } catch (error) { return res.status(503).json({ success: false, error: error.message || String(error) }); } }
module.exports = { getUsage, getSupportedUsageProviders, queryUsage: registry.queryUsage, ...parsers, openXiaomiLogin, closeXiaomiLoginWindow };
