// Baidu Qianfan Coding Plan uses a separate credential and endpoint family
// from the regular V2 API. Keep the provider-specific detection and messages
// in one small CommonJS module so model discovery and connection tests agree.

const QIANFAN_CODING_MODELS = [
  'qianfan-code-latest',
  'glm-5.2',
  'glm-5.1',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'kimi-k2.6',
  'ernie-5.1',
  'deepseek-v4-flash-0731',
];

const QIANFAN_CODING_PROBE_MODEL = 'qianfan-code-latest';

function isQianfanCodingEndpoint(baseUrl) {
  return /^https?:\/\/qianfan\.baidubce\.com\/v2\/(?:coding|tokenplan\/personal)\/?$/i.test(String(baseUrl || '').trim());
}

function isQianfanCodingAnthropicEndpoint(baseUrl) {
  return /^https?:\/\/qianfan\.baidubce\.com\/anthropic\/(?:coding|tokenplan\/personal)\/?$/i.test(String(baseUrl || '').trim());
}

function qianfanCodingErrorCode(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    const directCode = parsed?.error?.code ?? parsed?.code;
    if (directCode !== undefined && directCode !== null) return String(directCode);

    // Anthropic-compatible gateways can wrap the provider response inside an
    // api_error message, for example: "Error code: 403 - {'error': {'code':
    // 'token_plan_person_model_not_supported', ...}}". Extract only the code;
    // never echo the full nested response back to the UI.
    const messages = [parsed?.error?.message, parsed?.message].filter(value => typeof value === 'string');
    for (const message of messages) {
      const match = message.match(/["']code["']\s*:\s*["']([^"']+)["']/i);
      if (match) return match[1];
    }
    return '';
  } catch {
    return '';
  }
}

function qianfanCodingErrorMessage(code) {
  const messages = {
    coding_plan_api_key_required: '当前密钥不是百度千帆 Coding Plan 专属 API Key，请在 Coding Plan 页面创建专属密钥后再测试。',
    coding_plan_api_key_not_allowed: '当前 Coding Plan 专属密钥不能调用普通千帆接口，请检查 Base URL 是否为 /v2/coding。',
    token_plan_person_api_key_required: '当前密钥不是百度千帆 Token Plan 专属 API Key，请在 Token Plan 页面点击“点击生成”后再测试。',
    token_plan_person_api_key_not_allowed: '当前 Token Plan 专属 API Key 不能调用普通千帆接口，请检查 Base URL 是否为 /v2/tokenplan/personal。',
    token_plan_person_not_subscribed: '当前百度账号尚未订阅 Token Plan，请先订阅后再测试。',
    token_plan_person_subscription_expired: '当前百度千帆 Token Plan 已过期，请续费后再测试。',
    coding_plan_not_subscribed: '当前百度账号尚未订阅 Coding Plan，请先订阅后再测试。',
    coding_plan_subscription_expired: '当前百度千帆 Coding Plan 已过期，请续费后再测试。',
    coding_plan_model_not_supported: '当前模型不支持百度千帆 Coding Plan，请使用 qianfan-code-latest 或文档列出的模型。',
    token_plan_person_model_not_supported: '当前模型不支持百度千帆 Token Plan，请使用 qianfan-code-latest 或控制台支持的模型。',
    coding_plan_hour_quota_exceeded: '百度千帆 Coding Plan 5 小时额度已用尽，请等待刷新或升级套餐。',
    coding_plan_week_quota_exceeded: '百度千帆 Coding Plan 周额度已用尽，请等待刷新或升级套餐。',
    coding_plan_month_quota_exceeded: '百度千帆 Coding Plan 月额度已用尽，请等待刷新或升级套餐。',
    coding_plan_rate_limit_exceeded: '百度千帆 Coding Plan 请求频率过高，请稍后重试。',
  };
  return messages[code] || '';
}

function qianfanCodingModels() {
  return QIANFAN_CODING_MODELS.map(id => ({ id, name: id }));
}

module.exports = {
  QIANFAN_CODING_MODELS,
  QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint,
  isQianfanCodingAnthropicEndpoint,
  qianfanCodingErrorCode,
  qianfanCodingErrorMessage,
  qianfanCodingModels,
};
