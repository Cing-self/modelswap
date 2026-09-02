import { useEffect, useRef, useState } from 'react';
import { Provider, ProviderEndpoint, ProviderModel, Platform } from '../../api/providers';
import VaultPickerModal from '../shared/VaultPickerModal';
import CustomSelect from '../shared/CustomSelect';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import { getProviderDocs, ProviderDocsKind } from '../../data/providerDocs';
import { useI18n } from '../../i18n';
import { PRESET_PROVIDER_IDS, TYPE_OPTIONS, OPENAI_PROTOCOL_OPTIONS, endpointProtocol, normalizeEndpoint, createOpenAIEndpoint } from './modelsCatalog';
import { useProviderConnectionTest } from './useProviderConnectionTest';
export function ProviderForm({ provider, platform, onSelectOffering, onOAuthLogin, oauthLoggedIn, oauthLoggingIn, onSave, onClose }: {
  provider: Provider | null;
  platform: Platform | null;
  onSelectOffering: (providerId: string) => void;
  onOAuthLogin: (providerId: string) => void;
  oauthLoggedIn: boolean;
  oauthLoggingIn: boolean;
  onSave: (data: any) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isAgentNative = provider?.executionMode === 'agent_native';
  const isCustomProvider = !provider || !PRESET_PROVIDER_IDS.has(provider.id);
  const [editorPane, setEditorPane] = useState<'connection' | 'models'>('connection');
  const [modelQuery, setModelQuery] = useState('');
  const [name, setName] = useState(provider?.name || '');
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[]>(
    (isAgentNative ? [] : (provider?.endpoints || (provider ? [{ type: provider.type, baseUrl: provider.baseUrl }] : [createOpenAIEndpoint()]))).map(normalizeEndpoint)
  );
  const [models, setModels] = useState<ProviderModel[]>(
    provider?.models?.map(m => ({ ...m })) || []
  );
  const [vaultKey, setVaultKey] = useState(provider?.vaultKey || '');

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]') || []);
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (panel?.querySelector('.vault-picker')) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);
  const [authMode, setAuthMode] = useState<'api_key' | 'oauth' | 'both' | 'none'>(
    (provider?.authMode as any) || 'api_key'
  );
  const [showVaultPicker, setShowVaultPicker] = useState(false);
  // A new provider must be explicitly tested. Existing providers keep their
  // historical status until the key or endpoint configuration is changed.
  const [editorDirty, setEditorDirty] = useState(!provider);
  const {
    testingConnection,
    connectionResults,
    connectionState,
    pulledModelCount,
    resetConnection,
    handleTestConnection,
  } = useProviderConnectionTest({
    provider,
    endpoints,
    vaultKey,
    setModels,
    onModelsChanged: () => setEditorDirty(true),
    t,
  });

  function markConnectionDirty() {
    setEditorDirty(true);
    resetConnection();
  }

  function currentOfferingPlan(): ProviderEndpoint['plan'] {
    const endpointPlan = endpoints.find(endpoint => endpoint.plan)?.plan;
    if (endpointPlan) return endpointPlan;
    const offering = platform?.offerings.find(item => item.providerId === provider?.id);
    if (offering?.type === 'coding_plan') return 'coding';
    if (offering?.type === 'token_plan') return 'token';
    if (offering?.type === 'agent_plan') return 'agent';
    if (offering?.type === 'go_plan') return 'go';
    return undefined;
  }

  function addEndpoint() {
    const endpoint = createOpenAIEndpoint();
    const plan = currentOfferingPlan();
    setEndpoints([...endpoints, plan ? { ...endpoint, plan } : endpoint]);
    markConnectionDirty();
  }

  function removeEndpoint(i: number) {
    if (endpoints.length <= 1) return;
    setEndpoints(endpoints.filter((_, idx) => idx !== i));
    markConnectionDirty();
  }

  function withEndpointField(endpoint: ProviderEndpoint, field: keyof ProviderEndpoint, value: string) {
    const updated = { ...endpoint, [field]: value };
    if (field === 'type') {
      if (value === 'openai') updated.protocol = updated.protocol || 'chat';
      else delete updated.protocol;
    }
    return normalizeEndpoint(updated as ProviderEndpoint);
  }

  function updateEndpoint(i: number, field: keyof ProviderEndpoint, value: string) {
    const next = [...endpoints];
    next[i] = withEndpointField(next[i], field, value);
    setEndpoints(next);
    markConnectionDirty();
  }

  function updateEndpointGroup(indexes: number[], field: keyof ProviderEndpoint, value: string) {
    const indexSet = new Set(indexes);
    setEndpoints(endpoints.map((endpoint, index) =>
      indexSet.has(index) ? withEndpointField(endpoint, field, value) : endpoint
    ));
    markConnectionDirty();
  }

  function removeEndpointGroup(indexes: number[]) {
    if (endpoints.length <= indexes.length) return;
    const indexSet = new Set(indexes);
    setEndpoints(endpoints.filter((_, index) => !indexSet.has(index)));
    markConnectionDirty();
  }

  function addModel() {
    setModels([...models, { id: '', origin: 'user' }]);
    setEditorDirty(true);
  }

  function removeModel(i: number) {
    setModels(models.filter((_, idx) => idx !== i));
    setEditorDirty(true);
  }

  function updateModelParameter(i: number, value: string) {
    const next = [...models];
    const current = next[i];
    next[i] = {
      ...current,
      id: value,
      // Synced records often use the request parameter as their display name.
      // Keep those values aligned, while preserving a real custom display name.
      name: !current.name || current.name === current.id ? (value || undefined) : current.name,
    };
    setModels(next);
    setEditorDirty(true);
  }

  const connectionTitle = connectionState === 'testing'
    ? t('models.connectionTesting')
    : connectionState === 'success'
      ? (pulledModelCount > 0 ? t('models.connectionModelsPulled', { n: pulledModelCount }) : t('models.connectionSuccess'))
      : connectionState === 'failure'
        ? `${t('models.connectionFailure')}: ${connectionResults?.find(result => !result.success)?.message || t('models.testFailed')}`
        : t('models.connectionIdle');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validModels = models.filter(m => m.id.trim());
    const validEndpoints = endpoints.map(normalizeEndpoint).filter(ep => ep.baseUrl.trim());
    const primary = validEndpoints[0] || (provider
      ? { type: provider.type, baseUrl: provider.baseUrl }
      : normalizeEndpoint(endpoints[0]));
    onSave({
      id: provider?.id || name.toLowerCase().replace(/\s+/g, '-'),
      name,
      type: primary.type,
      baseUrl: primary.baseUrl,
      endpoints: validEndpoints,
      models: validModels,
      vaultKey: vaultKey.trim() || undefined,
      authMode,
      executionMode: provider?.executionMode || 'http_endpoint',
      nativeAgentIds: provider?.nativeAgentIds,
    });
  }

  const providerDocs = provider ? getProviderDocs(provider.id) : null;
  const providerDocsLabelKeys: Record<ProviderDocsKind, string> = {
    api: 'models.providerDocsApi',
    coding_plan: 'models.providerDocsCodingPlan',
    token_plan: 'models.providerDocsTokenPlan',
    agent_plan: 'models.providerDocsAgentPlan',
    agent_subscription: 'models.providerDocsAgentSubscription',
    go_plan: 'models.providerDocsGoPlan',
    local: 'models.providerDocsLocal',
  };
  const visibleModels = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => {
      const query = modelQuery.trim().toLowerCase();
      return !query || model.id.toLowerCase().includes(query) || (model.name || '').toLowerCase().includes(query);
    });
  const endpointEditorGroups = (() => {
    if (isCustomProvider) return endpoints.map((endpoint, index) => ({ endpoint, indexes: [index] }));
    const groups: { endpoint: ProviderEndpoint; indexes: number[] }[] = [];
    const groupByAddress = new Map<string, number>();
    endpoints.forEach((endpoint, index) => {
      // Built-in platforms may support Chat and Responses through the same
      // OpenAI-compatible base URL. They are one connection in the editor,
      // while the underlying protocol-specific routes remain intact.
      const normalizedBaseUrl = endpoint.baseUrl.trim();
      const key = normalizedBaseUrl
        ? `${endpoint.type}\u0000${normalizedBaseUrl}\u0000${endpoint.plan || ''}`
        : `new-endpoint\u0000${index}`;
      const groupIndex = groupByAddress.get(key);
      if (groupIndex === undefined) {
        groupByAddress.set(key, groups.length);
        groups.push({ endpoint, indexes: [index] });
      } else {
        groups[groupIndex].indexes.push(index);
      }
    });
    return groups;
  })();

  return (
    <>
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className={`modal-panel modal-panel--wide provider-form-panel provider-form-panel--${editorPane}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-editor-title"
      >
        <form onSubmit={handleSubmit}>
          <div className="provider-editor-layout">
            <section className="provider-editor-main">
              <div className="provider-editor-header">
                <div>
                  <div className="provider-editor-context">
                    {provider && getProviderIcon(provider.id) && <img src={getProviderIcon(provider.id)} alt="" className={getProviderIconClass(provider.id)} />}
                    <strong>{platform?.name || provider?.name || t('models.newPlatform')}</strong>
                    {platform && platform.offerings.length > 1 && (
                      <div className="provider-editor-offering-switch" aria-label={t('models.totalOfferings')}>
                        {platform.offerings.map(offering => (
                          <button
                            type="button"
                            key={offering.id}
                            className={offering.providerId === provider?.id ? 'active' : ''}
                            onClick={() => onSelectOffering(offering.providerId)}
                          >
                            {offering.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <h2 id="provider-editor-title">{editorPane === 'connection' ? t('models.editorConnection') : t('models.modelsSection')}</h2>
                  <p>{editorPane === 'connection' ? t('models.editorConnectionHint') : t('models.editorModelsHint')}</p>
                </div>
                <div className="provider-editor-header-actions">
                  {providerDocs && (
                    <div className="provider-docs-actions">
                      <a href={providerDocs.url} target="_blank" rel="noopener noreferrer" className="provider-docs-link">
                        {t(providerDocsLabelKeys[providerDocs.kind])} ↗
                      </a>
                      {providerDocs.consoleUrl && (
                        <a href={providerDocs.consoleUrl} target="_blank" rel="noopener noreferrer" className="provider-docs-link provider-console-link">
                          {providerDocs.consoleLabelKey ? t(providerDocs.consoleLabelKey) : t('models.providerConsole')} ↗
                        </a>
                      )}
                    </div>
                  )}
                  <button type="button" className="provider-editor-close" onClick={onClose} aria-label={t('common.close')}>×</button>
                </div>
              </div>

              <nav className="provider-editor-nav" aria-label={t('models.editorSections')}>
                <button type="button" className={editorPane === 'connection' ? 'active' : ''} onClick={() => setEditorPane('connection')}>
                  <span className="provider-editor-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="8"/></svg></span>
                  <span className="provider-editor-nav-copy"><strong>{t('models.editorConnection')}</strong><small>{t('models.editorConnectionHint')}</small></span>
                </button>
                <button type="button" className={editorPane === 'models' ? 'active' : ''} onClick={() => setEditorPane('models')}>
                  <span className="provider-editor-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v5H4zM4 14h16v5H4z"/></svg></span>
                  <span className="provider-editor-nav-copy"><strong>{t('models.modelsSection')}</strong><small>{models.length} {t('models.totalModels')}</small></span>
                </button>
              </nav>

              {providerDocs?.setupHintKey && (
                <div className="provider-setup-hint">
                  <span className="provider-setup-hint-mark" aria-hidden="true">i</span>
                  <span>{t(providerDocs.setupHintKey)}</span>
                </div>
              )}

              <main className="provider-editor-content">
              {editorPane === 'connection' && (
                <>
                  {!provider && !isAgentNative && (
                    <label className="provider-editor-field">
                      <span>{t('common.name')}</span>
                      <input className="vault-input" value={name} onChange={event => setName(event.target.value)} required autoFocus />
                    </label>
                  )}

                  {isAgentNative ? (
                    <div className="provider-editor-native-note">
                      <span>OAuth</span>
                      <div>
                        <strong>{t('models.agentNativeTitle')}</strong>
                        <p>{t('models.agentNativeEditorHint', { agents: provider?.nativeAgentIds?.join(', ') || '—' })}</p>
                        <div className="provider-editor-native-actions">
                          <span className={`provider-editor-native-status${oauthLoggedIn ? ' is-authed' : ''}`}>
                            {oauthLoggedIn ? t('models.statusAuthed') : t('models.statusUnauthed')}
                          </span>
                          <button
                            type="button"
                            className="provider-editor-native-login"
                            onClick={() => provider && onOAuthLogin(provider.id)}
                            disabled={!provider || oauthLoggingIn}
                          >
                            {oauthLoggingIn ? t('models.testingConn') : t('models.authModeOAuth')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <section className="provider-editor-block">
                        <div className="provider-editor-block-title">
                          <div><strong>{t('models.endpoint')}</strong><span>{t('models.editorEndpointHint')}</span></div>
                          <button type="button" onClick={addEndpoint}>＋ {t('models.addEndpoint')}</button>
                        </div>
                        <div className="endpoint-list">
                          {endpointEditorGroups.map(({ endpoint, indexes }, groupIndex) => (
                            <div key={indexes.map((index) => endpoints[index].id ?? `endpoint-${index}`).join(':')} className={`endpoint-row endpoint-row--${endpoint.type}`}>
                              <span className="provider-editor-row-index">{String(groupIndex + 1).padStart(2, '0')}</span>
                              <CustomSelect className="endpoint-type-select" dropdownMode="local" value={endpoint.type} onChange={value => updateEndpointGroup(indexes, 'type', value)} options={TYPE_OPTIONS} />
                              <input className="vault-input endpoint-url-input" value={endpoint.baseUrl} onChange={event => updateEndpointGroup(indexes, 'baseUrl', event.target.value)} placeholder="https://api.example.com" aria-label={`${t('models.endpoint')} ${groupIndex + 1}`} required />
                              {endpointEditorGroups.length > 1 && <button type="button" className="endpoint-remove-btn" onClick={() => removeEndpointGroup(indexes)}>×</button>}
                            </div>
                          ))}
                        </div>
                        {isCustomProvider && endpoints.some(endpoint => endpoint.type === 'openai') && (
                          <details className="provider-editor-advanced">
                            <summary>
                              <span>{t('models.advancedProtocol')}</span>
                              <small>{t('models.advancedProtocolHint')}</small>
                            </summary>
                            <div className="provider-editor-advanced-list">
                              {endpoints.map((endpoint, index) => endpoint.type === 'openai' && (
                                <label key={endpoint.id || index} className="provider-editor-advanced-row">
                                  <span>{t('models.endpoint')} {String(index + 1).padStart(2, '0')}</span>
                                  <CustomSelect dropdownMode="local" value={endpoint.protocol || 'chat'} onChange={value => updateEndpoint(index, 'protocol', value)} options={OPENAI_PROTOCOL_OPTIONS} />
                                </label>
                              ))}
                            </div>
                          </details>
                        )}
                      </section>

                      <section className="provider-editor-block">
                        <div className="provider-editor-block-title">
                          <div><strong>{t('models.authSection')}</strong><span>{t('models.editorAuthHint')}</span></div>
                          <div className="provider-editor-auth-toggle">
                            {isCustomProvider ? (
                              <>
                                <button type="button" className={authMode !== 'none' ? 'active' : ''} onClick={() => { setAuthMode('api_key'); markConnectionDirty(); }}>API Key</button>
                                <button type="button" className={authMode === 'none' ? 'active' : ''} onClick={() => { setAuthMode('none'); markConnectionDirty(); }}>{t('models.authModeNone')}</button>
                              </>
                            ) : (
                              <span className={`provider-editor-auth-method${authMode === 'none' ? ' provider-editor-auth-method--none' : ''}`}>
                                {authMode === 'none' ? t('models.authModeNone') : 'API Key'}
                              </span>
                            )}
                          </div>
                        </div>
                        {authMode !== 'none' && (
                          <div className="provider-secret-field settings-workspace settings-workspace--light">
                            <div className="settings-field--secret">
                              <label>{t('models.keyReference')}</label>
                              <div className="vault-ref-field">
                                {vaultKey ? (
                                  <div className="vault-ref-selected">
                                    <span className="vault-ref-key">{vaultKey}</span>
                                    <button type="button" className="vault-ref-clear" onClick={() => { setVaultKey(''); markConnectionDirty(); }}>×</button>
                                    <button type="button" className="vault-ref-change" onClick={() => setShowVaultPicker(true)}>{t('common.replace')}</button>
                                    <button type="button" className={`provider-auth-connection-btn provider-auth-connection-btn--${connectionState}`} onClick={handleTestConnection} disabled={testingConnection || !endpoints.some(ep => ep.baseUrl.trim())} title={connectionTitle} aria-label={connectionTitle}>
                                      {testingConnection ? <span className="provider-auth-connection-spinner" aria-hidden="true">↻</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.14 1.14"/><path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 7 20l1.14-1.14"/></svg>}
                                    </button>
                                  </div>
                                ) : (
                                  <button type="button" className="vault-ref-trigger" onClick={() => setShowVaultPicker(true)}>{t('models.selectFromVault')}</button>
                                )}
                              </div>
                            </div>
                            <p className="provider-auth-hint">
                              {provider?.id === 'qianfan-coding' && t('models.qianfanCodingKeyHint')}
                              {provider?.id === 'qianfan-coding' && connectionState !== 'idle' && ' · '}
                              {provider?.id === 'qianfan-coding' && connectionState === 'idle' ? null : connectionTitle}
                            </p>
                          </div>
                        )}
                        {authMode === 'none' && (
                          <p className="provider-editor-no-auth-hint">
                            {isCustomProvider ? t('models.noAuthCustomHint') : t('models.noAuthPresetHint')}
                          </p>
                        )}
                      </section>
                    </>
                  )}
                </>
              )}

              {editorPane === 'models' && (
                <>
                  <div className="provider-editor-model-toolbar">
                    <input className="vault-input" type="search" value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder={t('models.searchModels')} />
                  </div>
                  <div className="provider-editor-model-head" aria-hidden="true">
                    <span />
                    <div><strong>{t('models.modelParameterName')}</strong><small>{t('models.modelParameterHint')}</small></div>
                    <span />
                  </div>
                  <div className="model-form-list provider-editor-model-list">
                    {visibleModels.length === 0 ? (
                      <div className="model-form-empty">{models.length === 0 ? t('common.notConfigured') : t('models.noMatch')}</div>
                    ) : visibleModels.map(({ model, index }) => (
                      <div key={`${model.id}-${index}`} className="model-form-row">
                        <span className="provider-editor-row-index">{String(index + 1).padStart(2, '0')}</span>
                        <input className="vault-input model-form-id" value={model.id} onChange={event => updateModelParameter(index, event.target.value)} placeholder={t('models.modelParameterExample')} aria-label={t('models.modelParameterName')} />
                        <button type="button" className="endpoint-remove-btn" onClick={() => removeModel(index)}>×</button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="provider-editor-model-add model-add-btn"
                      onClick={addModel}
                    >
                      ＋ {t('models.addModel')}
                    </button>
                  </div>
                </>
              )}
              </main>

              <div className="modal-actions">
                <span className="provider-editor-save-hint">{editorDirty ? t('models.editorUnsaved') : t('models.editorSavedState')}</span>
                <button type="button" className="btn-cancel" onClick={onClose}>{t('common.cancel')}</button>
                <button type="submit" className="btn-save">{t('common.save')}</button>
              </div>
            </section>
          </div>
        </form>
      </div>
    </div>

    {showVaultPicker && (
      <div className="settings-workspace settings-workspace--light">
      <VaultPickerModal
        selected={vaultKey}
        onSelect={key => { setVaultKey(key); markConnectionDirty(); setShowVaultPicker(false); }}
        onClose={() => setShowVaultPicker(false)}
        testEndpoint={endpoints[0]?.baseUrl ? { baseUrl: endpoints[0].baseUrl, type: endpoints[0].type, protocol: endpointProtocol(endpoints[0]) } : undefined}
      />
      </div>
    )}
    </>
  );
}
