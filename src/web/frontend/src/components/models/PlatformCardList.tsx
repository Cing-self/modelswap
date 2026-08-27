import { Provider } from '../../api/providers';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import { ActionMenu } from './ActionMenu';
import type { ModelsPageState } from './useModelsPageState';

export function PlatformCardList(props: ModelsPageState) {
  const { sortedProviders, sortedFamilies, activePlanFilter, familyPlan, providerPlans, platforms, authMap, isAuthed, getCardAuthMethod, isUsedBy: _isUsedBy, isAuthMethodAuthed, authLoaded, authLoadFailed, providerName, PLATFORM_DETAIL_ENABLED, testingConn, setActivePlatform, actionMenuId, setActionMenuId, loggingIn, handleOAuthLogin, handleConnect, syncingModels, handleEdit, handleDelete, providers, t } = props;
  return (
    <div>
      {sortedProviders.length === 0 && <div className="empty-state"><p>{t('models.noMatch')}</p></div>}
      <div className="provider-list">
        {sortedFamilies.map((family: any) => {
          const isMulti = family.isMulti;
          const familyDefinition = family.familyDef;
          let provider: Provider;
          if (isMulti && familyDefinition?.plans) {
            const filteredPlan = activePlanFilter
              ? familyDefinition.plans.find((plan: any) => {
                  const member = family.providers.find((candidate: Provider) => candidate.id === plan.providerId);
                  return member && providerPlans(member).includes(activePlanFilter);
                })
              : undefined;
            const selectedLabel = familyPlan[familyDefinition.family] || filteredPlan?.label || familyDefinition.plans[0]?.label;
            const selectedPlan = familyDefinition.plans.find((plan: any) => plan.label === selectedLabel) || familyDefinition.plans[0];
            provider = family.providers.find((member: Provider) => member.id === selectedPlan.providerId) || family.providers[0];
          } else {
            provider = family.providers[0];
          }
          const platform = platforms.find((item: any) => familyDefinition
            ? item.name === familyDefinition.family
            : item.providerIds.includes(provider.id));
          const auth = authMap[provider.id];
          const authed = isAuthed(provider);
          const selectedAuthMethod = getCardAuthMethod(provider);
          const oauthProvider = provider.authMode === 'oauth' || provider.authMode === 'both'
            ? provider
            : familyDefinition
              ? providers.find((candidate: Provider) => familyDefinition.ids.includes(candidate.id)
                && (candidate.authMode === 'oauth' || candidate.authMode === 'both'))
              : undefined;
          const needsVerification = selectedAuthMethod === 'api_key'
            && Boolean(provider.vaultKey && auth?.hasApiKey && (auth.authState === 'needs_verification' || auth.authState === 'invalid'));
          const familyAuthed = isMulti ? authed : isAuthMethodAuthed(provider, selectedAuthMethod);
          const authWarning = selectedAuthMethod === 'api_key' && (auth?.authState === 'stale' || auth?.authState === 'partial');
          const statusLabel = !authLoaded
            ? authLoadFailed ? t('models.statusUnavailable') : t('models.statusChecking')
            : authWarning
              ? auth?.authState === 'partial' ? t('models.statusPartial') : t('models.statusStale')
              : provider.authMode === 'none' ? t('models.statusNoAuth')
                : familyAuthed ? t('models.statusAuthed') : needsVerification ? t('models.statusNeedsVerification') : t('models.statusUnauthed');
          const authDetail = !authLoaded
            ? authLoadFailed ? t('models.authStatusUnavailable') : t('models.statusChecking')
            : authWarning
              ? `${auth?.authLastError || t('models.authNeedsRecheck')}${auth?.authLastCheckedAt ? ` · ${new Date(auth.authLastCheckedAt).toLocaleString()}` : ''}`
              : familyAuthed
                ? selectedAuthMethod === 'oauth' ? t('models.authenticatedViaOAuth') : provider.authMode === 'none' ? t('models.authModeNone') : t('models.authenticatedViaApiKey')
                : needsVerification ? t('models.apiKeyPendingVerification') : selectedAuthMethod === 'oauth' ? t('models.oauthNotCompleted') : t('models.apiKeyNotConfigured');

          return (
            <article key={platform?.id || familyDefinition?.family || provider.id} className={`provider-card${PLATFORM_DETAIL_ENABLED ? ' provider-card--clickable' : ''}${familyAuthed ? ' provider-card--authed' : ''}${testingConn === provider.id ? ' provider-card--testing' : ''}`} onClick={PLATFORM_DETAIL_ENABLED ? () => setActivePlatform(platform?.id || provider.id) : undefined} aria-busy={testingConn === provider.id}>
              <div className="provider-card-header">
                <div className="provider-card-title">
                  {(() => { const icon = getProviderIcon(provider.id); return icon ? <img src={icon} alt="" className={['provider-card-brand-icon', getProviderIconClass(provider.id)].filter(Boolean).join(' ')} /> : null; })()}
                  <h3>{providerName(provider.id, platform?.name || (isMulti && familyDefinition ? familyDefinition.family : provider.name))}</h3>
                </div>
                <div className="provider-card-status">
                  {testingConn === provider.id && <span className="provider-status provider-status--testing"><span className="provider-status-spinner" aria-hidden="true" />{t('models.testingConn')}</span>}
                  <span className={`provider-status provider-status--${!authLoaded ? 'pending' : authWarning ? 'warning' : familyAuthed ? 'authed' : 'unauthed'} provider-status--with-auth-tooltip`} tabIndex={0} data-auth-detail={authDetail}>{statusLabel}</span>
                </div>
                <div className="provider-card-actions">
                  <button className="btn-icon" onClick={event => { event.stopPropagation(); setActionMenuId(actionMenuId === provider.id ? null : provider.id); }} title={t('models.moreActions')} aria-haspopup="menu" aria-expanded={actionMenuId === provider.id}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                  </button>
                  {actionMenuId === provider.id && <ActionMenu onClose={() => setActionMenuId(null)} actions={[
                    ...(oauthProvider ? [{ label: loggingIn === oauthProvider.id ? t('models.testingConn') : t('models.authModeOAuth'), onClick: () => { setActionMenuId(null); handleOAuthLogin(oauthProvider.id); }, disabled: loggingIn === oauthProvider.id }] : []),
                    ...(selectedAuthMethod !== 'oauth' ? [{ label: provider.authMode === 'none' ? t('models.syncModels') : `${t('models.authModeApiKey')} ${t('models.menuConnect')}`, onClick: () => handleConnect(provider), disabled: testingConn === provider.id || syncingModels === provider.id }] : []),
                    { label: t('models.menuEdit'), onClick: () => handleEdit(provider) },
                    { label: t('models.menuDelete'), onClick: () => handleDelete(provider), danger: true },
                  ]} />}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
