import React, { useEffect, useState } from 'react';
import { getSettings, updateSettings, testPlatform } from '../../api/settings';
import { listVault } from '../../api/vault';
import {
  getSyncOverview, enableLanSync, disableLanSync, regenerateLanToken, pairLanDevice, createLanPairing, getLanPairing,
  type SyncOverview, type LanPairingSession,
} from '../../api/sync';
import { PLATFORM_FIELDS, PLATFORM_IDS, PLATFORM_DOCS } from '../../lib/constants';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import VaultFormModal from '../shared/VaultFormModal';
import VaultPickerModal from '../shared/VaultPickerModal';
import CustomSelect from '../shared/CustomSelect';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Clock3, Cloud, Copy, FileText, KeyRound, Link2, Monitor, MoreHorizontal, Plus, PlugZap, QrCode, RefreshCw, X } from 'lucide-react';
import { useTransientFeedback } from '../../hooks/useTransientFeedback';

const VAULT_REF_FIELDS = new Set([
  'apiToken',
  'storeId',
  'projectId',
  'apiKey',
  'r2AccessKeyId',
  'r2SecretAccessKey',
  'accessKey',
  'secretKey',
]);
// Secret-looking fields that hold a literal value (the lan pairing token),
// not a vault reference — render as plain inputs instead of the vault picker.
const PLAIN_SECRET_FIELDS = new Set(['token']);

const PLATFORM_FIELD_LABELS: Record<string, string> = {
  apiToken: 'settings.sync2.field.apiToken',
  storeId: 'settings.sync2.field.storeId',
  accountId: 'settings.sync2.field.accountId',
  r2AccessKeyId: 'settings.sync2.field.r2AccessKeyId',
  r2SecretAccessKey: 'settings.sync2.field.r2SecretAccessKey',
  accessKey: 'settings.sync2.field.accessKey',
  secretKey: 'settings.sync2.field.secretKey',
  projectId: 'settings.sync2.field.projectId',
  apiKey: 'settings.sync2.field.apiKey',
  url: 'settings.sync2.field.url',
  username: 'settings.sync2.field.username',
  password: 'settings.sync2.field.password',
};

function platformSummaryValue(platform: Record<string, any>, fallback: string) {
  return typeof platform.url === 'string' && /^https?:\/\//i.test(platform.url)
    ? platform.url
    : fallback;
}

function lastSeenLabel(iso: string, t: (key: string, params?: any) => string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t('settings.sync2.lastSeenJustNow');
  if (mins < 60) return t('settings.sync2.lastSeenMin', { n: mins });
  return t('settings.sync2.lastSeenHour', { n: Math.floor(mins / 60) });
}

