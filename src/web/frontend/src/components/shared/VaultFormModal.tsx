import { useEffect, useState } from 'react';
import { getVaultValue, listAutoCreatePlatforms, setVault, type AutoCreatePlatform, type VaultSecret } from '../../api/vault';
import { apiRaw } from '../../api/client';
import { useI18n } from '../../i18n';
import CustomSelect from './CustomSelect';
import { getAutoCreatePlatformFields } from './autoCreateFormState';
import { normalizeGroupName, PREDEFINED_GROUPS } from '../../data/vault-groups';

interface VaultFormModalProps {
  groups: string[];
  initialSecret?: VaultSecret;
  onBeforeSave?: (next: { key: string; desc?: string; group?: string }) => Promise<boolean>;
  onClose: () => void;
  onSaved: (key: string) => void;
}

export default function VaultFormModal({ groups, initialSecret, onBeforeSave, onClose, onSaved }: VaultFormModalProps) {
  const { t } = useI18n();
  const isEdit = !!initialSecret;
  const initialGroup = initialSecret?.group || '';
  const [formKey, setFormKey] = useState(initialSecret?.key || '');
  const [formValue, setFormValue] = useState('');
  const [formDesc, setFormDesc] = useState(initialSecret?.desc || '');
  const [formGroup, setFormGroup] = useState(initialGroup && groups.includes(initialGroup) ? initialGroup : (initialGroup ? '__custom__' : ''));
  const [formGroupCustom, setFormGroupCustom] = useState(initialGroup && groups.includes(initialGroup) ? '' : initialGroup);
  const [showValue, setShowValue] = useState(false);
  const [loadingValue, setLoadingValue] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Auto-create state
  const [showAutoCreate, setShowAutoCreate] = useState(false);
  const [autoPlatform, setAutoPlatform] = useState('');
  const [autoCreating, setAutoCreating] = useState(false);
  const [autoError, setAutoError] = useState('');
  const [autoNotice, setAutoNotice] = useState('');
  const [loginHandoff, setLoginHandoff] = useState<{ platformLabel: string; browserFocused: boolean; loginUrl?: string } | null>(null);
  const [verificationHandoff, setVerificationHandoff] = useState<{ platformLabel: string; browserFocused: boolean } | null>(null);
  const [autoRunId, setAutoRunId] = useState<string | null>(null);
  const [parentToken, setParentToken] = useState('');
  const [autoPlatforms, setAutoPlatforms] = useState<AutoCreatePlatform[]>([]);
  const [loadingPlatforms, setLoadingPlatforms] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!initialSecret) return;

    setLoadingValue(true);
    getVaultValue(initialSecret.key)
      .then(data => {
        if (!cancelled) setFormValue(data.value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingValue(false);
      });

    return () => { cancelled = true; };
  }, [initialSecret?.key]);

  useEffect(() => {
    if (!showAutoCreate || isEdit || autoPlatforms.length) return;
    let cancelled = false;
    setLoadingPlatforms(true);
    listAutoCreatePlatforms()
      .then(({ platforms }) => { if (!cancelled) setAutoPlatforms(platforms); })
      .catch((err: Error) => { if (!cancelled) setAutoError(err.message || t('vault.autoCreateFailed')); })
      .finally(() => { if (!cancelled) setLoadingPlatforms(false); });
    return () => { cancelled = true; };
  }, [showAutoCreate, isEdit, autoPlatforms.length, t]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleSave() {
    if (!formKey || !formValue) return;
    const group = formGroup === '__custom__' ? formGroupCustom : formGroup;
    if (onBeforeSave && !(await onBeforeSave({ key: formKey, desc: formDesc.trim() || undefined, group: group || undefined }))) return;

    setSaving(true);
    setSaveError('');
    try {
      await setVault({
        key: formKey,
        value: formValue,
        desc: formDesc.trim() || undefined,
        group: group || undefined,
        originalKey: initialSecret?.key,
      });
      onSaved(formKey);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('vault.saveFail'));
    } finally {
      setSaving(false);
    }
  }

  function applyAutoCreateResult(result: any, platform: AutoCreatePlatform, tokenName: string) {
    // Auto-fill the form — use the name from the API response (may include
    // a uniqueness suffix like "ZHIPU_KEY-x7k2" that matches the platform)
    setFormKey(result.name || tokenName);
    setFormValue(result.value);
    applyAutoCreatePlatformGroup(platform);
    setShowAutoCreate(false);
    setAutoPlatform('');
    setParentToken('');
    setAutoRunId(null);
    setVerificationHandoff(null);
    if (Number(result.readyAfterMs) > 0) {
      setAutoNotice(t('vault.autoCreateReadyDelay', { seconds: Math.ceil(Number(result.readyAfterMs) / 1000) }));
    } else {
      setAutoNotice(t('vault.autoCreateReady'));
    }
  }

  function applyAutoCreatePlatformGroup(platform: AutoCreatePlatform) {
    const fields = getAutoCreatePlatformFields(platform, groups);
    setFormGroup(fields.group);
    setFormGroupCustom(fields.groupCustom);
  }

  function handleAutoPlatformChange(value: string) {
    if (autoCreating || autoRunId) return;
    const platform = autoPlatforms.find(item => item.id === value);
    if (!platform) return;

    // The name and group belong to the selected provider. Reset both when the
    // provider changes so a previous successful auto-create cannot leak its
    // MiniMax/OpenAI name or group into the next run.
    setAutoPlatform(value);
    setFormKey('');
    setFormValue('');
    applyAutoCreatePlatformGroup(platform);
    setParentToken('');
    setAutoError('');
    setAutoNotice('');
    setLoginHandoff(null);
    setVerificationHandoff(null);
  }

  async function pollAutoCreateRun(runId: string, platform: AutoCreatePlatform, tokenName: string) {
    while (true) {
      const response = await apiRaw(`/api/vault/auto-create/status/${encodeURIComponent(runId)}`);
      const result = await response.json() as any;
      if (!response.ok) throw new Error(result.error || t('vault.autoCreateFailed'));

      if (result.status === 'verification_required') {
        setVerificationHandoff({
          platformLabel: result.platformLabel || platform.label,
          browserFocused: Boolean(result.browserFocused),
        });
        setAutoCreating(false);
        return;
      }
      if (result.status === 'login_required' || result.loginRequired) {
        setLoginHandoff({
          platformLabel: result.platformLabel || platform.label,
          browserFocused: Boolean(result.browserFocused),
          loginUrl: result.loginUrl,
        });
        setVerificationHandoff(null);
        setAutoRunId(null);
        setAutoCreating(false);
        return;
      }
      if (result.status === 'succeeded' && result.success) {
        applyAutoCreateResult(result, platform, tokenName);
        return;
      }
      if (result.status === 'failed' || result.success === false) {
        setAutoRunId(null);
        setAutoError(result.error || t('vault.autoCreateFailed'));
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 800));
    }
  }

  async function handleResumeAutoCreate() {
    if (!autoRunId) return;
    setAutoCreating(true);
    setAutoError('');
    setVerificationHandoff(null);
    try {
      const response = await apiRaw(`/api/vault/auto-create/resume/${encodeURIComponent(autoRunId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await response.json() as any;
      if (!response.ok || !result.success) throw new Error(result.error || t('vault.autoCreateFailed'));
      const platform = autoPlatforms.find(p => p.id === autoPlatform);
      if (!platform) throw new Error(t('vault.autoCreateSelectPlatform'));
      await pollAutoCreateRun(autoRunId, platform, formKey || platform.keyHint);
    } catch (err: any) {
      setAutoError(err.message || t('vault.autoCreateFailed'));
      setAutoRunId(null);
    } finally {
      setAutoCreating(false);
    }
  }

  async function handleAutoCreate() {
    if (!autoPlatform) return;
    if (autoRunId) return;
    setAutoCreating(true);
    setAutoError('');
    setAutoNotice('');
    setLoginHandoff(null);
    setVerificationHandoff(null);
    try {
      const platform = autoPlatforms.find(p => p.id === autoPlatform)!;
      const tokenName = formKey || platform.defaultKeyName || platform.keyHint;

      const body: any = { platform: autoPlatform, tokenName, interactive: platform.mode === 'browser' };
      if (platform.mode === 'api') {
        if (!parentToken.trim()) {
          setAutoError(t('vault.autoCreateParentTokenRequired') || '请提供父级 API Token');
          setAutoCreating(false);
          return;
        }
        body.parentToken = parentToken.trim();
      }

      const response = await apiRaw('/api/vault/auto-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json() as any;

      if (result.pending && result.runId) {
        setAutoRunId(result.runId);
        await pollAutoCreateRun(result.runId, platform, tokenName);
      } else if (result.success) {
        applyAutoCreateResult(result, platform, tokenName);
      } else if (result.loginRequired) {
        setLoginHandoff({
          platformLabel: platform.label,
          browserFocused: Boolean(result.browserFocused),
          loginUrl: result.loginUrl,
        });
      } else {
        setAutoError(result.error || t('vault.autoCreateFailed'));
      }
    } catch (err: any) {
      setAutoError(err.message || t('vault.autoCreateFailed'));
    } finally {
      setAutoCreating(false);
    }
  }

  const selectedPlatform = autoPlatforms.find(p => p.id === autoPlatform);

  function formatKeyLimit(limit: NonNullable<AutoCreatePlatform['keyLimits']>[number]) {
    const scopeLabels: Record<string, string> = {
      user: t('vault.autoCreateKeyLimitScopeUser'),
      account: t('vault.autoCreateKeyLimitScopeAccount'),
      personal: t('vault.autoCreateKeyLimitScopePersonal'),
      'access-key-owner': t('vault.autoCreateKeyLimitScopeAccessKeyOwner'),
      organization: t('vault.autoCreateKeyLimitScopeOrganization'),
      'coding-plan': t('vault.autoCreateKeyLimitScopeCodingPlan'),
      seat: t('vault.autoCreateKeyLimitScopeSeat'),
      region: t('vault.autoCreateKeyLimitScopeRegion'),
      'us-region': t('vault.autoCreateKeyLimitScopeUsRegion'),
      'account-or-subuser': t('vault.autoCreateKeyLimitScopeAccountOrSubuser'),
    };
    const scope = scopeLabels[limit.scope] || limit.scope;
    if (limit.kind === 'observed') return t('vault.autoCreateKeyLimitObserved', { max: limit.max, scope });
    if (limit.kind === 'default') return t('vault.autoCreateKeyLimitDefault', { max: limit.max, scope });
    return t('vault.autoCreateKeyLimitHard', { max: limit.max, scope });
  }

  function selectManualMode() {
    setShowAutoCreate(false);
    setAutoError('');
    setLoginHandoff(null);
  }

  function selectAutoMode() {
    setShowAutoCreate(true);
    setAutoError('');
    setLoginHandoff(null);
  }

  return (
    <div className="auth-overlay vault-form-overlay" style={{ display: '' }} role="presentation">
      <div className="vault-form-panel vault-entry-card" role="dialog" aria-modal="true" aria-labelledby="vault-entry-title">
        <button className="vault-entry-close" onClick={onClose} type="button" aria-label={t('common.close')}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l10 10M14 4L4 14" />
          </svg>
        </button>

        <div className="vault-entry-workspace">
          <header className="vault-entry-header">
            <div>
              <h2 id="vault-entry-title">{isEdit ? t('vault.editKey') : t('vault.newKey')}</h2>
            </div>
          </header>

          {!isEdit && (
            <div className="vault-entry-modes" role="tablist" aria-label={t('vault.addMode')}>
              <button className={!showAutoCreate ? 'is-active' : ''} onClick={selectManualMode} type="button" role="tab" aria-selected={!showAutoCreate}>
                <span className="vault-entry-mode-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14.5h12M5 11.5l7.8-7.8 1.5 1.5L6.5 13H5v-1.5z" /></svg>
                </span>
                <strong>{t('vault.manualMode')}</strong>
              </button>
              <button className={showAutoCreate ? 'is-active' : ''} onClick={selectAutoMode} type="button" role="tab" aria-selected={showAutoCreate}>
                <span className="vault-entry-mode-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 2.5L4 10h5l-1 5.5L14 8h-5l1.5-5.5z" /></svg>
                </span>
                <strong>{t('vault.autoMode')}</strong>
              </button>
            </div>
          )}

          <div className="vault-form-body">
            {autoNotice && <p className="vault-auto-create-notice" role="status">{autoNotice}</p>}

            {showAutoCreate && !isEdit ? (
              <div className="vault-auto-create-panel" role="tabpanel">
                <div className="vault-form-field">
                  <div className="vault-field-heading">
                    <label>{t('vault.autoCreatePlatform')}</label>
                  </div>
                  <CustomSelect
                    value={autoPlatform}
                    onChange={handleAutoPlatformChange}
                    disabled={autoCreating || Boolean(autoRunId)}
                    placeholder={loadingPlatforms ? t('common.loading') : t('vault.autoCreateSelectPlatform')}
                    options={autoPlatforms.map(p => ({
                      value: p.id,
                      label: `${p.label}${p.mode === 'api' ? ' (API)' : ` (${t('vault.browserMode')})`}`,
                    }))}
                  />
                  {selectedPlatform?.permissionNote === 'volcengine-identity' && (
                    <small className="vault-field-hint">{t('vault.autoCreateVolcenginePermissionHint')}</small>
                  )}
                  {selectedPlatform?.permissionNote === 'openrouter-management' && (
                    <small className="vault-field-hint">{t('vault.autoCreateOpenRouterManagementHint')}</small>
                  )}
                  {selectedPlatform?.keyLimits?.length ? (
                    <small className="vault-field-hint">
                      {t('vault.autoCreateKeyLimitHint', { limits: selectedPlatform.keyLimits.map(formatKeyLimit).join('；') })}
                    </small>
                  ) : null}
                </div>
                <div className="vault-form-field">
                  <div className="vault-field-heading">
                    <label htmlFor="vault-auto-key-name">{t('vault.keyNameLabel')}</label>
                  </div>
                  <input id="vault-auto-key-name" type="text" className="vault-input" placeholder={selectedPlatform ? t('vault.autoCreateKeyExample', { name: selectedPlatform.defaultKeyName || selectedPlatform.keyHint }) : t('vault.keyExample')} value={formKey} onChange={e => setFormKey(e.target.value)} />
                </div>
                <div className="vault-form-field">
                  <div className="vault-field-heading"><label htmlFor="vault-auto-key-desc">{t('vault.descriptionLabel')}</label></div>
                  <input id="vault-auto-key-desc" type="text" className="vault-input" maxLength={120} placeholder={t('vault.descriptionPlaceholder')} value={formDesc} onChange={e => setFormDesc(e.target.value)} />
                </div>
                {selectedPlatform?.mode === 'api' && (
                  <div className="vault-form-field">
                    <div className="vault-field-heading"><label htmlFor="vault-parent-token">{t('vault.autoCreateParentToken')}</label></div>
                    <input id="vault-parent-token" type="password" className="vault-input" placeholder={t('vault.autoCreateParentTokenHint')} value={parentToken} onChange={e => setParentToken(e.target.value)} />
                    <small className="vault-field-hint">{t('vault.parentTokenPermissionHint')}</small>
                  </div>
                )}
                {selectedPlatform?.mode === 'browser' && <p className="vault-auto-create-hint">{t('vault.autoCreateBrowserHint')}</p>}
                {verificationHandoff && (
                  <div className="vault-auto-create-login" role="alert">
                    <strong>{t('vault.autoCreateVerificationRequired')}: {verificationHandoff.platformLabel}</strong>
                    <p>{verificationHandoff.browserFocused ? t('vault.autoCreateVerificationFocused') : t('vault.autoCreateVerificationOpenBrowser')}</p>
                    <button className="btn-save" onClick={handleResumeAutoCreate} disabled={autoCreating} type="button">
                      {autoCreating ? t('vault.autoCreating') : t('vault.autoCreateVerificationContinue')}
                    </button>
                  </div>
                )}
                {loginHandoff && (
                  <div className="vault-auto-create-login" role="alert">
                    <strong>{t('vault.autoCreateLoginRequired')}: {loginHandoff.platformLabel}</strong>
                    <p>{loginHandoff.browserFocused ? t('vault.autoCreateLoginFocused') : t('vault.autoCreateLoginOpenBrowser')}</p>
                    {loginHandoff.loginUrl && <span className="vault-auto-create-login-url">{loginHandoff.loginUrl}</span>}
                    <button className="btn-save" onClick={handleAutoCreate} disabled={autoCreating} type="button">{t('vault.autoCreateRetry')}</button>
                  </div>
                )}
                {autoError && <p className="vault-auto-create-error" role="alert">{autoError}</p>}
                <div className="vault-auto-create-actions">
                  <button className="btn-save vault-auto-create-primary" onClick={handleAutoCreate} disabled={autoCreating || Boolean(autoRunId) || loadingPlatforms || !autoPlatform} type="button">
                    {autoCreating ? t('vault.autoCreating') : t('vault.autoCreateStart')}
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 7.5h9M8.5 4l3.5 3.5L8.5 11" /></svg>
                  </button>
                </div>
              </div>
            ) : (
              <div className="vault-entry-manual" role="tabpanel">
                <div className="vault-entry-field-grid">
                  <div className="vault-form-field">
                    <div className="vault-field-heading"><label htmlFor="vault-key-name">{t('vault.keyNameLabel')}</label></div>
                    <input id="vault-key-name" type="text" className="vault-input" placeholder={t('vault.keyExample')} value={formKey} onChange={e => setFormKey(e.target.value)} autoFocus={!isEdit} />
                  </div>
                  <div className="vault-form-field">
                    <div className="vault-field-heading"><label>{t('common.group')}</label></div>
                    <CustomSelect
                      value={formGroup}
                      onChange={v => setFormGroup(v)}
                      placeholder={t('common.selectGroup')}
                      options={[
                        { value: '__custom__', label: t('vault.newGroup') },
                        ...PREDEFINED_GROUPS.map(g => ({ value: g, label: g })),
                        ...[...new Set(groups.map(normalizeGroupName))]
                          .filter(g => g && !PREDEFINED_GROUPS.includes(g))
                          .map(g => ({ value: g, label: g })),
                      ]}
                    />
                    {formGroup === '__custom__' && <input type="text" className="vault-input vault-custom-group-input" placeholder={t('common.enterGroup')} value={formGroupCustom} onChange={e => setFormGroupCustom(e.target.value)} />}
                  </div>
                </div>
                <div className="vault-form-field vault-form-field--description">
                  <div className="vault-field-heading"><label htmlFor="vault-key-desc">{t('vault.descriptionLabel')}</label></div>
                  <input id="vault-key-desc" type="text" className="vault-input" maxLength={120} placeholder={t('vault.descriptionPlaceholder')} value={formDesc} onChange={e => setFormDesc(e.target.value)} />
                </div>
                <div className="vault-form-field vault-form-field--value">
                  <div className="vault-field-heading"><label htmlFor="vault-secret-value">{t('vault.secretValueLabel')}</label></div>
                  <div className="vault-secret-input-wrap">
                    <input id="vault-secret-value" type={showValue ? 'text' : 'password'} className="vault-input" placeholder={loadingValue ? t('common.loading') : t('vault.keyValue')} value={formValue} onChange={e => setFormValue(e.target.value)} disabled={loadingValue} />
                    <button type="button" className="btn-toggle-vis" onClick={() => setShowValue(!showValue)} aria-label={showValue ? t('common.hide') : t('common.show')}>{showValue ? t('common.hide') : t('common.show')}</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="vault-form-actions">
            <div className="vault-entry-security-inline">
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 2.5l5 2v3.8c0 3.2-2.1 5.8-5 7.2-2.9-1.4-5-4-5-7.2V4.5l5-2z" /><path d="M6.8 9l1.4 1.4 3-3" />
              </svg>
              <div><strong>{t('vault.securityTitle')}</strong><span>{t('vault.securityDesc')}</span></div>
            </div>
            <div className="vault-entry-action-buttons">
              {saveError && <span className="vault-save-error" role="alert">{saveError}</span>}
              <button className="btn-cancel" onClick={onClose} type="button">{t('common.cancel')}</button>
              {(!showAutoCreate || isEdit) && <button className="btn-save" onClick={handleSave} disabled={saving || loadingValue || !formKey || !formValue} type="button">{saving ? t('common.saving') : (isEdit ? t('vault.saveChanges') : t('vault.saveKey'))}</button>}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
