import { useMemo, useState } from 'react';
import { Platform, Provider } from '../../api/providers';
import { useI18n } from '../../i18n';
import { normalizeEndpoint, runtimeAuthReady } from './modelsCatalog';
import type { AuthState } from './modelsCatalog';
function fmtTimeAgo(ts: number): string { if (!ts) return ''; const diff = Date.now() / 1000 - ts; if (diff < 0) return 'future'; if (diff < 3600) return `${Math.floor(diff / 60)}m`; if (diff < 86400) return `${Math.floor(diff / 3600)}h`; return `${Math.floor(diff / 86400)}d`; }
export function PlatformDetailPanel({ platform, providers, authMap, crossData, onBack }: {
  platform: Platform;
  providers: Provider[];
  authMap: Record<string, AuthState>;
  crossData: Record<string, any[]>;
  onBack: () => void;
}) {
  const { t, providerName } = useI18n();
  const [activeOfferingId, setActiveOfferingId] = useState(platform.offerings[0]?.providerId || platform.providerIds[0]);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const offering = platform.offerings.find(item => item.providerId === activeOfferingId) || platform.offerings[0];
  const provider = providers.find(item => item.id === offering?.providerId)
    || providers.find(item => platform.providerIds.includes(item.id))!;
  const authed = runtimeAuthReady(provider, provider ? authMap[provider.id] : undefined);
  const fmtPrice = (raw: string | undefined): number => {
    if (!raw || raw === '0') return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n * 1e6;
  };
  const MOD_LABEL: Record<string, string> = {
    text: t('models.modText'), image: t('models.modImage'), video: t('models.modVideo'),
    audio: t('models.modAudio'), '3d': t('models.mod3d'), omni: t('models.modOmni'),
  };

  // 为每个实际配置的模型匹配参数清单（大小写/前缀归一化后查找）
  const rows = useMemo(() => {
    const lowerMap: Record<string, string> = {};
    for (const k of Object.keys(crossData)) lowerMap[k.toLowerCase()] = k;
    return (provider.models || [])
      .filter(m => m.id && m.id.trim())
      .map(m => {
        const id = m.id.trim();
        const norm = id.split('/').pop()?.toLowerCase() || '';
        const key = crossData[id] ? id : (lowerMap[norm] || lowerMap[id.toLowerCase()] || '');
        const entries = key ? (crossData[key] || []) : [];
        const entry = entries.find((e: any) => e.platform === provider.id);
        const platformAvailability = platform.models
          .find(platformModel => platformModel.id === id)
          ?.availability.filter(item => item.offeringId === offering?.id) || [];
        return {
          m,
          id,
          key,
          entries,
          entry,
          ctx: entry?.context || null,
          pricing: entry?.pricing || {},
          modality: entry?.modality || 'text',
          vendorFamily: entry?.vendor_family || '',
          isFlagship: Boolean(entry?.is_flagship),
          created: entry?.created || 0,
          legacy: Boolean(entry?.legacy),
          availability: platformAvailability.length ? platformAvailability : (m.availability || []),
          otherPlatforms: key ? [...new Set((entries || []).map((e: any) => e.platform))].filter((pl: string) => pl !== provider.id) : [],
        };
      });
  }, [provider, platform, offering, crossData]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.toLowerCase();
    return rows.filter(r =>
      r.id.toLowerCase().includes(s) ||
      (r.m.name || '').toLowerCase().includes(s) ||
      r.vendorFamily.toLowerCase().includes(s)
    );
  }, [rows, q]);

  const withParams = rows.filter(r => r.key).length;
  const usedCount = provider.usedBy?.length || 0;
  const eps = provider.executionMode === 'agent_native'
    ? []
    : (provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }]).map(normalizeEndpoint);
  const endpointById = new Map(platform.endpoints.map(endpoint => [endpoint.id, endpoint]));

  return (
    <div className="model-cross-view platform-detail-view">
      <div className="model-detail-header">
        <button className="model-detail-back" onClick={onBack}>← {t('models.backPlatforms')}</button>
        <div className="model-detail-title">
          <h3>{platform.name}</h3>
          <p>{t('models.platformSummary', { models: platform.models.length, offerings: platform.offerings.length })}</p>
        </div>
      </div>

      <div className="platform-offering-switcher" role="tablist" aria-label={t('models.totalOfferings')}>
        {platform.offerings.map(item => {
          const itemProvider = providers.find(candidate => candidate.id === item.providerId);
          const ready = runtimeAuthReady(itemProvider, itemProvider ? authMap[itemProvider.id] : undefined);
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.providerId === provider.id}
              className={`models-filter-chip${item.providerId === provider.id ? ' models-filter-chip--active' : ''}`}
              onClick={() => {
                setActiveOfferingId(item.providerId);
                setExpanded(new Set());
                setQ('');
              }}
            >
              {item.label}
              <span className="models-chip-extra">{item.executionMode === 'agent_native' ? 'Agent native' : `${item.endpointIds.length} endpoint`}</span>
              <span aria-label={ready ? t('models.statusAuthed') : t('models.statusUnauthed')}>{ready ? '✓' : '○'}</span>
            </button>
          );
        })}
      </div>

      <div className="platform-active-offering">
        <span className={`type-badge type-badge--${provider.type}`}>{provider.type}</span>
        <strong>{providerName(provider.id, provider.name)}</strong>
      </div>

      {/* 平台概览信息卡 */}
      <div className="model-info-grid">
        <div className="model-info-card">
          <div className="model-info-label">{t('models.totalModels')}</div>
          <div className="model-info-value">{provider.models.length}</div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.withParams')}</div>
          <div className="model-info-value">{withParams}<span className="model-info-muted"> / {provider.models.length}</span></div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.infoAuthed')}</div>
          <div className="model-info-value">
            {authed ? <span className="model-info-ok">✓</span> : <span className="model-info-muted">—</span>}
          </div>
        </div>
        <div className="model-info-card">
          <div className="model-info-label">{t('models.usedCount')}</div>
          <div className="model-info-value">{usedCount}</div>
        </div>
        <div className="model-info-card platform-detail-endpoint-card">
          <div className="model-info-label">{t('models.endpoint')}</div>
          <div className="model-info-value platform-detail-endpoints">
            {provider.executionMode === 'agent_native' && (
              <span className="model-info-mode">Agent native · {provider.nativeAgentIds?.join(', ') || '—'}</span>
            )}
            {eps.map((ep, i) => (
              <span key={i} className="model-info-mode">
                {ep.type}{ep.type === 'openai' ? `/${ep.protocol || 'chat'}` : ''} · {ep.baseUrl}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 模型搜索 */}
      <input
        className="vault-input platform-detail-search"
        type="search"
        placeholder={t('models.searchModels')}
        value={q}
        onChange={e => setQ(e.target.value)}
      />

      {/* 完整模型列表（不做截断） */}
      <div className="platform-model-list">
        {filtered.length === 0 && (
          <div className="empty-state"><p>{t('models.noMatch')}</p></div>
        )}
        {filtered.map(r => {
          const pi = fmtPrice(r.pricing?.prompt);
          const po = fmtPrice(r.pricing?.completion);
          const isOpen = expanded.has(r.id);
          return (
            <div
              key={r.id}
              className={`platform-model-row${isOpen ? ' platform-model-row--open' : ''}`}
              onClick={() => setExpanded(prev => {
                const n = new Set(prev);
                n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                return n;
              })}
            >
              <div className="platform-model-row-head">
                <span className={`model-card-mod model-card-mod--${r.modality}`}>{MOD_LABEL[r.modality] || r.modality}</span>
                <span className="platform-model-id"><code>{r.id}</code></span>
                {r.isFlagship && <span className="platform-model-flag">{t('models.isFlagship')}</span>}
                {r.ctx && <span className="platform-model-ctx">{Math.round(r.ctx / 1024)}K</span>}
                <span className="platform-model-price">
                  {pi > 0 ? `$${pi.toFixed(2)}/M in` : ''}
                  {po > 0 ? ` · $${po.toFixed(2)}/M out` : ''}
                </span>
                {!r.key && <span className="platform-model-nodata-tag">{t('models.noParamData')}</span>}
                {r.availability.length > 0 && (
                  <span className="platform-model-nodata-tag">
                    {r.availability.some((item: any) => item.executionMode === 'agent_native')
                      ? t('models.sourceAgentNative')
                      : r.availability.flatMap((item: any) => item.endpointIds || (item.endpointId ? [item.endpointId] : []))
                          .map((endpointId: string) => endpointById.get(endpointId))
                          .filter(Boolean)
                          .map((endpoint: any) => `${endpoint.protocol.family} · ${endpoint.baseUrl}`)
                          .join(', ') || t('models.sourceUnknown')}
                  </span>
                )}
                <span className="platform-model-chevron">▾</span>
              </div>
              {isOpen && (
                <div className="platform-model-detail">
                  <div className="model-info-grid platform-model-params">
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.infoContext')}</div>
                      <div className="model-info-value">{r.ctx ? `${Math.round(r.ctx / 1024)}K` : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.inputPrice')}</div>
                      <div className="model-info-value">{!Object.prototype.hasOwnProperty.call(r.pricing || {}, 'prompt') ? '—' : pi > 0 ? <span className="model-info-price">${pi.toFixed(2)}<span className="model-info-unit">/M</span></span> : t('common.free')}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.outputPrice')}</div>
                      <div className="model-info-value">{!Object.prototype.hasOwnProperty.call(r.pricing || {}, 'completion') ? '—' : po > 0 ? <span className="model-info-price">${po.toFixed(2)}<span className="model-info-unit">/M</span></span> : t('common.free')}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.modality')}</div>
                      <div className="model-info-value">{MOD_LABEL[r.modality] || r.modality}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.vendorFamily')}</div>
                      <div className="model-info-value">{r.vendorFamily || '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.isFlagship')}</div>
                      <div className="model-info-value">{r.isFlagship ? '✓' : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.released')}</div>
                      <div className="model-info-value">{r.created ? fmtTimeAgo(r.created) : '—'}</div>
                    </div>
                    <div className="model-info-card">
                      <div className="model-info-label">{t('models.otherPlatforms')}</div>
                      <div className="model-info-value">{r.otherPlatforms.length ? r.otherPlatforms.join(' · ') : '—'}</div>
                    </div>
                  </div>
                  {!r.key && (
                    <div className="platform-model-nodata">
                      {t('models.noParamDataHint')}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 模型本体卡片网格（模型视角默认）：按主厂商分组 + 按发布时间倒序 + 隐藏老旧
