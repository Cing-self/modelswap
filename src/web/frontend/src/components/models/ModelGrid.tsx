import { Provider } from '../../api/providers';
import { filterModelEntries, PROVIDER_LABELS, runtimeAuthReady } from './modelsCatalog';
import type { AuthState } from './modelsCatalog';

function fmtTimeAgo(ts: number): string {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 0) return 'future';
  if (diff < 60 * 60 * 24 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 60 * 60 * 24 * 365) return `${Math.floor(diff / 2592000)}mo`;
  return `${Math.floor(diff / 31536000)}y`;
}

export function ModelGrid({ models, providers, authMap, activeModel: _activeModel, searchQuery: _sq, onSelect, t, activeProvider, hideLegacy, activeProtocol, activeModality }: {
  models: [string, any[]][];
  providers: Provider[];
  authMap: Record<string, AuthState>;
  activeModel: string | null;
  searchQuery: string;
  onSelect: (k: string) => void;
  t: (k: string, ...args: any[]) => string;
  activeProvider: string | null;
  hideLegacy: boolean;
  activeProtocol: string | null;
  activeModality: string | null;
}) {
  // 与厂商 chip 数量统计用同一套过滤条件，保证数量一致
  const filtered = filterModelEntries(models, { hideLegacy, activeProtocol, activeModality, searchQuery: _sq, providers, activeProvider });
  if (filtered.length === 0) {
    return <div className="empty-state"><p>{t('models.noMatch')}</p></div>;
  }
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };

  // 按厂商分组
  const grouped: Record<string, [string, any[]][]> = {};
  for (const [key, entries] of filtered) {
    const pp = entries[0]?.primary_provider || 'unknown';
    if (!grouped[pp]) grouped[pp] = [];
    grouped[pp].push([key, entries]);
  }

  // 每组内按 created 倒序
  for (const pp of Object.keys(grouped)) {
    grouped[pp].sort((a, b) => (b[1][0]?.created || 0) - (a[1][0]?.created || 0));
  }

  // 厂商排序（按模型数量）
  const sortedGroups = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="model-compare-list">
      {sortedGroups.map(([pp, items]) => (
        <section key={pp} className="model-compare-group">
          <div className="model-compare-group-head">
            <h3>{PROVIDER_LABELS[pp] || pp}</h3>
            <span>{items.length}</span>
          </div>
          <div className="model-compare-columns" aria-hidden="true">
            <span>{t('models.modelId')}</span>
            <span>{t('models.modality')}</span>
            <span>{t('models.contextLabel')}</span>
            <span>{t('models.platforms')}</span>
            <span>{t('models.price')}</span>
            <span>{t('models.authReady')}</span>
            <span />
          </div>
          <div className="model-compare-rows">
            {items.map(([key, entries]) => {
              const platforms = [...new Set(entries.map((e: any) => e.platform))];
              const ctxEntry = entries.find((e: any) => e.context);
              const ctx = ctxEntry?.context;
              const minIn = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.prompt)).filter(n => n > 0), Infinity);
              const minOut = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.completion)).filter(n => n > 0), Infinity);
              const authedCount = platforms.filter((pid: any) => {
                const provider = providers.find(p => p.id === pid);
                return runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
              }).length;
              const created = entries[0]?.created || 0;
              const isLegacy = entries.some((e: any) => e.legacy);
              const mod = entries[0]?.modality || 'text';
              const MOD_LABEL: Record<string, string> = {
                text: t('models.modText'), image: t('models.modImage'), video: t('models.modVideo'),
                audio: t('models.modAudio'), '3d': t('models.mod3d'), omni: t('models.modOmni'),
              };
              return (
                <article
                  key={key}
                  className={`model-compare-row${isLegacy ? ' model-compare-row--legacy' : ''}`}
                  onClick={() => onSelect(key)}
                >
                  <div className="model-compare-name">
                    <strong>{key}</strong>
                    {created > 0 && (
                      <span className="model-compare-age">
                        {fmtTimeAgo(created)}
                      </span>
                    )}
                  </div>
                  <span className="model-compare-modality">{MOD_LABEL[mod] || mod}</span>
                  <span className="model-compare-context">{ctx ? `${Math.round(ctx / 1024)}K` : '—'}</span>
                  <span className="model-compare-platform-count">{platforms.length}</span>
                  <span className="model-compare-price">
                    {isFinite(minIn) ? `$${minIn.toFixed(2)} in` : '—'}
                    {isFinite(minOut) && <small>${minOut.toFixed(2)} out</small>}
                  </span>
                  <span className={`model-compare-auth model-compare-auth--${authedCount === platforms.length ? 'all' : authedCount > 0 ? 'part' : 'none'}`}>
                    <i />{authedCount}/{platforms.length}
                  </span>
                  <span className="model-compare-open">›</span>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
