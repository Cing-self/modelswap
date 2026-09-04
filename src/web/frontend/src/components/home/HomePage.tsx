import { useEffect, useState, useCallback, useRef } from 'react';
import { getAdapters, switchProvider, saveAgentProviderSite, removeAgentProviderSite, setAgentProviderSiteEnabled, getAgentConfigFiles, saveAgentConfigFile, getTierMaps, setTierMap, fetchModels, AgentInfo, AgentConfigFile, TierMap } from '../../api/providers';
import { useI18n } from '../../i18n';
import { useApp } from '../Layout/AppContext';
import { getAgentIcon, getAgentIconClass } from '../../assets/agents';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import JsonTreeView from '../shared/JsonTreeView';
import CustomSelect from '../shared/CustomSelect';
import { Eye, EyeOff, Copy, Save, RefreshCw, X, Plus, FileJson, Loader2, Check, ArrowLeft } from 'lucide-react';
import UsageSummary from './UsageSummary';
import { useTransientFeedback } from '../../hooks/useTransientFeedback';
import { useDataChanged } from '../../hooks/useDataChanged';
import { useModelCacheWarmupPending } from '../../hooks/useModelCacheWarmup';

const AGENT_ORDER_KEY = 'modelswap.agentOrder';

function loadSavedAgentOrder(): string[] {
  try {
    const raw = localStorage.getItem(AGENT_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveAgentOrder(ids: string[]): void {
  try {
    localStorage.setItem(AGENT_ORDER_KEY, JSON.stringify(ids));
  } catch {}
}

function applySavedAgentOrder(list: AgentInfo[]): AgentInfo[] {
  const saved = loadSavedAgentOrder();
  if (!saved.length) return list;
  const byId = new Map(list.map(a => [a.id, a]));
  const ordered: AgentInfo[] = [];
  for (const id of saved) {
    const agent = byId.get(id);
    if (agent && !ordered.includes(agent)) ordered.push(agent);
  }
  for (const agent of list) {
    if (!ordered.includes(agent)) ordered.push(agent);
  }
  return ordered;
}

export default function HomePage() {
  const { t } = useI18n();
  const { showToast, confirm } = useApp();
  const warmupPending = useModelCacheWarmupPending();
  const [adapters, setAdapters] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  // Which provider cards have "show all models" expanded.
  const [showAllModels, setShowAllModels] = useState<Set<string>>(new Set());
  // Unified home picker modal — a two-step flow, NOT tabs (sites are
  // multi-select; models are a drill-down of one site):
  //   view 'sites'  → add/remove sites (multi-select, checkboxes)
  //   view 'models' → curate ONE provider's models (search + platform refresh)
  // Checking a site jumps to its models view with a top-left back button so
  // the user can return and keep selecting sites. The card's "添加模型"
  // button opens the models view directly (no back button — nothing to go
  // back to, only that site's models).
  const [homePickerOpen, setHomePickerOpen] = useState(false);
  const [homePickerView, setHomePickerView] = useState<'sites' | 'models'>('sites');
  const [homePickerModelFor, setHomePickerModelFor] = useState<string | null>(null);
  const [homePickerFromSites, setHomePickerFromSites] = useState(false);
  const [configFiles, setConfigFiles] = useState<AgentConfigFile[] | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  // Whether the viewer currently shows raw credentials (explicit user action
  // with a confirmation). Default: sensitive values are masked server-side.
  const [configRevealed, setConfigRevealed] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState(0);
  // Editable drafts: maps file path → edited content. A file is "dirty" when
  // its draft differs from the original content loaded from disk.
  const [configDrafts, setConfigDrafts] = useState<Record<string, string>>({});
  const [configSaveState, setConfigSaveState] = useState<'idle' | 'saving' | 'ok' | 'fail'>('idle');
  const configSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { activeKey: copiedConfigPath, showFeedback: showConfigCopied } = useTransientFeedback();
  // Config viewer display mode: 'raw' shows the editable textarea,
  // 'tree' toggles to a collapsible JSON tree preview.
  const [configViewMode, setConfigViewMode] = useState<'tree' | 'raw'>('raw');
  // Draft selection while the picker is open. No Agent config is written
  // until the user explicitly saves this complete model list.
  const [pickerModelIds, setPickerModelIds] = useState<string[]>([]);
  const [pickerSaving, setPickerSaving] = useState(false);
  // Search queries for the provider/model picker popups. Reset each time a
  // picker opens so a stale query never hides the list you're looking for.
  const [providerPickerSearch, setProviderPickerSearch] = useState('');
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  // In-picker "refresh from platform" state (spinner on the refresh button).
  const [modelPickerRefreshing, setModelPickerRefreshing] = useState(false);
  // Claude Code tier maps: per-provider { haiku, sonnet, opus } model overrides.
  const [tierMaps, setTierMaps] = useState<Record<string, TierMap>>({});
  // Agent tab drag-to-reorder.
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dropTabIndex, setDropTabIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getAdapters();
      const list = data.adapters || [];
      const ordered = applySavedAgentOrder(list);
      setAdapters(ordered);
      // Only seed the active agent on the very first load. Use the functional
      // form so we read the latest activeAgentId — otherwise the closure would
      // capture the initial null forever and reset the tab to list[0] on every
      // reload (e.g. after a switch), yanking the user back to Claude.
      setActiveAgentId(prev => (prev == null && ordered.length > 0 ? ordered[0].id : prev));
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);
  useDataChanged(['providers', 'secrets', 'agents'], load);

  const closeHomePicker = useCallback(() => {
    setHomePickerOpen(false);
    setHomePickerView('sites');
    setHomePickerModelFor(null);
    setHomePickerFromSites(false);
    setPickerModelIds([]);
    setPickerSaving(false);
  }, []);

  const openHomeSites = useCallback(() => {
    setProviderPickerSearch('');
    setHomePickerView('sites');
    setHomePickerFromSites(false);
    setHomePickerOpen(true);
  }, []);

  const openHomeModels = useCallback((providerId: string) => {
    const agent = adapters.find(item => item.id === activeAgentId);
    const site = agent?.compatibleProviders.find(item => item.id === providerId);
    setModelPickerSearch('');
    setHomePickerModelFor(providerId);
    setPickerModelIds(site?.models.map(model => model.id) || []);
    setHomePickerView('models');
    setHomePickerFromSites(false);
    setHomePickerOpen(true);
  }, [activeAgentId, adapters]);

  const handleRemoveSite = useCallback(async (providerId: string) => {
    if (!activeAgentId) return;
    try {
      await removeAgentProviderSite(activeAgentId, providerId);
      await load();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [activeAgentId, load, showToast]);

  const savePickerModels = useCallback(async () => {
    if (!activeAgentId || !homePickerModelFor || pickerModelIds.length === 0) {
      showToast('请至少选择一个模型', 'error');
      return;
    }
    setPickerSaving(true);
    try {
      await saveAgentProviderSite(activeAgentId, homePickerModelFor, pickerModelIds);
      await load();
      closeHomePicker();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setPickerSaving(false);
    }
  }, [activeAgentId, closeHomePicker, homePickerModelFor, load, pickerModelIds, showToast]);

  const handleDropTab = useCallback((targetIndex: number) => {
    setDragTabIndex(from => {
      if (from === null || from === targetIndex) return null;
      setAdapters(prev => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(from < targetIndex ? targetIndex - 1 : targetIndex, 0, moved);
        saveAgentOrder(next.map(a => a.id));
        return next;
      });
      return null;
    });
    setDropTabIndex(null);
  }, []);

  const handleViewConfig = useCallback(async (reveal = configRevealed) => {
    if (!activeAgentId) return;
    setConfigLoading(true);
    setConfigFiles([]);
    setActiveConfigTab(0);
    setConfigDrafts({});
    setConfigViewMode('raw');
    try {
      const res = await getAgentConfigFiles(activeAgentId, { reveal });
      setConfigFiles(res.files);
      setConfigRevealed(Boolean(res.revealed));
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setConfigLoading(false);
    }
  }, [activeAgentId, configRevealed, showToast]);

  const handleToggleReveal = useCallback(async () => {
    if (!configRevealed) {
      const ok = await confirm(t('home.configRevealConfirm'), {
        title: t('home.configRevealSensitive'),
        type: 'warn',
      });
      if (!ok) return;
      handleViewConfig(true);
    } else {
      handleViewConfig(false);
    }
  }, [configRevealed, confirm, handleViewConfig, t]);

  const handleSaveConfig = useCallback(async (filePath: string) => {
    if (!activeAgentId) return;
    const content = configDrafts[filePath];
    if (content === undefined) return;
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    setConfigSaveState('saving');
    try {
      await saveAgentConfigFile(activeAgentId, filePath, content);
      // Commit the draft as the new "original" so the file is no longer dirty.
      setConfigFiles(prev => prev ? prev.map(f => f.path === filePath ? { ...f, content } : f) : prev);
      setConfigDrafts(prev => { const n = { ...prev }; delete n[filePath]; return n; });
      setConfigSaveState('ok');
    } catch (err: any) {
      setConfigSaveState('fail');
      showToast(err.message, 'error');
    } finally {
      configSaveTimer.current = setTimeout(() => setConfigSaveState('idle'), 1600);
    }
  }, [activeAgentId, configDrafts, showToast, t]);

  useEffect(() => () => {
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
  }, []);

  const handleCopyConfig = useCallback(async (filePath: string) => {
    const draft = configDrafts[filePath];
    const original = configFiles?.find(f => f.path === filePath)?.content ?? '';
    try {
      await navigator.clipboard.writeText(draft !== undefined ? draft : original);
      showConfigCopied(filePath);
    } catch {
      showToast(t('common.error'), 'error');
    }
  }, [configDrafts, configFiles, showConfigCopied, showToast, t]);

  // Tier mappings are an attribute of the Claude site record.
  useEffect(() => {
    getTierMaps().then(res => setTierMaps(res.tierMaps || {})).catch(() => {});
  }, []);


  const activeAgent = adapters.find(a => a.id === activeAgentId) || null;

  // Remove a model from this site's actual selection. This rewrites the
  // native Agent config too, rather than merely hiding a chip in the UI.
  const removeFromCard = useCallback(async (providerId: string, modelId: string) => {
    if (!activeAgentId) return;
    const agent = adapters.find(item => item.id === activeAgentId);
    const site = agent?.compatibleProviders.find(item => item.id === providerId);
    const next = (site?.models || []).map(model => model.id).filter(id => id !== modelId);
    try {
      if (next.length === 0) await removeAgentProviderSite(activeAgentId, providerId);
      else await saveAgentProviderSite(activeAgentId, providerId, next, next.includes(agent?.current?.modelId || '') ? agent?.current?.modelId : next[0]);
      await load();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [activeAgentId, adapters, load, showToast]);

  // Change one tier (haiku/sonnet/opus) mapping for a provider. Persists to
  // backend then re-switches the active claude provider so settings.json
  // regenerates with the new tier env vars.
  const changeTier = useCallback(async (providerId: string, tier: 'haiku' | 'sonnet' | 'opus', modelId: string) => {
    const cur = tierMaps[providerId] || {};
    const next = { ...cur, [tier]: modelId || undefined };
    // Clean up undefined keys.
    const cleaned: TierMap = {};
    if (next.haiku) cleaned.haiku = next.haiku;
    if (next.sonnet) cleaned.sonnet = next.sonnet;
    if (next.opus) cleaned.opus = next.opus;
    setTierMaps(prev => ({ ...prev, [providerId]: cleaned }));
    try {
      await setTierMap(providerId, cleaned);
      // Re-switch to regenerate settings.json with new tier env vars.
      if (activeAgentId === 'claude') {
        const adapter = adapters.find(a => a.id === 'claude');
        if (adapter?.current?.providerId === providerId && adapter.current.modelId) {
          await switchProvider('claude', providerId, adapter.current.modelId);
        }
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [tierMaps, activeAgentId, adapters, showToast]);

  async function handleSwitch(agentId: string, providerId: string, modelId: string) {
    setSwitching(`${agentId}:${modelId}`);
    try {
      const result = await switchProvider(agentId, providerId, modelId);
      showToast(result.snapshotAvailable === false ? t('agents.switchWithoutSnapshot') : t('agents.switchSuccess'), result.snapshotAvailable === false ? 'info' : 'success');
      load();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSwitching(null);
    }
  }

  // Additive agents (workbuddy): toggling a site OFF removes the entries MODELSWAP
  // wrote for it from the agent's own config. Switching between sites happens
  // inside the agent, so there is no fallback-to-official concept here.
  async function handleDisableSite(agentId: string, providerId: string) {
    setSwitching(`${agentId}:${providerId}`);
    try {
      await setAgentProviderSiteEnabled(agentId, providerId, false);
      showToast(t('home.siteDisabled'), 'success');
      load();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSwitching(null);
    }
  }

  if (loading || warmupPending) {
    return (
      <div className="quick-start-page" aria-busy="true">
        <div className="home-section">
          <div className="skeleton-line skeleton-line--title qs-skeleton-heading" />
          <div className="qs-skeleton-row">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="qs-skeleton-card">
                <div className="skeleton-line skeleton-line--short" />
                <div className="skeleton-line skeleton-line--title" />
              </div>
            ))}
          </div>
        </div>
        <div className="home-section">
          <div className="skeleton-line skeleton-line--title qs-skeleton-heading" />
          <div className="qs-skeleton-tabs">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton-shape--pill" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="quick-start-page">
      <h1 className="sr-only">{t('home.title')}</h1>
      {/* Goal ②: dashboard blocks — daily-driver content above the fold */}
      <UsageSummary />
      {/* Agent configuration section — tab + provider cards */}
      <section className="home-section home-section--agent">
        <div className="home-agent-heading">
          <h3 className="home-section-title">{t('home.agentConfig')}</h3>
          {activeAgent && (
            <div className="home-provider-actions">
              <button
                type="button"
                className="home-add-provider-btn"
                onClick={openHomeSites}
                title={t('home.addProvider')}
              >
                <Plus size={15} />
              </button>
              <button
                type="button"
                className="home-view-config-btn"
                onClick={() => handleViewConfig()}
                disabled={configLoading}
                title={configLoading ? t('common.loading') : t('home.viewConfig')}
              >
                <FileJson size={15} />
              </button>
            </div>
          )}
        </div>

      {/* Agent Tabs */}
      <div className="agent-tabs" role="tablist" aria-label={t('home.agentConfig')}>
        {adapters.map((agent, i) => {
          const icon = getAgentIcon(agent.id);
          return (
            <button
              key={agent.id}
              className={`agent-tab${activeAgentId === agent.id ? ' active' : ''}${agent.installed === false ? ' agent-tab--unavailable' : ''}${dragTabIndex === i ? ' dragging' : ''}${dropTabIndex === i && dragTabIndex !== null && dragTabIndex !== i ? ' drop-target' : ''}`}
              role="tab"
              aria-selected={activeAgentId === agent.id}
              aria-label={agent.installed === false ? `${agent.name} (${t('common.notInstalled')})` : agent.name}
              onClick={() => { setActiveAgentId(agent.id); setExpandedProvider(null); closeHomePicker(); setShowAllModels(new Set()); }}
              title={agent.name}
              draggable
              onDragStart={(e) => { setDragTabIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnter={() => { if (dragTabIndex !== null && dragTabIndex !== i) setDropTabIndex(i); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTabIndex(null); }}
              onDrop={(e) => { e.preventDefault(); handleDropTab(i); }}
              onDragEnd={() => { setDragTabIndex(null); setDropTabIndex(null); }}
            >
              {icon && <img src={icon} alt="" className={['agent-tab-icon', getAgentIconClass(agent.id)].filter(Boolean).join(' ')} draggable={false} />}
              {agent.installed === false && <span className="agent-tab-unavailable-mark" aria-hidden="true" />}
              {agent.current && <span className="agent-tab-dot" />}
            </button>
          );
        })}
      </div>

      {/* Provider cards */}
      {activeAgent && (
        <div className="agent-provider-rows">
          {activeAgent.compatibleProviders.map(p => {
            const isCurrent = activeAgent.current?.providerId === p.id;
            // Additive agents (zcode/workbuddy) keep many sites enabled at
            // once — the toggle reflects the real per-site config state
            // (backend), falling back to the current selection when unknown.
            const siteEnabled = activeAgent.additive
              ? (p.enabled !== undefined ? p.enabled : isCurrent)
              : isCurrent;
            const fallback = {
              'claude': { providerId: 'anthropic-agent', modelId: 'claude-sonnet-4-6' },
              'codex': { providerId: 'openai-codex', modelId: 'gpt-5.6-sol' },
            }[activeAgent.id];
            const canSwitchToFallback = Boolean(fallback)
              && !(fallback?.providerId === p.id && fallback?.modelId === activeAgent.current?.modelId);
            const switchLocked = siteEnabled && !activeAgent.additive && !canSwitchToFallback;
            const isExpanded = expandedProvider === p.id;
            const currentId = isCurrent ? activeAgent.current?.modelId : undefined;
            const visibleAfterExclude = p.models;
            return (
              <div key={p.id} className={`provider-card provider-card--clickable${isCurrent ? ' provider-card--current' : ''}${isExpanded ? ' expanded' : ''}`}>
                <div
                  className="provider-card-header"
                  onClick={() => setExpandedProvider(isExpanded ? null : p.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="provider-card-title">
                    {(() => { const icon = getProviderIcon(p.id); return icon ? <img src={icon} alt="" className={['provider-card-brand-icon', getProviderIconClass(p.id)].filter(Boolean).join(' ')} /> : null; })()}
                    <h3>{p.name}</h3>
                    {isCurrent && (
                      <span className="provider-card-current-tag">{t('agents.current')}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={siteEnabled}
                    className={`provider-switch${siteEnabled ? ' provider-switch--on' : ''}`}
                    title={switchLocked ? t('home.activeProviderRequired') : siteEnabled ? (activeAgent.additive ? t('home.disableSite') : t('home.disableSiteFallback')) : t('home.enable')}
                    aria-label={switchLocked ? t('home.activeProviderRequired') : siteEnabled ? (activeAgent.additive ? t('home.disableSite') : t('home.disableSiteFallback')) : t('home.enable')}
                    disabled={(switching || '').startsWith(activeAgent.id) || switchLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!siteEnabled) {
                        // Re-enable an additive site through the dedicated
                        // enabled endpoint: it flips the stored enabled flag,
                        // which a plain model save would preserve as false.
                        if (visibleAfterExclude.length === 0) {
                          openHomeModels(p.id);
                        } else if (activeAgent.additive) {
                          setAgentProviderSiteEnabled(activeAgent.id, p.id, true)
                            .then(() => load())
                            .catch(err => showToast(err.message, 'error'));
                        } else {
                          handleSwitch(activeAgent.id, p.id, visibleAfterExclude[0].id);
                        }
                      } else if (activeAgent.additive) {
                        // Switch OFF (additive) — remove this site's entries
                        // from the agent config. Switching happens inside the
                        // agent's own UI, so no official fallback is needed.
                        handleDisableSite(activeAgent.id, p.id);
                      } else {
                        // Switch OFF (exclusive) — the backend disables the
                        // site (kept in the list) and lands the agent on the
                        // official subscription fallback itself, so the
                        // catalog-less OAuth preset never round-trips through
                        // a plain switch that would reject its empty catalog.
                        setAgentProviderSiteEnabled(activeAgent.id, p.id, false)
                          .then(() => { showToast(t('home.siteDisabled'), 'success'); load(); })
                          .catch(err => showToast(err.message, 'error'));
                      }
                    }}
                  >
                    <span className="provider-switch-knob" />
                  </button>
                  <button
                    type="button"
                    className="provider-card-remove-btn"
                    title={t('home.removeProvider')}
                    onClick={(e) => { e.stopPropagation(); handleRemoveSite(p.id); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                {isExpanded && p.models.length > 0 && (
                  <div className="provider-card-models-list">
                    {(() => {
                      const showAll = showAllModels.has(p.id);
                      // Keep large provider model lists collapsed by default.
                      const COLLAPSED_LIMIT = 8;
                      const needsCollapse = visibleAfterExclude.length > COLLAPSED_LIMIT;
                      const visibleModels = !showAll && needsCollapse
                        ? visibleAfterExclude.slice(0, COLLAPSED_LIMIT)
                        : visibleAfterExclude;
                      const totalCount = p.models.length;
                      const visibleCount = visibleAfterExclude.length;
                      return (
                        <>
                          {visibleModels.map(m => {
                            const isThisModel = isCurrent && currentId === m.id;
                            const hideDisabled = isThisModel;
                            const switchingThis = switching === `${activeAgent.id}:${m.id}`;
                            return (
                              <div
                                key={m.id}
                                className={`agent-model-chip${isThisModel ? ' active' : ''}${switchingThis ? ' switching' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="agent-model-chip-name"
                                  disabled={switchingThis}
                                  onClick={() => handleSwitch(activeAgent.id, p.id, m.id)}
                                  title={isThisModel ? t('home.currentModel') : t('home.switchToModel')}
                                >
                                  <span className="agent-model-name">{m.name || m.id}</span>
                                </button>
                                {!hideDisabled && (
                                  <button
                                    type="button"
                                    className="agent-model-chip-remove"
                                    title={t('home.removeModel')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeFromCard(p.id, m.id);
                                    }}
                                  >
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {needsCollapse && (
                            <button
                              type="button"
                              className="agent-model-showall"
                              onClick={() => setShowAllModels(prev => {
                                const n = new Set(prev);
                                n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                                return n;
                              })}
                            >
                              {showAll ? t('home.collapse') : t('home.showAll')} ({visibleCount}/{totalCount})
                            </button>
                          )}
                          <button
                            type="button"
                            className="agent-model-add-btn"
                            onClick={() => openHomeModels(p.id)}
                            title={t('home.addModels')}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            {t('home.addModels')}
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
                {/* Claude Code tier mapping — only for non-official providers.
                    Lets the user route haiku/sonnet/opus to different models on
                    the gateway so Claude Code's tier-switching doesn't 404. */}
                {isExpanded && activeAgentId === 'claude' && p.baseUrl !== 'https://api.anthropic.com' && p.models.length > 0 && (
                  <div className="provider-tier-maps" role="group" aria-label={t('home.tierRouting')}>
                    {(['haiku', 'sonnet', 'opus'] as const).map(tier => {
                      const tierMap = tierMaps[p.id] || {};
                      const current = tierMap[tier] || '';
                      return (
                        <div key={tier} className={`provider-tier-row provider-tier-row--${tier}`}>
                          <span className="provider-tier-marker" aria-hidden="true">{tier[0].toUpperCase()}</span>
                          <span className="provider-tier-label">{tier.toUpperCase()}</span>
                          <CustomSelect
                            className="provider-tier-select"
                            dropdownMode="local"
                            ariaLabel={tier.toUpperCase()}
                            value={current}
                            onChange={value => changeTier(p.id, tier, value)}
                            options={[
                              { value: '', label: t('home.tierFollowPrimary') },
                              ...visibleAfterExclude.map(model => ({ value: model.id, label: model.name || model.id })),
                            ]}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {activeAgent.compatibleProviders.length === 0 && (
            <div className="home-empty-hint">{t('home.noProvidersHint')}</div>
          )}
        </div>
      )}
      {homePickerOpen && activeAgent && (() => {
        const modelProvider = homePickerModelFor
          ? activeAgent.compatibleProviders.find(p => p.id === homePickerModelFor)
            || activeAgent.availableProviders?.find(p => p.id === homePickerModelFor)
            || null
          : null;
        const onModels = homePickerView === 'models';
        return (
          <div className="home-add-picker-overlay" onClick={closeHomePicker}>
            <div className="home-add-picker" onClick={e => e.stopPropagation()}>
              <div className="home-add-picker-header">
                <div className="home-add-picker-title">
                  {onModels && homePickerFromSites && (
                    <button
                      type="button"
                      className="home-picker-back-btn"
                      onClick={() => { setProviderPickerSearch(''); setHomePickerView('sites'); }}
                      title={t('home.backToSites')}
                    >
                      <ArrowLeft size={15} />
                    </button>
                  )}
                  <h3>{onModels
                    ? t('home.addModelsTitle', { name: modelProvider?.name || '' })
                    : t('home.addProviderTitle', { name: activeAgent.name })}</h3>
                </div>
                <div className="home-config-viewer-actions">
                  {onModels && modelProvider && (
                    <button
                      type="button"
                      className="home-config-refresh-btn"
                      onClick={async () => {
                        if (modelPickerRefreshing || !homePickerModelFor) return;
                        setModelPickerRefreshing(true);
                        try {
                          const res = await fetchModels(homePickerModelFor);
                          if (!res.success && !(res.models || []).length) {
                            showToast(res.errors?.[0]?.error || t('common.error'), 'error');
                          } else {
                            // Refresh the global directory; the draft selection
                            // is preserved until the user explicitly saves it.
                            await load();
                          }
                        } catch (err: any) {
                          showToast(err.message, 'error');
                        } finally {
                          setModelPickerRefreshing(false);
                        }
                      }}
                      disabled={modelPickerRefreshing}
                      title={t('home.refresh')}
                    >
                      {modelPickerRefreshing
                        ? <Loader2 size={14} className="spin" />
                        : <RefreshCw size={14} />}
                    </button>
                  )}
                  <button type="button" className="btn-icon" onClick={closeHomePicker}>✕</button>
                </div>
              </div>
              {homePickerView === 'sites' ? (
                <>
                  <div className="home-add-picker-search">
                    <input
                      type="text"
                      autoFocus
                      value={providerPickerSearch}
                      onChange={e => setProviderPickerSearch(e.target.value)}
                      placeholder={t('home.searchProviders')}
                    />
                  </div>
                  <div className="home-add-picker-list">
                    {(() => {
                      const q = providerPickerSearch.trim().toLowerCase();
                      const all = activeAgent.availableProviders || [];
                      const list = (q
                        ? all.filter(p => (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q))
                        : all).filter(p => !(activeAgentId === 'codex' && p.codexUnsupported === true));
                      return (
                        <>
                          {list.map(p => (
                            <label key={p.id} className={`home-add-picker-item${p.added ? ' added' : ''}`}>
                              <input
                                type="checkbox"
                                checked={p.added}
                                onChange={async () => {
                                  if (p.added) { await handleRemoveSite(p.id); return; }
                                  // Adding a site first opens its full model
                                  // directory. Nothing is written until Save.
                                  setModelPickerSearch('');
                                  setPickerModelIds([]);
                                  setHomePickerModelFor(p.id);
                                  setHomePickerFromSites(true);
                                  setHomePickerView('models');
                                }}
                              />
                              {(() => { const icon = getProviderIcon(p.id); return icon ? <img src={icon} alt="" className={['provider-card-brand-icon', getProviderIconClass(p.id)].filter(Boolean).join(' ')} /> : null; })()}
                              <span>{p.name}</span>
                            </label>
                          ))}
                          {all.length === 0 && (
                            <p className="home-empty-hint">{t('home.noAvailableProviders')}</p>
                          )}
                          {all.length > 0 && list.length === 0 && (
                            <p className="home-empty-hint">{t('home.pickerNoMatch')}</p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              ) : (
                (() => {
                  if (!modelProvider) {
                    return <div className="home-add-picker-list"><p className="home-empty-hint">{t('home.pickerModelsGone')}</p></div>;
                  }
                  const models = modelProvider.allModels || modelProvider.models;
                  const modelQuery = modelPickerSearch.trim().toLowerCase();
                  const filteredModels = modelQuery
                    ? models.filter(m => m.id.toLowerCase().includes(modelQuery) || (m.name || '').toLowerCase().includes(modelQuery))
                    : models;
                  return (
                    <>
                      <div className="home-add-picker-search">
                        <input
                          type="text"
                          autoFocus
                          value={modelPickerSearch}
                          onChange={e => setModelPickerSearch(e.target.value)}
                          placeholder={t('models.searchModels')}
                        />
                      </div>
                      <div className="home-add-picker-list">
                        {models.length === 0 && (
                          <p className="home-empty-hint">{t('home.pickerModelsGone')}</p>
                        )}
                        {models.length > 0 && filteredModels.length === 0 && (
                          <p className="home-empty-hint">{t('home.pickerNoMatch')}</p>
                        )}
                        {filteredModels.map(m => (
                          <label key={m.id} className="home-add-picker-item">
                            <input
                              type="checkbox"
                              checked={pickerModelIds.includes(m.id)}
                              onChange={() => setPickerModelIds(prev => prev.includes(m.id)
                                ? prev.filter(id => id !== m.id)
                                : [...prev, m.id])}
                            />
                            <span>{m.name || m.id}</span>
                            {m.recent === false && (
                              <span className="picker-noncoding-tag">{t('home.nonCodingTag')}</span>
                            )}
                            {m.id !== (m.name || m.id) && (
                              <span style={{ color: 'var(--ink-muted)', fontSize: 11 }}>· {m.id}</span>
                            )}
                          </label>
                        ))}
                      </div>
                      <div className="home-picker-save-row">
                        <span>{pickerModelIds.length} 个模型已选择</span>
                        <button
                          type="button"
                          className="home-picker-save-btn"
                          onClick={savePickerModels}
                          disabled={pickerSaving || pickerModelIds.length === 0}
                        >
                          {pickerSaving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                          保存模型
                        </button>
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          </div>
        );
      })()}
      {configFiles !== null && (
        <div className="home-add-picker-overlay" onClick={() => setConfigFiles(null)}>
          <div className="home-config-viewer" onClick={e => e.stopPropagation()}>
            <div className="home-add-picker-header">
              <h3>{t('home.configFilesTitle')}</h3>
              <div className="home-config-viewer-actions">
                <button
                  type="button"
                  className={`home-config-refresh-btn${configRevealed ? ' revealed' : ''}`}
                  onClick={handleToggleReveal}
                  disabled={configLoading}
                  title={configRevealed ? t('home.configHideSensitive') : t('home.configRevealSensitive')}
                >
                  {configRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button type="button" className="home-config-refresh-btn" onClick={() => handleViewConfig()} disabled={configLoading} title={t('home.refresh')}>
                  <RefreshCw size={14} />
                </button>
                <button type="button" className="btn-icon" onClick={() => setConfigFiles(null)} title={t('common.close')}><X size={14} /></button>
              </div>
            </div>
            {/* Tab bar — only shown when there's more than one file. Each
                tab is labeled by the file's basename so long paths don't
                overflow; the full path is shown above the content. */}
            {configFiles.length > 1 && (
              <div className="home-config-tabs">
                {configFiles.map((f, i) => {
                  // Basename, disambiguated with the parent dir when two files
                  // share a name (zcode has v2/config.json AND cli/config.json).
                  const parts = f.path.split('/');
                  const basename = parts.length >= 2 && configFiles.some(o => o !== f && o.path.split('/').pop() === parts[parts.length - 1])
                    ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
                    : parts[parts.length - 1] || f.path;
                  return (
                    <button
                      key={f.path}
                      type="button"
                      className={`home-config-tab${i === activeConfigTab ? ' active' : ''}`}
                      onClick={() => setActiveConfigTab(i)}
                      title={f.path}
                    >
                      {basename}
                      <span className={`home-config-tab-dot${f.exists ? ' exists' : ' missing'}`} />
                    </button>
                  );
                })}
              </div>
            )}
            <div className="home-config-viewer-body">
              {configFiles.length > 0 && (() => {
                const f = configFiles[Math.min(activeConfigTab, configFiles.length - 1)];
                const draft = configDrafts[f.path];
                const original = f.content ?? '';
                const current = draft !== undefined ? draft : original;
                const dirty = draft !== undefined && draft !== original;
                // Server-truncated file: editing it would write a partial file
                // back to disk and corrupt the config — read-only.
                const truncated = original.endsWith('…(truncated)');
                return (
                  <div className="home-config-file">
                    <div className="home-config-file-path">
                      <code>{f.path}</code>
                      {truncated && <span className="home-config-truncated-tag" title={t('home.configTruncated')}>{t('home.configTruncated')}</span>}
                      {dirty && <span className="home-config-dirty-dot" title={t('home.unsavedChanges')} />}
                      <button
                        type="button"
                        className={`home-config-preview-btn${configViewMode === 'tree' ? ' active' : ''}`}
                        disabled={!f.exists}
                        onClick={() => setConfigViewMode(prev => prev === 'tree' ? 'raw' : 'tree')}
                        title={t('home.configPreview')}
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        type="button"
                        className={`home-config-copy-btn${copiedConfigPath === f.path ? ' is-copied' : ''}`}
                        disabled={!f.exists}
                        onClick={() => handleCopyConfig(f.path)}
                        title={copiedConfigPath === f.path ? t('common.copied') : t('home.configCopy')}
                        aria-label={copiedConfigPath === f.path ? t('common.copied') : t('home.configCopy')}
                      >
                        {copiedConfigPath === f.path ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        type="button"
                        className={`home-config-save-btn${dirty ? ' dirty' : ''}${configSaveState === 'ok' ? ' saved' : ''}${configSaveState === 'fail' ? ' failed' : ''}`}
                        disabled={!f.exists || truncated || (!dirty && configSaveState === 'idle') || configSaveState === 'saving' || (!configRevealed && (f.maskedCount ?? 0) > 0)}
                        onClick={() => handleSaveConfig(f.path)}
                        title={t('home.save')}
                      >
                        {configSaveState === 'saving' ? <Loader2 size={14} className="home-config-save-spin" /> : configSaveState === 'ok' ? <Check size={14} /> : configSaveState === 'fail' ? <X size={14} /> : <Save size={14} />}
                      </button>
                    </div>
                    {f.exists ? (
                      configViewMode === 'tree' ? (
                        <JsonTreeView value={current} fileName={f.path} />
                      ) : (
                        <textarea
                          className="home-config-file-editor"
                          value={current}
                          spellCheck={false}
                          readOnly={truncated}
                          onChange={(e) => setConfigDrafts(prev => ({ ...prev, [f.path]: e.target.value }))}
                        />
                      )
                    ) : (
                      <p className="home-empty-hint">{t('home.fileMissing')}</p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      </section>
    </div>
  );
}
