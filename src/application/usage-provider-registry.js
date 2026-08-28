function createUsageProviderRegistry({ api, browser, cloud }) {
  const consoleOnly = cloud.queryConsoleOnlyUsage;
  async function queryUsage(providerId) {
    if (providerId === 'openai-codex') return api.queryCodexUsage();
    const providers = await api.loadProviders();
    const provider = providers.find(item => item.id === providerId);
    if (!provider) return { supported: false, error: 'Provider 不存在' };
    if (providerId === 'anthropic') return consoleOnly('Anthropic', 'https://console.anthropic.com/settings/billing');
    if (providerId === 'anthropic-agent') return api.queryClaudeUsage(provider);
    if (providerId === 'github-copilot') return { supported: true, windows: [], source: 'console', refreshPolicy: 'never', notice: 'GitHub Copilot 订阅用量请在 GitHub Billing and licensing 或 Copilot 客户端的配额页面查看。当前没有可复用的个人订阅用量接口。' };
    if (providerId === 'xai-grok-build') return consoleOnly('SuperGrok', 'https://grok.com/', 'SuperGrok 是订阅产品，与 xAI API 余额分开；目前没有公开稳定的个人订阅用量接口。');
    if (providerId === 'volcengine-coding' || providerId === 'volcengine-agent') return cloud.queryVolcengineUsage(providerId === 'volcengine-agent' ? 'agent' : 'coding');
    if (providerId === 'volcengine') return cloud.queryVolcengineBalance();
    const apiKey = provider.vaultKey ? await api.resolveVaultKey(provider.vaultKey) : undefined;
    const handlers = {
      openai: () => consoleOnly('OpenAI API', 'https://platform.openai.com/usage', 'OpenAI API 的用量/费用需要组织 Admin Key；普通 API Key 不提供剩余额度接口。'),
      zai: () => consoleOnly('智谱 AI', 'https://open.bigmodel.cn/finance/overview'), 'zai-global': () => consoleOnly('Z.AI', 'https://z.ai/manage-apikey/billing'),
      minimax: () => consoleOnly('MiniMax', 'https://platform.minimaxi.com/user-center/payment'), 'minimax-global': () => consoleOnly('MiniMax 国际站', 'https://platform.minimax.io/user-center/payment'),
      'kimi-coding': () => api.queryKimiApiBalance(apiKey, provider.baseUrl), qianfan: () => api.queryQianfanBalance(), tencent: () => consoleOnly('腾讯云', 'https://console.cloud.tencent.com/expense/overview', '腾讯云余额查询需要云账号账务凭证；当前不会使用推理 API Key 猜测余额。'), xai: () => api.queryXaiApiBalance(),
      stepfun: () => consoleOnly('阶跃星辰', 'https://platform.stepfun.com/console/billing'), 'stepfun-global': () => consoleOnly('StepFun Global', 'https://platform.stepfun.ai/console/billing'), xiaomi: () => browser.queryXiaomiBalance(),
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
