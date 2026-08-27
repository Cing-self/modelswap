import { Provider } from '../../api/providers';
import CustomSelect from '../shared/CustomSelect';
import { ModelDetailPanel } from './ModelDetailPanel';
import { ModelGrid } from './ModelGrid';
import { PlatformDetailPanel } from './PlatformDetailPanel';
import { ProviderForm } from './ProviderForm';
import { PlatformCardList } from './PlatformCardList';
import { PROVIDER_LABELS, PROTOCOLS } from './modelsCatalog';
import type { PlanFilter, StatusFilter } from './modelsCatalog';
import type { ModelsPageState } from './useModelsPageState';

export function ModelsWorkspaceView(props: ModelsPageState) {
  const { loading, activePlatform, activeModel, t, modelStats, authLoaded, authLoadFailed, MODEL_COMPARISON_ENABLED, PLATFORM_DETAIL_ENABLED, view, searchQuery, setSearchQuery, activeModelProvider, setActiveModelProvider, modelVendorOptions, activeModality, setActiveModality, activeProtocol, setActiveProtocol, providers, providerProtocols, hideLegacy, setHideLegacy, filteredComparisonCount, hasComparisonFilters, sortedFamilies, handleAdd, activePlanFilter, setActivePlanFilter, setFamilyPlan, platformPlanOptions, statusFilter, setStatusFilter, platformStatusOptions, crossData, authMap, setActiveModel, sortedProviders, familyPlan, providerPlans, platforms, isAuthed, getCardAuthMethod, isUsedBy, isAuthMethodAuthed, testingConn, setActivePlatform, actionMenuId, setActionMenuId, loggingIn, handleOAuthLogin, handleConnect, syncingModels, handleEdit, handleDelete, showForm, editProvider, setEditProvider, setShowForm, handleFormSave, providerName } = props;
  if (loading) {
    return (
      <div className="provider-list">
        {Array.from({ length: 10 }).map((_, i) => (
          <article key={i} className="provider-card provider-card--skeleton" aria-hidden="true">
            <div className="provider-card-header">
              <div className="skeleton-shape skeleton-shape--icon" />
              <div className="skeleton-line skeleton-line--title" />
            </div>
            <div className="skeleton-line" />
            <div className="skeleton-line skeleton-line--short" />
          </article>
        ))}
      </div>
    );
  }

  return (
    <>
    <div className="access-workspace models-workspace models-page-full">

        {!activePlatform && !activeModel && (
          <header className="models-page-heading">
            <div className="models-page-heading-copy">
              <span className="models-page-eyebrow">{t('models.pageEyebrow')}</span>
              <h1 className="sr-only">{t('models.pageTitle')}</h1>
              <p>{t('models.pageSubtitle')}</p>
            </div>
            <div className="models-page-summary" aria-label={t('models.pageSummary')}>
              <span><strong>{modelStats.total}</strong>{t('models.summaryPlatforms')}</span>
              <span><strong>{modelStats.models}</strong>{t('models.summaryModels')}</span>
              <span className={authLoaded && modelStats.attention > 0 ? 'is-attention' : ''}>
                <strong>{authLoaded ? modelStats.attention : '—'}</strong>{t('models.summaryAttention')}
              </span>
            </div>
          </header>
        )}

        {/* 平台使用分组筛选；模型对比使用单行紧凑筛选。 */}
        {MODEL_COMPARISON_ENABLED && !activePlatform && view === 'model' && !activeModel && (
          <div className="model-compare-filterbar">
            <label className="model-compare-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('models.searchModels')}
              />
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimModelProvider')}</span>
              <select value={activeModelProvider || ''} onChange={event => setActiveModelProvider(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                {modelVendorOptions.map(([vendor, count]: [string, number]) => (
                  <option key={vendor} value={vendor}>{PROVIDER_LABELS[vendor] || vendor} · {count}</option>
                ))}
              </select>
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimModality')}</span>
              <select value={activeModality || ''} onChange={event => setActiveModality(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                <option value="text">{t('models.modText')}</option>
                <option value="image">{t('models.modImage')}</option>
                <option value="video">{t('models.modVideo')}</option>
                <option value="audio">{t('models.modAudio')}</option>
                <option value="3d">{t('models.mod3d')}</option>
                <option value="omni">{t('models.modOmni')}</option>
              </select>
            </label>
            <label className="model-compare-select">
              <span>{t('models.dimProtocol')}</span>
              <select value={activeProtocol || ''} onChange={event => setActiveProtocol(event.target.value || null)}>
                <option value="">{t('models.filterAll')}</option>
                {PROTOCOLS.filter(protocol => providers.some((provider: Provider) => providerProtocols(provider).includes(protocol.key))).map((protocol) => (
                  <option key={protocol.key} value={protocol.key}>{t(protocol.labelKey)}</option>
                ))}
              </select>
            </label>
            <label className="model-compare-latest">
              <input type="checkbox" checked={hideLegacy} onChange={event => setHideLegacy(event.target.checked)} />
              <span>{t('models.onlyLatest')}</span>
            </label>
            <span className="model-compare-result-count">{filteredComparisonCount}</span>
            {hasComparisonFilters && (
              <button
                type="button"
                className="model-compare-clear"
                onClick={() => {
                  setSearchQuery('');
                  setActiveModelProvider(null);
                  setActiveModality(null);
                  setActiveProtocol(null);
                  setHideLegacy(true);
                }}
              >
                {t('models.clearFilters')}
              </button>
            )}
          </div>
        )}
        {!activePlatform && view === 'platform' && <div className="models-toolbar">
          <div className="models-platform-search-row">
            <label className="models-platform-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('models.searchPlaceholder')}
                aria-label={t('models.searchPlaceholder')}
              />
              <span aria-hidden="true">{sortedFamilies.length}</span>
            </label>
            <button className="models-add-inline" onClick={handleAdd}>{t('models.addPlatform')}</button>
          </div>
          <div className="models-filter-select-row" aria-label={t('models.filterConditions')}>
            <div className={`models-filter-select-field${activePlanFilter ? ' is-active' : ''}`}>
              <span>{t('models.dimPlan')}</span>
              <CustomSelect
                className="models-filter-select"
                value={activePlanFilter || 'all'}
                options={platformPlanOptions}
                onChange={value => {
                  setActivePlanFilter(value === 'all' ? null : value as PlanFilter);
                  setFamilyPlan({});
                }}
              />
            </div>
            <div className={`models-filter-select-field${statusFilter !== 'all' ? ' is-active' : ''}`}>
              <span>{t('models.dimStatus')}</span>
              <CustomSelect
                className="models-filter-select"
                value={statusFilter}
                options={platformStatusOptions}
                onChange={value => setStatusFilter(value as StatusFilter)}
              />
            </div>
          </div>
        </div>}

        {MODEL_COMPARISON_ENABLED && view === 'model' && activeModel && crossData[activeModel] && (
          <ModelDetailPanel modelKey={activeModel} entries={crossData[activeModel]} providers={providers} authMap={authMap} t={t} onBack={() => setActiveModel(null)} />
        )}
        {MODEL_COMPARISON_ENABLED && view === 'model' && !activeModel && (
          <ModelGrid
            models={(Object.entries(crossData) as [string, any[]][]).filter(([, e]) => Array.isArray(e) && e.length > 0)}
            providers={providers}
            authMap={authMap}
            activeModel={activeModel}
            searchQuery={searchQuery}
            onSelect={(k) => setActiveModel(k)}
            t={t}
            activeProvider={activeModelProvider}
            hideLegacy={hideLegacy}
            activeProtocol={activeProtocol}
            activeModality={activeModality}
          />
        )}
        {view === 'platform' && !activePlatform && <PlatformCardList {...props} />}

        {PLATFORM_DETAIL_ENABLED && view === 'platform' && activePlatform && (
          (() => {
            const platform = platforms.find((item: any) => item.id === activePlatform)
              || platforms.find((item: any) => item.providerIds.includes(activePlatform));
            if (!platform) return <div className="empty-state"><p>{t('models.noMatch')}</p></div>;
            return (
              <PlatformDetailPanel
                key={platform.id}
                platform={platform}
                providers={providers}
                authMap={authMap}
                crossData={crossData}
                onBack={() => setActivePlatform(null)}
              />
            );
          })()
        )}

      {showForm && (
        <ProviderForm
          key={editProvider?.id || 'new-platform'}
          provider={editProvider}
          platform={platforms.find((platform: any) => editProvider ? platform.providerIds.includes(editProvider.id) : false) || null}
          onOAuthLogin={handleOAuthLogin}
          oauthLoggedIn={editProvider ? authMap[editProvider.id]?.oauthLoggedIn === true : false}
          oauthLoggingIn={editProvider ? loggingIn === editProvider.id : false}
          onSelectOffering={providerId => {
            const next = providers.find((provider: Provider) => provider.id === providerId);
            if (next) setEditProvider(next);
          }}
          onSave={handleFormSave}
          onClose={() => { setShowForm(false); setEditProvider(null); }}
        />
      )}
      </div>
    </>
  );
}
