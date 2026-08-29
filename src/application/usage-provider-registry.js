const { consoleUsageHandoff } = require('./usage-handoff-copy');

function createUsageProviderRegistry({ api, browser, cloud }) {
  const consoleOnly = cloud.queryConsoleOnlyUsage;
  async function queryUsage(providerId) {
    if (providerId === 'openai-codex') return api.queryCodexUsage();
    const providers = await api.loadProviders();
    const provider = providers.find(item => item.id === providerId);
    if (!provider) return { supported: false, error: 'Provider 不存在' };
    if (providerId === 'anthropic') return consoleOnly('anthropicConsole', 'https://console.anthropic.com/settings/billing');
    if (providerId === 'anthropic-agent') return api.queryClaudeUsage(provider);
    if (providerId === 'github-copilot') return { supported: true, windows: [], ...consoleUsageHandoff('githubCopilotBilling', 'https://github.com/settings/billing') };
    if (providerId === 'xai-grok-build') return consoleOnly('superGrokConsole', 'https://grok.com/');
    if (providerId === 'volcengine-coding' || providerId === 'volcengine-agent') return cloud.queryVolcengineUsage(providerId === 'volcengine-agent' ? 'agent' : 'coding');
    if (providerId === 'volcengine') return cloud.queryVolcengineBalance();
    const apiKey = provider.vaultKey ? await api.resolveVaultKey(provider.vaultKey) : undefined;
    const handlers = {
      openai: () => consoleOnly('openaiConsole', 'https://platform.openai.com/usage'),
      zai: () => consoleOnly('zaiConsole', 'https://open.bigmodel.cn/finance/overview'), 'zai-global': () => consoleOnly('zaiGlobalConsole', 'https://z.ai/manage-apikey/billing'),
      minimax: () => consoleOnly('minimaxConsole', 'https://platform.minimaxi.com/user-center/payment'), 'minimax-global': () => consoleOnly('minimaxGlobalConsole', 'https://platform.minimax.io/user-center/payment'),
      'kimi-coding': () => api.queryKimiApiBalance(apiKey, provider.baseUrl), qianfan: () => api.queryQianfanBalance(), tencent: () => consoleOnly('tencentConsole', 'https://console.cloud.tencent.com/expense/overview'), xai: () => api.queryXaiApiBalance(),
      stepfun: () => consoleOnly('stepfunConsole', 'https://platform.stepfun.com/console/billing'), 'stepfun-global': () => consoleOnly('stepfunGlobalConsole', 'https://platform.stepfun.ai/console/billing'), xiaomi: () => browser.queryXiaomiBalance(),
      'glm-coding': () => api.queryGlmCodingUsage(apiKey), 'zai-global-coding': () => api.queryZaiGlobalCodingUsage(apiKey), 'kimi-coding-plan': () => api.queryKimiCodingUsage(apiKey),
      'minimax-coding': () => api.queryMinimaxCodingUsage(apiKey), 'minimax-global-coding': () => api.queryMinimaxGlobalCodingUsage(apiKey), 'qwen-coding': () => api.queryQwenCodingUsage(apiKey), 'qwen-token-plan': () => api.queryQwenTokenPlanUsage(apiKey),
      'qianfan-coding': () => browser.queryQianfanCodingUsage(apiKey), 'tencent-token-plan': () => browser.queryTencentTokenPlanUsage(apiKey), 'opencode-go': () => browser.queryOpenCodeGoUsage(apiKey),
      'xiaomi-coding': () => browser.queryXiaomiCodingUsage(apiKey, provider.baseUrl), openrouter: () => api.queryOpenRouterUsage(), deepseek: () => api.queryDeepseekUsage(apiKey), siliconflow: () => api.querySiliconflowUsage(apiKey), moonshot: () => api.queryMoonshotUsage(apiKey, provider.baseUrl), mistral: () => api.queryMistralUsage(apiKey), qwen: () => api.queryQwenUsage(apiKey),
    };
    return handlers[providerId] ? handlers[providerId]() : { supported: false };
  }
  return { queryUsage };
}
module.exports = { createUsageProviderRegistry };
