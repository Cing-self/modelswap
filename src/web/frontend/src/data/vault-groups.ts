// Predefined vault key groups, ordered by importance for AI model providers.
// Used by the vault "add key" form's group selector and by the group migration.
//
// Naming convention: "{平台名}" or "{平台名} · {地域}".
// 国内/国际 key 不通用的平台才加地域后缀;只有一个地域的不加。
// Kimi 表示国内 API 平台，Moonshot 表示国际 API 平台。Kimi Coding Plan
// 仅属于国内 Kimi，因此和国内 API Key 一起归入 Kimi 分组。

export const PREDEFINED_GROUPS: string[] = [
  // ── 国际大厂 ──
  'OpenAI',
  'Anthropic',
  'xAI',
  'Mistral',
  // ── 国内/国际分站 ──
  '智谱AI · 国内',
  '智谱AI · 国际',
  'MiniMax · 国内',
  'MiniMax · 国际',
  'Kimi',
  'Moonshot',
  // ── 仅国内 ──
  'DeepSeek',
  '阿里云百炼',
  '百度千帆',
  '火山引擎',
  '腾讯云',
  'OpenCode Go',
  '阶跃星辰',
  '小米 MiMo',
  // ── 聚合/代理 ──
  'OpenRouter',
  '硅基流动',
  'LiteLLM',
  // ── 基础设施 ──
  'Cloudflare',
];

const LEGACY_GROUP_ALIASES: Record<string, string> = {
  '智谱AI': '智谱AI · 国内',
  '智谱 AI': '智谱AI · 国内',
  '智谱AI（国内）': '智谱AI · 国内',
  '智谱 AI（国内站）': '智谱AI · 国内',
  'Z.AI': '智谱AI · 国际',
  'Z.AI（国际）': '智谱AI · 国际',
  'Z.AI（国际站）': '智谱AI · 国际',
  'Kimi 国际': 'Moonshot',
  'Kimi · 国际': 'Moonshot',
  'Kimi 国内': 'Kimi',
  'Kimi · 国内': 'Kimi',
  '小米 MiMo Token Plan': '小米 MiMo',
  'StepFun': '阶跃星辰',
  'litellm': 'LiteLLM',
  'LiteLLM (本地)': 'LiteLLM',
  'LiteLLM（本地）': 'LiteLLM',
};

/** Keep old persisted labels out of every user-visible group selector. */
export function normalizeGroupName(group: string | undefined | null): string {
  const value = String(group || '').trim();
  return LEGACY_GROUP_ALIASES[value] || value;
}
