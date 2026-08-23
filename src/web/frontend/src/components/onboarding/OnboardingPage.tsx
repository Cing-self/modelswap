import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getOnboarding, dismissOnboarding, resetOnboarding } from '../../api/settings';
import { setVault, scanAgentKeys, importAgentKeys, AgentKeyFinding } from '../../api/vault';
import { getAdapters, listProviders, updateProvider, addHomeProvider } from '../../api/providers';
import { getAgentIcon, getAgentIconClass } from '../../assets/agents';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import okitIcon from '../../assets/branding/okit-icon-command-v1.png';
import { setOnboardingDone } from '../../lib/onboardingGate';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';

const STEPS = 4; // detect → keys → platform → done

// First-entry initialization wizard — a full-screen, dark-editorial,
// step-by-step flow. Shown only until onboardingDone is set.
export default function OnboardingPage({ onComplete }: { onComplete?: () => void } = {}) {
  const { showToast, setConnectionStatus } = useApp();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [installedAgents, setInstalledAgents] = useState<{ id: string; name: string }[]>([]);
  const [findings, setFindings] = useState<AgentKeyFinding[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  // Optional step 3: pick a provider, enter its API key, bind them.
  const [providers, setProviders] = useState<{ id: string; name: string; hasKey: boolean }[]>([]);
  const [platformQuery, setPlatformQuery] = useState('');
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [configuredIds, setConfiguredIds] = useState<Set<string>>(new Set());
  // Config entries in agent files that OKIT doesn't show on the home page
  // yet — offered for adoption so they appear under AGENT 配置 immediately.
  const [externalSites, setExternalSites] = useState<{ agentId: string; agentName: string; providerId: string; providerName: string }[]>([]);
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set());
  const [adopting, setAdopting] = useState(false);
  const [adoptedCount, setAdoptedCount] = useState(0);
  const [adoptedIds, setAdoptedIds] = useState<Set<string>>(new Set());
  const [exiting, setExiting] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { check(); }, []);
  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  // Staged scan so the process is PERCEIVABLE: each phase runs sequentially,
  // gets a checkmark, and holds for a beat (local APIs answer in ms — without
  // the pacing the "scan" flashes by and the results just pop in).
  const [phase, setPhase] = useState(0); // 0 agents · 1 configs+keys · 2 done

  const holdFor = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function check() {
    setPhase(0);
    setScanning(true);
    try {
      // Phase 1: installed agents
      const startedAt = Date.now();
      const [onboardData, adaptersData, providersData] = await Promise.all([
        getOnboarding(), getAdapters(), listProviders(),
      ]);
      setInstalledAgents(
        (adaptersData.adapters || []).filter((a: any) => a.installed)
          .map((a: any) => ({ id: a.id, name: a.name })),
      );
      const sites: { agentId: string; agentName: string; providerId: string; providerName: string }[] = [];
      for (const a of (adaptersData.adapters || [])) {
        for (const x of (a.externalSites || [])) {
          if (x.known) sites.push({ agentId: a.id, agentName: a.name, providerId: x.id, providerName: x.name });
        }
      }
      setExternalSites(sites);
      setSelectedSites(new Set(sites.map(x => `${x.agentId}|${x.providerId}`)));
      setProviders(
        (providersData.providers || [])
          .filter((p: any) => !['anthropic-agent', 'openai-codex'].includes(p.id))
          .sort((a: any, b: any) => (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN'))
          .map((p: any) => ({ id: p.id, name: p.name, hasKey: !!p.vaultKey })),
      );
      await holdFor(Math.max(0, 750 - (Date.now() - startedAt)));
      setPhase(1);
      // Phase 2: config files + keys
      const t2 = Date.now();
      const keyData = await scanAgentKeys();
      const unmanaged = (keyData.findings || []).filter((f: AgentKeyFinding) => !f.inVault);
      setFindings(unmanaged);
      setSelectedKeys(new Set(unmanaged.filter(f => f.model).map(f => `${f.agentId}|${f.file}|${f.path}`)));
      if ((onboardData as any).done) setDismissed(true);
      setConnectionStatus('connected');
      await holdFor(Math.max(0, 750 - (Date.now() - t2)));
      setPhase(2);
    } catch { setConnectionStatus('error'); setPhase(2); }
    finally { setScanning(false); }
  }

  const idOf = (f: AgentKeyFinding) => `${f.agentId}|${f.file}|${f.path}`;
  const agentName = (id: string) => installedAgents.find(a => a.id === id)?.name || id;

  async function adoptSelected() {
    if (adopting) return;
    setAdopting(true);
    let ok = 0;
    try {
      for (const x of externalSites) {
        const id = `${x.agentId}|${x.providerId}`;
        if (!selectedSites.has(id) || adoptedIds.has(id)) continue;
        try { await addHomeProvider(x.agentId, x.providerId); ok++; setAdoptedIds(prev => new Set(prev).add(id)); }
        catch { /* individual failure doesn't block the rest */ }
      }
      if (ok > 0) showToast(t('onboarding.adoptDone', { count: ok }), 'success');
    } finally {
      setAdopting(false);
    }
  }

  // Suggested vault key name for a provider (ANTHROPIC_API_KEY style).
  const suggestKeyName = (providerId: string) =>
    providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_API_KEY';

  async function savePlatformKey(p: { id: string; name: string }) {
    if (keySaving) return;
    const name = (keyName || suggestKeyName(p.id)).trim();
    if (!name || !keyValue.trim()) {
      showToast(t('onboarding.fillAll'), 'error');
      return;
    }
    setKeySaving(true);
    try {
      await setVault({ key: name, value: keyValue.trim(), desc: `${p.name}（初始化配置）`, group: '初始化配置' });
      await updateProvider(p.id, { vaultKey: name });
      setConfiguredIds(prev => new Set(prev).add(p.id));
      setActiveProviderId(null);
      setKeyName('');
      setKeyValue('');
      showToast(t('onboarding.platformSaved', { name: p.name }), 'success');
      setProviders(prev => prev.map(x => x.id === p.id ? { ...x, hasKey: true } : x));
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setKeySaving(false);
    }
  }

  async function importSelected() {
    if (importing) return;
    setImporting(true);
    try {
      const items = findings.filter(f => f.model && selectedKeys.has(idOf(f)))
        .map(f => ({ agentId: f.agentId, file: f.file, path: f.path }));
      const res = await importAgentKeys(items);
      setImportedCount(prev => prev + res.created.length);
      showToast(t('onboarding.importDone', { count: res.created.length }), 'success');
      const keyData = await scanAgentKeys();
      setFindings((keyData.findings || []).filter((f: AgentKeyFinding) => !f.inVault));
      setSelectedKeys(new Set());
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setImporting(false);
    }
  }

  // Final confirmation: persist the done flag, play the exit transition,
  // THEN flip the app gate and navigate — flipping earlier would remount this
  // page in route mode (still at /onboarding) and flash the "completed"
  // screen before the navigation lands.
  async function enterApp() {
    if (exiting) return;
    setExiting(true);
    try { await dismissOnboarding(); } catch { /* enter anyway */ }
    setOnboardingDone(true);
    exitTimer.current = setTimeout(() => {
      navigate('/');
      onComplete?.();
    }, 750);
  }

  async function handleReset() {
    try { await resetOnboarding(); } catch {}
    setOnboardingDone(false);
    setDismissed(false);
    setStep(0);
    check();
  }

  // Already completed once (manual revisit) — plain completed screen.
  if (dismissed && !exiting) {
    return (
      <main className="onboarding-page">
        <div id="quickStartEmpty" className="onboarding-complete">
          <div style={{ fontSize: 48, opacity: 0.15, marginBottom: 16 }}>&#10003;</div>
          <h1>{t('onboarding.completed')}</h1>
          <button className="btn-action" onClick={handleReset} style={{ fontSize: 13, padding: '8px 20px' }}>{t('onboarding.reconfigure')}</button>
        </div>
      </main>
    );
  }

  const pct = (step / (STEPS - 1)) * 100;

  return (
    <div className={`onboarding-wizard${exiting ? ' wiz-exit' : ''}`}>
      <div className="wiz-inner">
        {/* Brand + step indicator */}
        <div className="wiz-top">
          <div className="wiz-brand">
            <img src={okitIcon} alt="OKIT" />
            <span>OKIT</span>
          </div>
          <div className="wiz-progress">
            <span className="wiz-progress-label">{t('onboarding.initStep')} {step + 1}/{STEPS}</span>
            <div className="wiz-progress-track"><div className="wiz-progress-fill" style={{ width: `${pct}%` }} /></div>
          </div>
        </div>

        {/* Sliding step track */}
        <div className="wiz-track" style={{ transform: `translateX(-${step * (100 / STEPS)}%)` }}>
          {/* Step 1: staged scan → results */}
          <section className="wiz-step">
            {phase < 2 ? (
              <>
                <h1>{t('onboarding.scanningTitle')}</h1>
                <div className="wiz-scan-list">
                  <span className={`wiz-scan-row${phase > 0 ? ' done' : ' active'}`}>
                    {phase > 0 ? <span className="wiz-scan-check">✓</span> : <span className="wiz-spinner" />}
                    {t('onboarding.scanPhaseAgents')}
                    {phase > 0 && installedAgents.length > 0 && (
                      <em className="wiz-scan-count">{installedAgents.length}</em>
                    )}
                  </span>
                  <span className={`wiz-scan-row${phase === 1 ? ' active' : phase > 1 ? ' done' : ''}`}>
                    {phase > 1 ? <span className="wiz-scan-check">✓</span> : phase === 1 ? <span className="wiz-spinner" /> : <span className="wiz-scan-dot" />}
                    {t('onboarding.scanPhaseKeys')}
                  </span>
                </div>
              </>
            ) : (
              <>
                <h1>{t('onboarding.detectedTitle', { count: installedAgents.length })}</h1>
                <div className="onboarding-agent-chips">
                  {installedAgents.map((a, i) => {
                    const icon = getAgentIcon(a.id);
                    return (
                      <span key={a.id} className="onboarding-agent-chip" style={{ animationDelay: `${i * 40}ms` }}>
                        {icon ? <img src={icon} alt="" className={getAgentIconClass(a.id) || ''} /> : null}
                        {a.name}
                      </span>
                    );
                  })}
                  {installedAgents.length === 0 && (
                    <span className="onboarding-agent-none">{t('onboarding.noAgents')}</span>
                  )}
                </div>
              </>
            )}
          </section>

          {/* Step 2: key import + agent config adoption */}
          <section className="wiz-step">
            <h1>{t('onboarding.keyStepTitle')}</h1>
            {(() => {
              const modelFindings = findings.filter(f => f.model);
              return modelFindings.length > 0 ? (
              <>
                <div className="onboarding-key-list">
                  {modelFindings.map(f => {
                    const id = idOf(f);
                    const checked = selectedKeys.has(id);
                    return (
                      <label key={id} className="onboarding-key-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedKeys(prev => {
                            const n = new Set(prev);
                            n.has(id) ? n.delete(id) : n.add(id);
                            return n;
                          })}
                        />
                        <span className="onboarding-key-agent">{agentName(f.agentId)}</span>
                        {f.providerId && <span className="onboarding-key-provider">{f.providerId}</span>}
                        <code className="onboarding-key-masked">{f.masked}</code>
                        <span className="onboarding-key-file">{f.file.split('/').pop()}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="onboarding-key-actions">
                  <button
                    type="button"
                    className="wiz-btn-secondary"
                    disabled={importing || selectedKeys.size === 0}
                    onClick={importSelected}
                  >
                    {importing ? '…' : t('onboarding.importSelected', { count: selectedKeys.size })}
                  </button>
                  {importedCount > 0 && (
                    <span className="onboarding-imported-note">{t('onboarding.importedNote', { count: importedCount })}</span>
                  )}
                </div>
              </>
              ) : (
              <div className="onboarding-key-clean">✓ {t('onboarding.allManaged')}</div>
              );
            })()}
            {externalSites.length > 0 && (
              <div className="wiz-adopt-block">
                <h2 className="wiz-adopt-title">{t('onboarding.adoptSection')}</h2>
                <div className="onboarding-key-list">
                  {externalSites.map(x => {
                    const id = `${x.agentId}|${x.providerId}`;
                    const adopted = adoptedIds.has(id);
                    const checked = selectedSites.has(id);
                    return (
                      <label key={id} className="onboarding-key-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedSites(prev => {
                            const n = new Set(prev);
                            n.has(id) ? n.delete(id) : n.add(id);
                            return n;
                          })}
                        />
                        <span className="onboarding-key-agent">{x.agentName}</span>
                        <span className="onboarding-key-provider">{x.providerName}</span>
                        {adopted && <span className="wiz-platform-check">✓</span>}
                      </label>
                    );
                  })}
                </div>
                <div className="onboarding-key-actions">
                  <button
                    type="button"
                    className="wiz-btn-secondary"
                    disabled={adopting || selectedSites.size === 0}
                    onClick={adoptSelected}
                  >
                    {adopting ? '…' : t('onboarding.adoptDo', { count: [...selectedSites].filter(id => !adoptedIds.has(id)).length })}
                  </button>
                  {adoptedIds.size > 0 && (
                    <span className="onboarding-imported-note">{t('onboarding.adoptedNote', { count: adoptedIds.size })}</span>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Step 3: optional provider + key setup */}
          <section className="wiz-step">
            <h1>{t('onboarding.platformStepTitle')}</h1>
            <input
              className="wiz-platform-search"
              type="text"
              value={platformQuery}
              onChange={e => setPlatformQuery(e.target.value)}
              placeholder={t('onboarding.platformSearch')}
            />
            <div className="wiz-platform-list">
              {providers
                .filter(p => !platformQuery.trim()
                  || p.name.toLowerCase().includes(platformQuery.trim().toLowerCase())
                  || p.id.toLowerCase().includes(platformQuery.trim().toLowerCase()))
                .map(p => {
                  const configured = configuredIds.has(p.id);
                  const active = activeProviderId === p.id;
                  const icon = getProviderIcon(p.id);
                  return (
                    <div key={p.id} className={`wiz-platform-item${active ? ' active' : ''}`}>
                      <button
                        type="button"
                        className="wiz-platform-row"
                        onClick={() => {
                          if (active) { setActiveProviderId(null); return; }
                          setActiveProviderId(p.id);
                          setKeyName(suggestKeyName(p.id));
                          setKeyValue('');
                        }}
                      >
                        {icon ? <img src={icon} alt="" className={getProviderIconClass(p.id) || ''} /> : null}
                        <span className="wiz-platform-name">{p.name}</span>
                        {configured && <span className="wiz-platform-check">✓</span>}
                        {!configured && p.hasKey && <span className="wiz-platform-tag">{t('onboarding.platformHasKey')}</span>}
                      </button>
                      {active && (
                        <div className="wiz-platform-form">
                          <input
                            type="text"
                            value={keyName}
                            onChange={e => setKeyName(e.target.value)}
                            placeholder={t('onboarding.keyName')}
                          />
                          <input
                            type="password"
                            value={keyValue}
                            onChange={e => setKeyValue(e.target.value)}
                            placeholder={t('onboarding.keyValue')}
                            onKeyDown={e => { if (e.key === 'Enter') savePlatformKey(p); }}
                          />
                          <button
                            type="button"
                            className="wiz-btn-secondary"
                            disabled={keySaving}
                            onClick={() => savePlatformKey(p)}
                          >{keySaving ? '…' : t('onboarding.platformSave')}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </section>

          {/* Step 4: done */}
          <section className="wiz-step wiz-step-done">
            <div className="wiz-done-check">✓</div>
            <h1>{t('onboarding.doneTitle')}</h1>
            <p className="wiz-done-meta">{t('onboarding.doneMeta', { agents: installedAgents.length, keys: importedCount })}</p>
          </section>
        </div>

        {/* Nav */}
        <div className="wiz-nav">
          {step > 0 && step < STEPS - 1 && (
            <button type="button" className="wiz-btn-ghost" onClick={() => setStep(s => s - 1)}>
              ← {t('onboarding.prevStep')}
            </button>
          )}
          <div className="wiz-nav-spacer" />
          {step < STEPS - 1 && (
            <button
              type="button"
              className="wiz-btn-primary"
              disabled={step === 0 && phase < 2}
              onClick={() => setStep(s => s + 1)}
            >
              {t('onboarding.nextStep')} →
            </button>
          )}
          {step === STEPS - 1 && (
            <button type="button" className="wiz-btn-launch" onClick={enterApp} disabled={exiting}>
              {exiting ? t('onboarding.entering') : t('onboarding.enter')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
