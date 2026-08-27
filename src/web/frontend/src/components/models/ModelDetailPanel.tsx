import { Provider } from '../../api/providers';
import { runtimeAuthReady } from './modelsCatalog';
import type { AuthState } from './modelsCatalog';
function StatChip({ label, value, tone }: { label: string; value: number | string; tone?: 'muted' | 'success' | 'warn' }) {
  return (
    <div className={`stat-chip stat-chip--${tone || 'default'}`}>
      <span className="stat-chip-value">{value}</span>
      <span className="stat-chip-label">{label}</span>
    </div>
  );
}

export function ModelDetailPanel({ modelKey, entries, providers, authMap, t, onBack }: { modelKey: string; entries: any[]; providers: Provider[]; authMap: Record<string, AuthState>; t: (k: string, ...args: any[]) => string; onBack: () => void }) {
  const platforms = [...new Set(entries.map((e: any) => e.platform))];
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };
  const allPrices = entries.flatMap(e => [fmtPrice(e.pricing?.prompt), fmtPrice(e.pricing?.completion)]);
  const maxPrice = Math.max(...allPrices, 0.01);

  // 模型基本信息聚合（取有数据的第一个）
  const sample = entries.find((e: any) => e.context || e.architecture) || entries[0];
  const arch = sample?.architecture || {};
  const inputModes: string[] = arch.input_modalities || arch.inputModes || [];
  const outputModes: string[] = arch.output_modalities || arch.outputModes || [];
  const ctx = sample?.context || sample?.context_length;
  const sampleEntry = entries.find((e: any) => e.context) || entries[0];
  const allPlatformsWithCtx = entries.filter((e: any) => e.context).map((e: any) => e.context);
  const minInputPrice = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.prompt)).filter(n => n > 0), Infinity);
  const minOutputPrice = Math.min(...entries.map((e: any) => fmtPrice(e.pricing?.completion)).filter(n => n > 0), Infinity);

  return (
    <div className="model-cross-view">
      <div className="model-detail-header">
        <button className="model-detail-back" onClick={onBack}>← {t('models.back')}</button>
        <div className="model-detail-title">
          <h3>{modelKey}</h3>
          <p>{t('models.modelAvailableIn', { n: platforms.length })}</p>
        </div>
      </div>

      {/* 模型基本信息 */}
      <div className="model-info-grid">
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoContext')}</div>
          <div className="model-info-value">
            {ctx ? `${Math.round(ctx / 1024)}K` : '—'}
            {allPlatformsWithCtx.length > 1 && (
              <span className="model-info-hint"> · {t('models.infoContextHint', { n: allPlatformsWithCtx.length })}</span>
            )}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoInputModes')}</div>
          <div className="model-info-value">
            {inputModes.length ? inputModes.map((m: string) => (
              <span key={m} className="model-info-mode">{m}</span>
            )) : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoOutputModes')}</div>
          <div className="model-info-value">
            {outputModes.length ? outputModes.map((m: string) => (
              <span key={m} className="model-info-mode">{m}</span>
            )) : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoMinPrice')}</div>
          <div className="model-info-value">
            {isFinite(minInputPrice) ? <span className="model-info-price">${minInputPrice.toFixed(2)}<span className="model-info-unit">/M in</span></span> : '—'}
            {isFinite(minOutputPrice) && <span className="model-info-price"> · ${minOutputPrice.toFixed(2)}<span className="model-info-unit">/M out</span></span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoAuthed')}</div>
          <div className="model-info-value">
            {(() => {
              const authedCount = platforms.filter((pid: any) => {
                const provider = providers.find(p => p.id === pid);
                return runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
              }).length;
              return <span className={authedCount === platforms.length ? 'model-info-ok' : authedCount > 0 ? 'model-info-warn' : 'model-info-muted'}>{authedCount}/{platforms.length}</span>;
            })()}
          </div>
        </div>
      </div>

      {/* 跨平台对照表 */}
      <div className="model-cross-table-wrap">
        <table className="model-cross-table">
          <thead>
            <tr>
              <th>{t('models.platform')}</th>
              <th>{t('models.modelId')}</th>
              <th>{t('models.contextLabel')}</th>
              <th>{t('models.inputPrice')}</th>
              <th>{t('models.outputPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e: any, i: number) => {
              const pr = providers.find(p => p.id === e.platform);
              const ec = e.context ? `${Math.round(e.context / 1024)}K` : '?';
              const pi = fmtPrice(e.pricing?.prompt);
              const po = fmtPrice(e.pricing?.completion);
              const hasInputPrice = Object.prototype.hasOwnProperty.call(e.pricing || {}, 'prompt');
              const hasOutputPrice = Object.prototype.hasOwnProperty.call(e.pricing || {}, 'completion');
              const piPct = maxPrice > 0 ? (pi / maxPrice) * 100 : 0;
              const poPct = maxPrice > 0 ? (po / maxPrice) * 100 : 0;
              return (
                <tr key={i} className={runtimeAuthReady(pr, pr ? authMap[pr.id] : undefined) ? 'model-cross-row--authed' : ''}>
                  <td className="model-cross-platform">
                    {pr ? (
                      <span className="platform-chip">
                        <span className={`type-badge type-badge--${pr.type}`}>{pr.type}</span>
                        {pr.name}
                      </span>
                    ) : e.platform}
                  </td>
                  <td className="model-cross-id"><code>{e.model_id}</code></td>
                  <td className="model-cross-ctx">{ec}</td>
                  <td className="model-cross-price">
                    <span className="price-bar-wrap">
                      <span className="price-bar" style={{ width: `${Math.max(piPct, 3)}%` }} />
                      <span className="price-bar-label">{!hasInputPrice ? '—' : pi > 0 ? `$${pi.toFixed(2)}/M` : t('common.free')}</span>
                    </span>
                  </td>
                  <td className="model-cross-price">
                    <span className="price-bar-wrap">
                      <span className="price-bar price-bar--output" style={{ width: `${Math.max(poPct, 3)}%` }} />
                      <span className="price-bar-label">{!hasOutputPrice ? '—' : po > 0 ? `$${po.toFixed(2)}/M` : t('common.free')}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ 平台详情视图：完整模型列表 + 可展开模型参数 ============ */
