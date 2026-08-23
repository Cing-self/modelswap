import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
// Same dataset the Models page already bundles — importing the module costs
// no extra bytes (shared chunk). This page is STANDALONE: it renders outside
// the app shell (own route, own design, no sidebar / Paper Cutout styles).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import crossDataRaw from '../../data/cross_platform_models.json';

interface CatalogEntry {
  platform: string;
  model_id: string;
  norm?: string;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  context?: number | null;
  architecture?: { input_modalities?: string[]; modality?: string };
  top_provider?: { max_completion_tokens?: number | null };
  is_flagship?: boolean;
  deprecated?: boolean;
  supportsToolCall?: boolean;
  supportsWebSearch?: boolean;
  currency?: string;
  sources?: string[];
  pricingTiers?: Array<{ label: string; input?: number; output?: number; cacheRead?: number }>;
  pricingTierKind?: string;
}

interface Tier { label: string; input?: number; output?: number; cacheRead?: number }

interface Row {
  key: string;
  norm: string;
  platform: string;
  modelId: string;
  promptPerM?: number;
  completionPerM?: number;
  cacheReadPerM?: number;
  currency?: string;
  context?: number;
  maxOut?: number;
  images: boolean;
  video: boolean;
  flagship: boolean;
  toolCall?: boolean;
  webSearch?: boolean;
  sources?: string[];
  tiers?: Tier[];
  tierKind?: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter', dashscope: '阿里云百炼', qwen: 'Qwen', siliconflow: '硅基流动',
  volcengine: '火山引擎', tencent: '腾讯云', zai: '智谱', 'zai-global': '智谱国际',
  moonshot: 'Kimi（国内）', moonshotai: 'Kimi（国际）',
  minimax: 'MiniMax', 'minimax-global': 'MiniMax 国际', deepseek: 'DeepSeek', openai: 'OpenAI',
  google: 'Google', anthropic: 'Anthropic', xai: 'xAI', stepfun: '阶跃星辰', meituan: '美团 LongCat',
  xiaomi: '小米', qianfan: '百度千帆', groq: 'Groq', together: 'Together',
};

// Deterministic hue per platform for badge tints.
function platformHue(platform: string): number {
  let h = 0;
  for (const c of platform) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const PLATFORM_WEB_SEARCH: Array<{ platform: string; note: string; source: string }> = [
  { platform: 'openai', note: 'Responses API web_search tool', source: 'https://developers.openai.com' },
  { platform: 'anthropic', note: 'web_search server tool', source: 'https://platform.claude.com' },
  { platform: 'google', note: 'google_search grounding', source: 'https://ai.google.dev' },
  { platform: 'xai', note: 'Web/X Search', source: 'https://docs.x.ai' },
  { platform: 'openrouter', note: ':online / web plugin', source: 'https://openrouter.ai/docs/features/web-search' },
  { platform: 'groq', note: 'built-in web search tool', source: 'https://console.groq.com/docs/tool-use/built-in-tools/web-search' },
  { platform: 'zai', note: 'web_search 工具', source: 'https://docs.z.ai/guides/tools/web-search' },
  { platform: 'zai-global', note: 'web-search tool', source: 'https://docs.z.ai/guides/tools/web-search' },
  { platform: 'moonshotai', note: '$web_search 工具', source: 'https://platform.kimi.ai' },
  { platform: 'moonshot', note: '$web_search 工具 ¥0.03/次', source: 'https://platform.kimi.com' },
  { platform: 'minimax', note: 'web_search 服务端工具 ¥0.03/次', source: 'https://platform.minimaxi.com' },
  { platform: 'minimax-global', note: 'web_search server tool $0.01/次', source: 'https://platform.minimax.io' },
  { platform: 'dashscope', note: 'enable_search / web_search 工具', source: 'https://help.aliyun.com/zh/model-studio/web-search' },
  { platform: 'qwen', note: 'enable_search / web_search 工具', source: 'https://help.aliyun.com/zh/model-studio/web-search' },
  { platform: 'volcengine', note: '联网内容插件 / web_search', source: 'https://docs.volcengine.com' },
  { platform: 'tencent', note: 'TokenHub 联网搜索', source: 'https://cloud.tencent.com' },
  { platform: 'qianfan', note: '联网搜索计费项', source: 'https://cloud.baidu.com' },
  { platform: 'xiaomi', note: 'Web Search 插件', source: 'https://mimo.mi.com' },
  { platform: 'stepfun', note: '互联网搜索增值', source: 'https://platform.stepfun.com' },
];

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' };

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform;
}

