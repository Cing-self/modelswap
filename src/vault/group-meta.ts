// Vault group normalization shared by the Web API and the CLI.
//
// Remaps freeform group names to canonical "{平台} · {地域}" format.
// Matching is based on key name prefixes for 国内/国际 split. Living here
// (not in src/web/api) is what keeps CLI-created and Web-created groups
// from splitting into near-duplicate groups over casing/whitespace drift.

export function normalizeVaultGroup(group: string | undefined | null, key: string | undefined | null): string {
  const value = String(group || '').trim();
  const normalizedKey = String(key || '').toUpperCase();

  // Kimi Coding Plan was previously assigned to the international Kimi group
  // and then temporarily to Moonshot. It is a mainland Kimi product, so repair
  // those persisted values when the key identity makes the product unambiguous.
  if (normalizedKey.startsWith('KIMI_CODE_') && [
    'Kimi 国际',
    'Kimi · 国际',
    'Moonshot',
    'Kimi 国内',
    'Kimi · 国内',
    'Kimi',
  ].includes(value)) return 'Kimi';

  const aliases: Record<string, string> = {
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
  return aliases[value] || value;
}

export function resolveCanonicalGroup(key: string | undefined | null): string | null {
  const k = String(key || '').toUpperCase();

  // ── 国际大厂 ──
  if (k.startsWith('OPENAI_API_KEY') || k === 'OPENAI_API_KEY') return 'OpenAI';
  if (k.startsWith('ANTHROPIC')) return 'Anthropic';
  if (k.startsWith('XAI_')) return 'xAI';
  if (k.startsWith('MISTRAL_')) return 'Mistral';

  // ── 智谱/Z.AI (国内国际分站,key 不通用) ──
  if (k.startsWith('ZAI_API_KEY') || k.startsWith('ZAI_')) return '智谱AI · 国际';
  if (k.startsWith('ZHIPU_') || k.startsWith('MODELSWAP-ZHIPU') || k.startsWith('BIGMODEL_')) return '智谱AI · 国内';

  // ── MiniMax (国内国际分站) ──
  if (k.startsWith('MINIMAX_GLOBAL') || k.startsWith('MODELSWAP-MINIMAX-GLOBAL')) return 'MiniMax · 国际';
  if (k.startsWith('MINIMAX_') || k.startsWith('MODELSWAP-MINIMAX')) return 'MiniMax · 国内';

  // ── Kimi / Moonshot ──
  // Kimi is the mainland API platform; Moonshot is the international API
  // platform. Kimi Coding Plan belongs to the mainland Kimi product.
  if (k.startsWith('MOONSHOT_GLOBAL')) return 'Moonshot';
  if (k.startsWith('MOONSHOT_')) return 'Moonshot';
  if (k.startsWith('KIMI_CODE_')) return 'Kimi';
  if (k.startsWith('KIMI_')) return 'Kimi';

  // ── 仅国内 ──
  if (k.startsWith('DEEPSEEK_') || k === 'MODELSWAP-DEEPSEEK' || k.startsWith('DEEPSEEK')) return 'DeepSeek';
  if (k.startsWith('DASHSCOPE_')) return '阿里云百炼';
  if (k.startsWith('QIANFAN_') || k.startsWith('QIANFAN')) return '百度千帆';
  if (k.startsWith('VOLCENGINE_') || k === 'MODELSWAP-VOLCENGINE' || k.startsWith('VOLC_')) return '火山引擎';
  if (k.startsWith('TENCENT_') || k.startsWith('TECENT_') || k.startsWith('TENCENT')) return '腾讯云';
  if (k.startsWith('STEPFUN_')) return '阶跃星辰';
  if (k.startsWith('XIAOMI_MIMO') || k.startsWith('XIAOMI_')) return '小米 MiMo';

  // ── 聚合/代理 ──
  if (k.startsWith('OPENROUTER_')) return 'OpenRouter';
  if (k.startsWith('SILICONFLOW_')) return '硅基流动';
  if (k.startsWith('OPENCODE_')) return 'OpenCode Go';
  if (k.startsWith('LITELLM_')) return 'LiteLLM';

  // ── 基础设施 ──
  if (k.startsWith('CF_') || k.startsWith('CLOUDFLARE')) return 'Cloudflare';

  // ── 无法归类 ──
  return null;
}