export default function DeviceSyncSection() {
  const { showToast, confirm } = useApp() as any;
  const { t, lang } = useI18n();

  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [platforms, setPlatforms] = useState<Record<string, any>>({});
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [autoSync, setAutoSync] = useState(false);
  const [syncPassword, setSyncPassword] = useState('');

  // Panels: add-device dialog + collapsibles (collapsed by default)

  // Platform card interactions
  const [testingPlatform, setTestingPlatform] = useState<string | null>(null);
  const [docPlatform, setDocPlatform] = useState<string | null>(null);
  const [vaultTarget, setVaultTarget] = useState<{ platId: string; field: string } | null>(null);
  const [showVaultPicker, setShowVaultPicker] = useState(false);
  const [vaultFormVisible, setVaultFormVisible] = useState(false);
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(new Set());

  // LAN pairing — everything lives in the add-device dialog (choice → primary
  // generates a code / join pastes one); the section body stays minimal.
  const [lanBusy, setLanBusy] = useState<'enable' | 'pairing' | 'pair' | null>(null);
  const [lanPairCode, setLanPairCode] = useState('');
  const [lanModalOpen, setLanModalOpen] = useState(false);
  const [lanModalStep, setLanModalStep] = useState<'choice' | 'primary' | 'join'>('choice');
  const [pairing, setPairing] = useState<LanPairingSession | null>(null);
  const [pairingDone, setPairingDone] = useState(false);
  const [lanCodeAddress, setLanCodeAddress] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());
  const { activeKey: copiedItem, showFeedback: showCopied } = useTransientFeedback();

  useEffect(() => { loadData(); }, []);

  // Keep the overview (device online status, last sync) fresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await getSyncOverview();
        if (!cancelled) setOverview(data);
      } catch { /* server unreachable; keep last known state */ }
      if (!cancelled) timer = setTimeout(tick, 60_000);
    };
    timer = setTimeout(tick, 60_000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  async function loadData() {
    try {
      const [overviewData, settingsData, vaultData] = await Promise.all([getSyncOverview(), getSettings(), listVault()]);
      setOverview(overviewData);
      const s = settingsData as any;
      setAutoSync(!!s.sync?.autoSync);
      if (s.sync?.password && s.sync.password !== '***') setSyncPassword(s.sync.password);
      setPlatforms(s.sync?.platforms || {});
      setVaultKeys((vaultData.secrets || []).map((sec: any) => sec.key).filter(Boolean));
    } catch { /* surfaced by connection status elsewhere */ }
  }

  async function refreshOverview() {
    try { setOverview(await getSyncOverview()); } catch { /* keep last known state */ }
  }

  async function saveSync(newPlatforms?: typeof platforms, newAutoSync?: boolean, password?: string) {
    try {
      await updateSettings({
        sync: {
          autoSync: newAutoSync !== undefined ? newAutoSync : autoSync,
          platforms: newPlatforms || platforms,
          ...(password ? { password } : {}),
        },
      });
    } catch { showToast(t('settings.saveFail'), 'error'); }
  }

  // --- Password (set-once flow: prominent until set, then in More Actions) ---
  async function savePassword() {
    if (!syncPassword) return;
    await saveSync(undefined, undefined, syncPassword);
    showToast(t('settings.keyAdded'));
    await refreshOverview();
  }

  // --- Devices --------------------------------------------------------------
  async function generatePairing(silent = false) {
    setLanBusy('pairing');
    try {
      const session = await createLanPairing();
      setPairing(session);
      setPairingDone(false);
      setLanCodeAddress('');
    } catch (e: any) {
      if (!silent) showToast(e.message || t('settings.lanPairFail'), 'error');
    } finally { setLanBusy(null); }
  }

  function openLanModal() {
    setLanModalStep('choice');
    setPairingDone(false);
    setLanModalOpen(true);
  }

  function closeLanModal() {
    setLanModalOpen(false);
    setPairing(null);
    setPairingDone(false);
    setLanPairCode('');
  }

  // "Connect existing devices" — this machine is the primary. Enable the
  // listener behind the scenes if needed, then hand out a fresh pairing code.
  async function choosePrimary() {
    setLanModalStep('primary');
    if (overview?.lan.enabled) {
      generatePairing();
      return;
    }
    if (!syncPassword && !overview?.hasPassword) { showToast(t('settings.setSyncPwd'), 'error'); return; }
    setLanBusy('enable');
    try {
      if (syncPassword) await saveSync(undefined, undefined, syncPassword);
      const status = await enableLanSync();
      await Promise.all([refreshOverview(), loadData()]);
      if (!status.running) {
        showToast(status.error || t('settings.lanPairCodeEmpty'), 'error');
        return;
      }
      await generatePairing(true);
    } catch (e: any) {
      showToast(e.message || t('settings.lanEnableFail'), 'error');
    } finally { setLanBusy(null); }
  }

  // Countdown ticker while a pairing session is live in the dialog.
  useEffect(() => {
    if (!lanModalOpen || lanModalStep !== 'primary' || !pairing) return;
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lanModalOpen, lanModalStep, pairing]);

  // Poll the pairing session: once the spoke redeems the code the session is
  // gone — celebrate and close the dialog automatically.
  useEffect(() => {
    if (!lanModalOpen || lanModalStep !== 'primary' || !pairing || pairingDone) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const peek = await getLanPairing();
        if (stopped || peek.active) return;
        stopped = true;
        setPairingDone(true);
        await Promise.all([refreshOverview(), loadData()]);
        setTimeout(() => closeLanModal(), 1200);
      } catch { /* transient poll failure; retry next tick */ }
    }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [lanModalOpen, lanModalStep, pairing, pairingDone]);

  async function handleLanDisable() {
    setLanBusy('enable');
    try {
      await disableLanSync();
      setPairing(null);
      showToast(t('settings.lanDisabled'));
      await Promise.all([refreshOverview(), loadData()]);
    } catch (e: any) {
      showToast(e.message || t('settings.lanEnableFail'), 'error');
    } finally { setLanBusy(null); }
  }

  async function handleLanResetToken() {
    const ok = await confirm(t('settings.lanConfirmResetToken'), { title: t('settings.lanResetToken'), type: 'warning' });
    if (!ok) return;
    try {
      await regenerateLanToken();
      setPairing(null);
      showToast(t('settings.lanTokenRegenerated'));
      await refreshOverview();
    } catch (e: any) {
      showToast(e.message || t('settings.lanResetToken'), 'error');
    }
  }

  async function handleLanPair() {
    const code = lanPairCode.trim();
    if (!code) { showToast(t('settings.lanPairCodeRequired'), 'error'); return; }
    if (!syncPassword && !overview?.hasPassword) { showToast(t('settings.setSyncPwd'), 'error'); return; }
    setLanBusy('pair');
    try {
      if (syncPassword) await saveSync(undefined, undefined, syncPassword);
      const data = await pairLanDevice(code);
      showToast(t('settings.lanPaired', { name: data.peerName }), 'success');
      setLanPairCode('');
      closeLanModal();
      await Promise.all([refreshOverview(), loadData()]);
    } catch (e: any) {
      showToast(e.message || t('settings.lanPairFail'), 'error');
    } finally { setLanBusy(null); }
  }

  async function copyInline(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showCopied(key);
    } catch {
      showToast(t('vault.copyFail'), 'error');
    }
  }

  async function handleDisconnectPeer() {
    const newPlatforms = { ...platforms, lan: { ...(platforms.lan || {}), enabled: false } };
    setPlatforms(newPlatforms);
    await saveSync(newPlatforms);
    showToast(t('settings.sync2.disconnected'));
    await Promise.all([refreshOverview(), loadData()]);
  }

  // --- Platform cards (cloud backup collapsible) -----------------------------
  function updatePlatform(id: string, field: string, value: any) {
    const newPlatforms = { ...platforms, [id]: { ...(platforms[id] || {}), [field]: value } };
    setPlatforms(newPlatforms);
    saveSync(newPlatforms);
  }

  async function handleTestPlatform(platformId: string) {
    setTestingPlatform(platformId);
    await saveSync();
    try {
      const data = await testPlatform(platformId);
      showToast(data.message || (data.success ? t('settings.connSuccess') : t('settings.connFail')), data.success ? 'success' : 'error');
      await refreshOverview();
    } catch { showToast(t('settings.testConnFail'), 'error'); } finally { setTestingPlatform(null); }
  }

  function handleAddPlatform(platId: string) {
    if (!platId) return;
    setExpandedPlatforms(previous => new Set(previous).add(platId));
    updatePlatform(platId, 'enabled', true);
  }

  function togglePlatformEditor(platId: string) {
    setExpandedPlatforms(previous => {
      const next = new Set(previous);
      if (next.has(platId)) next.delete(platId);
      else next.add(platId);
      return next;
    });
  }

  function handleVaultSaved(key: string) {
    if (!key) { showToast(t('settings.saveFail'), 'error'); return; }
    showToast(t('settings.keyAdded'));
    setVaultFormVisible(false);
    setVaultKeys(prev => [...prev, key]);
    if (vaultTarget) {
      updatePlatform(vaultTarget.platId, vaultTarget.field, key);
      setVaultTarget(null);
    }
  }

  // --- Derived ---------------------------------------------------------------
  const groups = [...new Set(vaultKeys.map(k => k.split('_')[0]).filter(Boolean))].sort();
  const lanCodes = pairing?.codes || [];
  const lanSelectedAddress = lanCodeAddress && lanCodes.some(c => c.address === lanCodeAddress)
    ? lanCodeAddress
    : (lanCodes[0]?.address || '');
  const lanSelectedCode = lanCodes.find(c => c.address === lanSelectedAddress)?.code || '';
  const pairingRemainingMs = pairing ? Math.max(0, new Date(pairing.expiresAt).getTime() - nowTs) : 0;
  const pairingExpired = !!pairing && pairingRemainingMs === 0;
  const remainingSecs = Math.ceil(pairingRemainingMs / 1000);
  const countdownLabel = `${Math.floor(remainingSecs / 60)}:${String(remainingSecs % 60).padStart(2, '0')}`;
  const platformEntries = Object.entries(PLATFORM_FIELDS).filter(([id]) => id !== 'lan');
  const activePlatformEntries = platformEntries.filter(([id]) => platforms[id]?.enabled);
  const inactivePlatformEntries = platformEntries.filter(([id]) => !platforms[id]?.enabled);
  const otherDeviceCount = (overview?.peer ? 1 : 0) + (overview?.devices.length || 0);
  const totalDeviceCount = otherDeviceCount + 1;
  const cloudCount = overview?.cloudPlatforms.length || 0;
  const isSpoke = overview?.machine.role === 'spoke';
  const lastSyncLabel = overview?.lastSyncAt
    ? new Date(overview.lastSyncAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
    : t('settings.neverSynced');

  return (
    <div className="settings-section devsync" id="sync">
      <header className="devsync-page-header">
        <div className="devsync-page-heading">
          <span className="devsync-eyebrow"><RefreshCw size={14} />{t('settings.sync2.title')}</span>
          <h2>{t('settings.sync2.title')}</h2>
          <p>{t('settings.sync2.description')}</p>
        </div>
        <div className="devsync-autosync-control">
          <span className="devsync-autosync-copy">
            <strong>{t('settings.autoSync')}</strong>
            <small>{t(autoSync ? 'settings.sync2.autoSyncOn' : 'settings.sync2.autoSyncOff')}</small>
          </span>
          <label className="settings-toggle" aria-label={t('settings.autoSync')}>
            <input
              type="checkbox"
              checked={autoSync}
              aria-label={t('settings.autoSync')}
              onChange={e => { setAutoSync(e.target.checked); saveSync(undefined, e.target.checked); }}
            />
            <span className="settings-toggle-slider" />
          </label>
        </div>
      </header>

      <section className="settings-card devsync-overview-card" aria-label={t('settings.sync2.statusTitle')}>
        <div className="devsync-overview-grid">
          <div className="devsync-overview-item">
            <span className="devsync-overview-icon"><Clock3 size={16} /></span>
            <span><small>{t('settings.lastSync')}</small><strong>{lastSyncLabel}</strong></span>
          </div>
          <div className="devsync-overview-item">
            <span className="devsync-overview-icon"><Monitor size={16} /></span>
            <span><small>{t('settings.sync2.devicesTitle')}</small><strong>{t('settings.sync2.otherDevices', { n: otherDeviceCount })}</strong></span>
          </div>
          <div className="devsync-overview-item">
            <span className="devsync-overview-icon"><Cloud size={16} /></span>
            <span><small>{t('settings.sync2.cloudBackup')}</small><strong>{t('settings.sync2.cloudTargets', { n: cloudCount })}</strong></span>
          </div>
        </div>
        {overview && !overview.hasPassword && (
          <div className="devsync-password-setup">
            <label htmlFor="devsync-password">{t('settings.syncPassword')}</label>
            <input id="devsync-password" type="password" className="settings-input" placeholder={t('settings.syncPasswordDesc')}
              value={syncPassword} onChange={e => { setSyncPassword(e.target.value); }}
              onBlur={savePassword} />
          </div>
        )}
      </section>

      <section className="settings-block devsync-section-block">
        <div className="settings-block-head devsync-section-head">
          <div className="devsync-section-title">
            <Monitor size={16} />
            <span className="settings-block-title">{t('settings.sync2.devicesTitle')}</span>
            <span className="devsync-count-badge">{totalDeviceCount}</span>
          </div>
          <div className="settings-block-head-controls">
            {overview?.lan.enabled && (
              <details className="devsync-more-menu">
                <summary aria-label={t('settings.sync2.advancedActions')} title={t('settings.sync2.advancedActions')}>
                  <MoreHorizontal size={17} />
                </summary>
                <div className="devsync-more-popover">
                  <span className="devsync-danger-title"><AlertTriangle size={12} />{t('settings.sync2.dangerActions')}</span>
                  <button type="button" className="is-danger" onClick={handleLanResetToken}>
                    <strong>{t('settings.lanResetToken')}</strong>
                    <small>{t('settings.lanResetTokenDesc')}</small>
                  </button>
                  <button type="button" className="is-danger" onClick={handleLanDisable} disabled={lanBusy === 'enable'}>
                    <strong>{lanBusy === 'enable' ? t('common.testing') : t('settings.lanCloseSync')}</strong>
                    <small>{t('settings.lanCloseSyncDesc')}</small>
                  </button>
                </div>
              </details>
            )}
            <button type="button" className="settings-test-btn devsync-add-button" onClick={openLanModal}>
              <Plus size={14} />{t('settings.sync2.addDevice')}
            </button>
          </div>
        </div>
        <div className="settings-card devsync-devices-card">
          <div className="devsync-devices">
            <div className="devsync-device devsync-device--self">
              <span className="devsync-device-icon"><Monitor size={15} /></span>
              <span className="devsync-device-name">
                <strong>{overview?.machine.name || t('settings.sync2.thisDevice')}</strong>
                <small>{overview?.machine.id || t('settings.sync2.thisDevice')}</small>
              </span>
              {overview?.machine.role === 'hub' && <span className="devsync-role">{t('settings.sync2.roleHub')}</span>}
              {isSpoke && <span className="devsync-role">{t('settings.sync2.roleSpoke')}</span>}
            </div>

            {overview?.peer && (
              <div className="devsync-device">
                <span className={`devsync-dot${overview.peer.online ? ' devsync-dot--on' : ''}`} />
                <span className="devsync-device-name">
                  <strong>{overview.peer.name || overview.peer.url}</strong>
                  <small>{overview.peer.url}</small>
                </span>
                <span className={`devsync-presence${overview.peer.online ? ' devsync-presence--on' : ''}`}>
                  {overview.peer.online ? t('settings.sync2.online') : t('settings.sync2.offline')}
                </span>
                <div className="devsync-device-actions">
                  <button className="settings-test-btn" onClick={() => handleTestPlatform('lan')} disabled={testingPlatform === 'lan'}>
                    {testingPlatform === 'lan' ? t('common.testing') : t('common.test')}
                  </button>
                  <button className="settings-test-btn" onClick={handleDisconnectPeer}>{t('settings.sync2.disconnect')}</button>
                </div>
              </div>
            )}

            {overview?.devices.map(device => (
              <div key={device.id} className="devsync-device">
                <span className={`devsync-dot${device.online ? ' devsync-dot--on' : ''}`} />
                <span className="devsync-device-name">
                  <strong>{device.name || device.id}</strong>
                  <small>{device.address} · {lastSeenLabel(device.lastSeen, t)}</small>
                </span>
                <span className={`devsync-presence${device.online ? ' devsync-presence--on' : ''}`}>
                  {device.online ? t('settings.sync2.online') : t('settings.sync2.offline')}
                </span>
              </div>
            ))}

            {otherDeviceCount === 0 && (
              <div className="devsync-no-devices">{t('settings.sync2.noOtherDevices')}</div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-block devsync-section-block">
        <div className="settings-block-head devsync-section-head">
          <div className="devsync-section-title">
            <Cloud size={16} />
            <span className="settings-block-title">{t('settings.sync2.cloudBackup')}</span>
            <span className="devsync-count-badge">{cloudCount}</span>
          </div>
          {inactivePlatformEntries.length > 0 && (
            <div className="settings-block-head-controls">
              <CustomSelect
                className="settings-select-wrap settings-add-platform-select"
                value=""
                onChange={handleAddPlatform}
                placeholder={t('settings.addPlatform')}
                options={inactivePlatformEntries.map(([id]: any) => ({ value: id, label: PLATFORM_IDS[id] || id }))}
              />
            </div>
          )}
        </div>
        <div className="settings-platforms devsync-platforms">
          {activePlatformEntries.length === 0 ? (
            <div className="settings-platforms-empty">{t('settings.noActivePlatform')}</div>
          ) : activePlatformEntries.map(([platId, fields]) => {
            const plat = platforms[platId] || {};
            const testing = testingPlatform === platId;
            const expanded = expandedPlatforms.has(platId);
            const platformName = PLATFORM_IDS[platId] || platId;
            return (
              <article key={platId} className={`settings-plat-card devsync-platform-card${expanded ? ' is-expanded' : ''}`}>
                <div className="devsync-platform-summary">
                  <span className="devsync-platform-icon"><Cloud size={16} /></span>
                  <div className="devsync-platform-copy">
                    <strong>{platformName}</strong>
                    <span><i />{t('common.enabled')} · {platformSummaryValue(plat, t('settings.sync2.platformConfigured'))}</span>
                  </div>
                  <div className="devsync-platform-actions">
                    <button
                      type="button"
                      className="settings-test-btn devsync-platform-test"
                      onClick={() => handleTestPlatform(platId)}
                      disabled={testing}
                    >
                      <PlugZap size={14} />{testing ? t('common.testing') : t('common.test')}
                    </button>
                    <button
                      type="button"
                      className="settings-test-btn devsync-platform-edit"
                      onClick={() => togglePlatformEditor(platId)}
                      aria-expanded={expanded}
                      aria-controls={`platform-editor-${platId}`}
                    >
                      {t(expanded ? 'settings.sync2.hideConfig' : 'settings.sync2.editConfig')}
                      <ChevronDown size={14} />
                    </button>
                    <label className="settings-toggle" title={`${platformName} · ${t('common.enabled')}`}>
                      <input
                        type="checkbox"
                        checked={!!plat.enabled}
                        aria-label={`${platformName} · ${t('common.enabled')}`}
                        onChange={e => { updatePlatform(platId, 'enabled', e.target.checked); }}
                      />
                      <span className="settings-toggle-slider" />
                    </label>
                  </div>
                </div>
                {expanded && fields.length > 0 && (
                  <div className="settings-plat-body devsync-platform-editor" id={`platform-editor-${platId}`}>
                    <div className="devsync-platform-editor-head">
                      <span>{t('settings.sync2.platformHelp')}</span>
                      <button className="devsync-doc-link" onClick={() => setDocPlatform(platId)}>
                        <FileText size={13} />{t('settings.configDocs')}
                      </button>
                    </div>
                    {fields.map(field => {
                      const isSecret = !PLAIN_SECRET_FIELDS.has(field) && (VAULT_REF_FIELDS.has(field) || (/ecret|oken|Key|Id$/i.test(field) && !/databaseId|bucketName|region/i.test(field)));
                      const fieldLabel = PLATFORM_FIELD_LABELS[field] ? t(PLATFORM_FIELD_LABELS[field]) : field;
                      return (
                        <div key={field} className={`settings-field${isSecret ? ' settings-field--secret' : ''}`}>
                          <label>{fieldLabel}</label>
                          {isSecret ? (
                            <div className="vault-ref-field">
                              {plat[field] ? (
                                <div className="vault-ref-selected">
                                  <span className="vault-ref-key">{plat[field]}</span>
                                  <button type="button" className="vault-ref-clear" onClick={() => updatePlatform(platId, field, '')}>×</button>
                                  <button type="button" className="vault-ref-change" onClick={() => { setVaultTarget({ platId, field }); setShowVaultPicker(true); }}>{t('common.replace')}</button>
                                </div>
                              ) : (
                                <button type="button" className="vault-ref-trigger" onClick={() => { setVaultTarget({ platId, field }); setShowVaultPicker(true); }}>{t('tools.selectFromVault')}</button>
                              )}
                            </div>
                          ) : (
                            <input
                              type={field === 'password' ? 'password' : 'text'}
                              className="settings-input"
                              value={plat[field] || ''}
                              aria-label={fieldLabel}
                              placeholder={fieldLabel}
                              onChange={e => updatePlatform(platId, field, e.target.value)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {/* Add Device dialog — choice first, then generate (primary) or paste
          (join). Everything pairing-related lives here, never in the section. */}
      {lanModalOpen && (
        <div className="auth-overlay" style={{ display: '' }} onClick={e => { if (e.target === e.currentTarget) closeLanModal(); }}>
          <div className="confirm-panel lan-modal" role="dialog" aria-modal="true" aria-labelledby="lan-modal-title" aria-describedby="lan-modal-desc">
            <header className="lan-modal-header">
              <span className="lan-modal-header-icon"><Link2 size={18} /></span>
              <div>
                <h3 id="lan-modal-title">{t('settings.sync2.addDevice')}</h3>
                <p id="lan-modal-desc">{t('settings.lanModalDesc')}</p>
              </div>
              <button className="lan-modal-close" onClick={closeLanModal} aria-label={t('common.close')} title={t('common.close')}>
                <X size={17} />
              </button>
            </header>
            <div className="lan-modal-body">
              {lanModalStep === 'choice' && (
                <div className="lan-choice-grid">
                  <button type="button" className="lan-choice" onClick={choosePrimary} disabled={lanBusy === 'enable'}>
                    <span className="lan-choice-icon"><QrCode size={19} /></span>
                    <span className="lan-choice-copy">
                      <small>{t('settings.lanChoiceOldTag')}</small>
                      <strong>{t('settings.lanChoiceOld')}</strong>
                      <span>{t('settings.lanChoiceOldDesc')}</span>
                    </span>
                    <ArrowRight className="lan-choice-arrow" size={17} />
                  </button>
                  <button type="button" className="lan-choice" onClick={() => setLanModalStep('join')}>
                    <span className="lan-choice-icon"><KeyRound size={19} /></span>
                    <span className="lan-choice-copy">
                      <small>{t('settings.lanChoiceNewTag')}</small>
                      <strong>{t('settings.lanChoiceNew')}</strong>
                      <span>{t('settings.lanChoiceNewDesc')}</span>
                    </span>
                    <ArrowRight className="lan-choice-arrow" size={17} />
                  </button>
                </div>
              )}

              {lanModalStep === 'primary' && (
                <div className="lan-step">
                  <button type="button" className="lan-back" onClick={() => { setLanModalStep('choice'); setPairing(null); }}>
                    <ArrowLeft size={14} />{t('settings.lanBack')}
                  </button>
                  <div className="lan-step-heading">
                    <span><QrCode size={18} /></span>
                    <div><h4>{t('settings.lanPrimaryTitle')}</h4><p>{t('settings.lanPrimaryDesc')}</p></div>
                  </div>
                  {pairingDone ? (
                    <div className="lan-pair-success"><CheckCircle2 size={20} />{t('settings.lanPairedSuccess')}</div>
                  ) : (
                    <>
                      {overview && overview.lan.enabled && !overview.lan.running && (
                        <div className="lan-modal-error">{overview.lan.error || t('settings.lanPairCodeEmpty')}</div>
                      )}
                      {pairing && !pairingExpired ? (
                        <div className="lan-code-card">
                          <div className="lan-code-card-head">
                            <span>{t('settings.lanPairCode')}</span>
                            <strong>{t('settings.lanCodeExpiresIn', { time: countdownLabel })}</strong>
                          </div>
                          <div className="lan-code-value devsync-code-value">
                            <span className="lan-code-text" title={lanSelectedCode}>{lanSelectedCode}</span>
                            <button
                              className={`lan-code-copy${copiedItem === 'pairing-code' ? ' is-copied' : ''}`}
                              onClick={() => copyInline('pairing-code', lanSelectedCode)}
                              title={copiedItem === 'pairing-code' ? t('common.copied') : t('vault.copy')}
                              aria-label={copiedItem === 'pairing-code' ? t('common.copied') : t('vault.copy')}
                            >
                              {copiedItem === 'pairing-code' ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                          {lanCodes.length > 1 && (
                            <div className="lan-address-row">
                              <CustomSelect
                                className="settings-select-wrap lan-address-select"
                                value={lanSelectedAddress}
                                onChange={(v: string) => setLanCodeAddress(v)}
                                options={lanCodes.map(c => ({ value: c.address, label: c.address }))}
                              />
                            </div>
                          )}
                          <p>{t('settings.lanCodeUseHint')}</p>
                        </div>
                      ) : (
                        pairingExpired && <div className="lan-modal-countdown lan-modal-countdown--expired">{t('settings.lanCodeExpired')}</div>
                      )}
                      <div className="lan-modal-actions">
                        <button className="lan-primary-action" onClick={() => generatePairing()} disabled={lanBusy === 'pairing' || lanBusy === 'enable'}>
                          {lanBusy === 'pairing' || lanBusy === 'enable'
                            ? t('common.testing')
                            : (pairing && !pairingExpired ? t('settings.lanRegenCode') : t('settings.lanGenCode'))}
                        </button>
                      </div>
                      <div className="lan-hint">{t('settings.lanPasswordHint')}</div>
                    </>
                  )}
                </div>
              )}

              {lanModalStep === 'join' && (
                <div className="lan-step">
                  <button type="button" className="lan-back" onClick={() => setLanModalStep('choice')}>
                    <ArrowLeft size={14} />{t('settings.lanBack')}
                  </button>
                  <div className="lan-step-heading">
                    <span><KeyRound size={18} /></span>
                    <div><h4>{t('settings.lanJoinTitle')}</h4><p>{t('settings.lanJoinDesc')}</p></div>
                  </div>
                  <div className="lan-join-form">
                    <label htmlFor="lan-pair-code">{t('settings.lanPairCode')}</label>
                    <input id="lan-pair-code" type="text" className="settings-input" placeholder={t('settings.lanPairPlaceholder')}
                      value={lanPairCode} onChange={e => setLanPairCode(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleLanPair(); }} />
                    <button className="lan-primary-action" onClick={handleLanPair} disabled={lanBusy === 'pair'}>
                      {lanBusy === 'pair' ? t('settings.lanPairing') : t('settings.lanConnect')}
                    </button>
                  </div>
                  <div className="lan-hint">{t('settings.lanPasswordHint')}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Vault Quick Add Modal */}
      {vaultFormVisible && (
        <VaultFormModal
          groups={groups}
          onClose={() => { setVaultFormVisible(false); setVaultTarget(null); }}
          onSaved={handleVaultSaved}
        />
      )}

      {/* Vault Picker Modal */}
      {showVaultPicker && (
        <VaultPickerModal
          selected={vaultTarget ? platforms[vaultTarget.platId]?.[vaultTarget.field] || '' : ''}
          onSelect={key => {
            if (vaultTarget) {
              updatePlatform(vaultTarget.platId, vaultTarget.field, key);
            }
            setShowVaultPicker(false);
          }}
          onClose={() => { setShowVaultPicker(false); setVaultTarget(null); }}
        />
      )}

      {/* Platform Doc Modal */}
      {docPlatform && PLATFORM_DOCS[docPlatform] && (() => {
        const doc = PLATFORM_DOCS[docPlatform];
        function renderStep(text: string, links?: Record<string, string>) {
          if (!links) return text;
          let parts: (string | React.ReactNode)[] = [text];
          for (const [label, url] of Object.entries(links)) {
            const next: (string | React.ReactNode)[] = [];
            for (const part of parts) {
              if (typeof part !== 'string') { next.push(part); continue; }
              const idx = part.indexOf(label);
              if (idx < 0) { next.push(part); continue; }
              next.push(part.slice(0, idx));
              next.push(<a key={label} href={url} target="_blank" rel="noopener noreferrer" className="platdoc-inline-link">{label}</a>);
              next.push(part.slice(idx + label.length));
            }
            parts = next;
          }
          return parts;
        }
        return (
          <div className="auth-overlay" style={{ display: '' }}>
            <div className="confirm-panel platdoc-panel" style={{ maxWidth: 680, textAlign: 'left' }}>
              <div className="progress-header">
                <span className="progress-title">{t('settings.configGuide', { platform: PLATFORM_IDS[docPlatform] || docPlatform })}</span>
                <button className="progress-close" onClick={() => setDocPlatform(null)}>&times;</button>
              </div>
              <div className="platdoc-body">
                <div className="platdoc-section">
                  <div className="platdoc-section-title">{t('settings.configSteps')}</div>
                  <ol className="platdoc-steps">
                    {doc.steps.map((step, i) => <li key={i}>{renderStep(step.text, step.links)}</li>)}
                  </ol>
                </div>
                {Object.keys(doc.fields).length > 0 && (
                  <div className="platdoc-section">
                    <div className="platdoc-section-title">{t('settings.fieldDesc')}</div>
                    <div className="platdoc-fields">
                      {Object.entries(doc.fields).map(([key, f]) => (
                        <div key={key} className="platdoc-field">
                          <span className="platdoc-field-label">{f.label}</span>
                          <span className="platdoc-field-hint">{f.hint}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {doc.code && (
                  <div className="platdoc-section">
                    <div className="platdoc-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{doc.code.title}</span>
                      <button
                        className={`settings-vault-new-btn${copiedItem === `sql:${docPlatform}` ? ' is-copied' : ''}`}
                        style={{ minWidth: 64, fontSize: 11 }}
                        onClick={() => copyInline(`sql:${docPlatform}`, doc.code!.sql)}
                      >
                        {copiedItem === `sql:${docPlatform}` ? t('common.copied') : t('vault.copy')}
                      </button>
                    </div>
                    <pre className="platdoc-code">{doc.code.sql}</pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