function perMillion(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * 1_000_000;
}

// Anthropic-style unit suffix: MTok = per million tokens.
function fmtPrice(n?: number, currency?: string): string {
  const base = fmtPriceRaw(n, currency);
  return base === '—' ? base : `${base}/MTok`;
}

function fmtPriceRaw(n?: number, currency?: string): string {
  if (n === undefined) return '—';
  let body: string;
  if (n >= 100) body = n.toFixed(0);
  else if (n >= 10) body = n.toFixed(1);
  else if (n >= 1) body = n.toFixed(2);
  else body = n.toPrecision(2).replace(/\.?0+$/, '');
  const symbol = currency ? CURRENCY_SYMBOLS[currency] || '' : '';
  return symbol ? `${symbol}${body}` : body;
}

function fmtTokens(n?: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function sourceDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

type SortKey = 'norm' | 'promptPerM' | 'completionPerM' | 'context' | 'maxOut';

function tierRange(tiers: Tier[]): { min?: number; max?: number } {
  const vals = tiers.map(tr => tr.input).filter((v): v is number => v !== undefined);
  if (!vals.length) return {};
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

export default function ModelCatalogPage() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [imagesOnly, setImagesOnly] = useState(false);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [webSearchOnly, setWebSearchOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('norm');
  const [sortAsc, setSortAsc] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo<Row[]>(() => {
    const flattened: Row[] = [];
    for (const [norm, entries] of Object.entries(crossDataRaw as unknown as Record<string, CatalogEntry[]>)) {
      for (const e of entries) {
        if (e.deprecated) continue; // officially delisted — hidden
        flattened.push({
          key: `${e.platform}:${e.model_id}`,
          norm,
          platform: e.platform,
          modelId: e.model_id,
          promptPerM: perMillion(e.pricing?.prompt),
          completionPerM: perMillion(e.pricing?.completion),
          cacheReadPerM: perMillion(e.pricing?.input_cache_read),
          currency: e.currency,
          context: e.context ?? undefined,
          maxOut: e.top_provider?.max_completion_tokens ?? undefined,
          images: (e.architecture?.input_modalities || []).includes('image'),
          video: (e.architecture?.input_modalities || []).includes('video'),
          flagship: Boolean(e.is_flagship),
          toolCall: e.supportsToolCall,
          webSearch: e.supportsWebSearch,
          sources: e.sources?.length ? e.sources : undefined,
          tiers: e.pricingTiers?.length ? e.pricingTiers : undefined,
          tierKind: e.pricingTierKind,
        });
      }
    }
    flattened.sort((a, b) => a.norm.localeCompare(b.norm, 'zh-Hans-CN') || a.platform.localeCompare(b.platform));
    return flattened;
  }, []);

  const platforms = useMemo(
    () => [...new Set(rows.map(r => r.platform))]
      .sort((a, b) => platformLabel(a).localeCompare(platformLabel(b), 'zh-Hans-CN')),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter(r =>
      (!q || r.norm.toLowerCase().includes(q) || r.modelId.toLowerCase().includes(q) || platformLabel(r.platform).toLowerCase().includes(q))
      && (!platformFilter || r.platform === platformFilter)
      && (!imagesOnly || r.images)
      && (!toolsOnly || r.toolCall === true)
      && (!webSearchOnly || r.webSearch === true),
    );
    const dir = sortAsc ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir;
      }
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return (av - bv) * dir;
    });
  }, [rows, query, platformFilter, imagesOnly, toolsOnly, webSearchOnly, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(prev => !prev);
    else { setSortKey(key); setSortAsc(key === 'norm'); }
  }

  function toggleExpanded(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function sortHeader(key: SortKey, label: string) {
    const sorted = sortKey === key;
    return (
      <th className={sorted ? 'sorted' : ''} onClick={() => toggleSort(key)}>
        {label}{sorted && <span className="sort-arrow">{sortAsc ? '▲' : '▼'}</span>}
      </th>
    );
  }

  function boolCell(value: boolean | undefined) {
    if (value === true) return <span className="flag flag--yes">✓</span>;
    if (value === false) return <span className="flag flag--no">✕</span>;
    return <span className="flag flag--na">—</span>;
  }

  // Tiered input price rendered directly in the cell: time-based models show
  // peak/off-peak stacked; length tiers show the min–max range. Clicking the
  // row expands the full per-tier breakdown below it.
  function inputPriceCell(r: Row) {
    if (!r.tiers) return <span className="num">{fmtPrice(r.promptPerM, r.currency)}</span>;
    if (r.tierKind === 'time') {
      return (
        <span className="tier-stack">
          {r.tiers.map(tier => (
            <span key={tier.label} className="tier-line">
              <span className="tier-tag">{/^(峰|忙)/.test(tier.label) ? t('catalog.peak') : t('catalog.offpeak')}</span>
              <span className="num">{fmtPrice(tier.input, r.currency)}</span>
            </span>
          ))}
        </span>
      );
    }
    const { min, max } = tierRange(r.tiers);
    return (
      <button type="button" className="tier-range" onClick={() => toggleExpanded(r.key)}>
        <span className="num">{min === max ? fmtPrice(min, r.currency) : `${fmtPriceRaw(min, r.currency)}–${fmtPriceRaw(max, r.currency)}/MTok`}</span>
        <span className="tier-count">{r.tiers.length}{t('catalog.tierUnit')}<span className={`chevron${expanded.has(r.key) ? ' open' : ''}`}>▾</span></span>
      </button>
    );
  }

  return (
    <div className="sc-page">
      <header className="sc-header">
        <div className="sc-header-main">
          <h1>{t('catalog.title')}</h1>
          <p className="sc-sub">{t('catalog.subtitle')}</p>
        </div>
        <div className="sc-stats">
          <div className="sc-stat"><strong>{new Set(rows.map(r => r.norm)).size}</strong><span>{t('catalog.models')}</span></div>
          <div className="sc-stat"><strong>{rows.length}</strong><span>{t('catalog.entries')}</span></div>
          <div className="sc-stat sc-stat--active"><strong>{filtered.length}</strong><span>{t('catalog.shown')}</span></div>
        </div>
      </header>

      <div className="sc-toolbar">
        <input className="sc-search" placeholder={t('catalog.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} />
        <select className="sc-select" value={platformFilter} onChange={e => setPlatformFilter(e.target.value)}>
          <option value="">{t('catalog.allPlatforms')}</option>
          {platforms.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}
        </select>
        <label className="sc-check"><input type="checkbox" checked={toolsOnly} onChange={e => setToolsOnly(e.target.checked)} />{t('catalog.toolsOnly')}</label>
        <label className="sc-check"><input type="checkbox" checked={webSearchOnly} onChange={e => setWebSearchOnly(e.target.checked)} />{t('catalog.webSearchOnly')}</label>
        <label className="sc-check"><input type="checkbox" checked={imagesOnly} onChange={e => setImagesOnly(e.target.checked)} />{t('catalog.imagesOnly')}</label>
      </div>

      <div className="sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              {sortHeader('norm', t('catalog.colModel'))}
              <th>{t('catalog.colPlatform')}</th>
              {sortHeader('promptPerM', t('catalog.colInputPrice'))}
              {sortHeader('completionPerM', t('catalog.colOutputPrice'))}
              <th>{t('catalog.colCacheRead')}</th>
              {sortHeader('context', t('catalog.colContext'))}
              {sortHeader('maxOut', t('catalog.colMaxOutput'))}
              <th>{t('catalog.colTools')}</th>
              <th>{t('catalog.colWebSearch')}</th>
              <th>{t('catalog.colModality')}</th>
              <th>{t('catalog.colSource')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.flatMap(r => {
              const isOpen = expanded.has(r.key);
              return [
                <tr
                  key={r.key}
                  className={`sc-row${r.tiers ? ' sc-row--tiered' : ''}${isOpen ? ' sc-row--open' : ''}`}
                  onClick={() => r.tiers && toggleExpanded(r.key)}
                >
                  <td>
                    <div className="sc-model">
                      <span className="sc-model-name">{r.norm}</span>
                      {r.flagship && <span className="sc-badge sc-badge--flagship">{t('catalog.flagship')}</span>}
                      {r.tiers?.length ? <span className={`chevron sc-row-chevron${isOpen ? ' open' : ''}`}>▾</span> : null}
                    </div>
                    <div className="sc-model-id">{r.modelId}</div>
                  </td>
                  <td>
                    <span
                      className="sc-plat"
                      style={{
                        background: `hsl(${platformHue(r.platform)} 70% 94%)`,
                        color: `hsl(${platformHue(r.platform)} 55% 30%)`,
                        borderColor: `hsl(${platformHue(r.platform)} 50% 82%)`,
                      }}
                    >
                      {platformLabel(r.platform)}
                    </span>
                  </td>
                  <td>{inputPriceCell(r)}</td>
                  <td><span className="num">{fmtPrice(r.completionPerM, r.currency)}</span></td>
                  <td><span className="num sc-dim">{fmtPrice(r.cacheReadPerM, r.currency)}</span></td>
                  <td><span className="num">{fmtTokens(r.context)}</span></td>
                  <td><span className="num">{fmtTokens(r.maxOut)}</span></td>
                  <td>{boolCell(r.toolCall)}</td>
                  <td>{boolCell(r.webSearch)}</td>
                  <td>
                    {r.images && <span className="sc-badge sc-badge--img">{t('catalog.image')}</span>}
                    {r.video && <span className="sc-badge">{t('catalog.video')}</span>}
                    {!r.images && !r.video && <span className="sc-dim">{t('catalog.textOnly')}</span>}
                  </td>
                  <td>
                    {r.sources?.length ? (
                      <a className="sc-src" href={r.sources[0]} target="_blank" rel="noreferrer" title={r.sources.join('\n')}>
                        {sourceDomain(r.sources[0])}{r.sources.length > 1 && <span className="sc-dim"> +{r.sources.length - 1}</span>}
                      </a>
                    ) : <span className="sc-dim">—</span>}
                  </td>
                </tr>,
                isOpen && r.tiers && (
                  <tr key={`${r.key}:tiers`} className="sc-tier-row">
                    <td colSpan={11}>
                      <div className="sc-tier-panel">
                        <div className="sc-tier-title">{r.tierKind === 'time' ? t('catalog.tierTimeTitle') : t('catalog.tierLengthTitle')} · {r.norm} · {platformLabel(r.platform)}</div>
                        <table className="sc-tier-table">
                          <thead>
                            <tr>
                              <th>{t('catalog.tierColLabel')}</th>
                              <th>{t('catalog.colInputPrice')}</th>
                              <th>{t('catalog.colOutputPrice')}</th>
                              <th>{t('catalog.colCacheRead')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.tiers.map(tier => (
                              <tr key={tier.label}>
                                <td>{tier.label}</td>
                                <td><span className="num">{fmtPrice(tier.input, r.currency)}</span></td>
                                <td><span className="num">{fmtPrice(tier.output, r.currency)}</span></td>
                                <td><span className="num sc-dim">{fmtPrice(tier.cacheRead, r.currency)}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      <div className="sc-platweb">
        <span className="sc-platweb-label">{t('catalog.platformWebSearch')}</span>
        {PLATFORM_WEB_SEARCH.map(p => (
          <a key={p.platform} href={p.source} target="_blank" rel="noreferrer" title={`${p.note} · ${p.source}`}>
            {platformLabel(p.platform)}
          </a>
        ))}
      </div>

      <footer className="sc-foot">
        <ul className="sc-foot-list">
          {(['catalog.foot1', 'catalog.foot2', 'catalog.foot3', 'catalog.foot4', 'catalog.foot5', 'catalog.foot6'] as const).map(k => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
