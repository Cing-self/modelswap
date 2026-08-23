import { useEffect, useState, useCallback, useRef } from 'react';
import { getAdapters, switchProvider, addHomeProvider, removeHomeProvider, disableAgentProvider, getAgentConfigFiles, saveAgentConfigFile, getCatalogVisible, setCatalogVisible, getTierMaps, setTierMap, fetchModels, applyAgentModels, AgentInfo, AgentConfigFile, TierMap } from '../../api/providers';
import { useI18n } from '../../i18n';
import { useApp } from '../Layout/AppContext';
import { getAgentIcon, getAgentIconClass } from '../../assets/agents';
import { getProviderIcon, getProviderIconClass } from '../../assets/providers';
import JsonTreeView from '../shared/JsonTreeView';
import { Eye, EyeOff, Copy, Save, RefreshCw, X, Plus, FileJson, Loader2, Check, ArrowLeft } from 'lucide-react';
import UsageSummary from './UsageSummary';
import { useTransientFeedback } from '../../hooks/useTransientFeedback';

const AGENT_ORDER_KEY = 'okit.agentOrder';

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
  const { showToast } = useApp();
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
  // Per-provider list of model ids the user ADDED to the card (inclusion
  // model). Absent or empty = empty card; the picker lists everything else.
  const [modelVisible, setModelVisible] = useState<Record<string, string[]>>({});
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

  // Re-read persisted model-visibility exclusions and restored (extra) lists.
  // Called on mount and after adding a site — the backend seeds
  // "flagship-only"/hide-all exclusions on add, and the card should reflect
  // that immediately.
  const refreshModelVisible = useCallback(() => {
    getCatalogVisible().then(res => setModelVisible(res.visible || {})).catch(() => {});
  }, []);

  const handleAddHome = useCallback(async (providerId: string) => {
    if (!activeAgentId) return;
    try {
      await addHomeProvider(activeAgentId, providerId);
      refreshModelVisible();
      await load();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [activeAgentId, load, refreshModelVisible, showToast]);

  const closeHomePicker = useCallback(() => {
    setHomePickerOpen(false);
    setHomePickerView('sites');
    setHomePickerModelFor(null);
    setHomePickerFromSites(false);
  }, []);

  const openHomeSites = useCallback(() => {
    setProviderPickerSearch('');
    setHomePickerView('sites');
    setHomePickerFromSites(false);
    setHomePickerOpen(true);
  }, []);

  const openHomeModels = useCallback((providerId: string) => {
    setModelPickerSearch('');
    setHomePickerModelFor(providerId);
    setHomePickerView('models');
    setHomePickerFromSites(false);
    setHomePickerOpen(true);
  }, []);

  const handleRemoveHome = useCallback(async (providerId: string) => {
    if (!activeAgentId) return;
    try {
      await removeHomeProvider(activeAgentId, providerId);
      await load();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [activeAgentId, load, showToast]);

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

  const handleToggleReveal = useCallback(() => {
    if (!configRevealed) {
      const ok = window.confirm(t('home.configRevealConfirm'));
      if (!ok) return;
      handleViewConfig(true);
    } else {
      handleViewConfig(false);
    }
  }, [configRevealed, handleViewConfig, t]);

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

  // Load model visibility exclusions + claude tier maps once on mount.
  useEffect(() => {
    refreshModelVisible();
    getTierMaps().then(res => setTierMaps(res.tierMaps || {})).catch(() => {});
  }, [refreshModelVisible]);


  const activeAgent = adapters.find(a => a.id === activeAgentId) || null;

  // Toggle a model's visibility in its provider card. Unchecking hides it
  // from the list; the current model is pinned (checkbox disabled) so you
  // can't end up in a "current model hidden" state.
  // Remove a model from the card (the × on a chip) — drop it from the
  // provider's added-models list.
  const removeFromCard = useCallback(async (providerId: string, modelId: string) => {
    const next = (modelVisible[providerId] || []).filter(id => id !== modelId);
    setModelVisible(prev => ({ ...prev, [providerId]: next }));
    try {
      await setCatalogVisible(providerId, next);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [modelVisible, showToast]);

  // Add a model to the card (a checkbox in the "add models" view).
  const addToCard = useCallback(async (providerId: string, modelId: string) => {
    const cur = modelVisible[providerId] || [];
    if (cur.includes(modelId)) return;
    const next = [...cur, modelId];
    setModelVisible(prev => ({ ...prev, [providerId]: next }));
    try {
      await setCatalogVisible(providerId, next);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }, [modelVisible, showToast]);

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
      await switchProvider(agentId, providerId, modelId);
      showToast(t('agents.switchSuccess'), 'success');
      load();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSwitching(null);
    }
  }

  // Additive agents (workbuddy): toggling a site OFF removes the entries OKIT
  // wrote for it from the agent's own config. Switching between sites happens
  // inside the agent, so there is no fallback-to-official concept here.
  async function handleDisableSite(agentId: string, providerId: string) {
    setSwitching(`${agentId}:${providerId}`);
    try {
      await disableAgentProvider(agentId, providerId);
      showToast(t('home.siteDisabled'), 'success');
      load();
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSwitching(null);
    }
  }

  if (loading) {
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
              className={`agent-tab${activeAgentId === agent.id ? ' active' : ''}${dragTabIndex === i ? ' dragging' : ''}${dropTabIndex === i && dragTabIndex !== null && dragTabIndex !== i ? ' drop-target' : ''}`}
              role="tab"
              aria-selected={activeAgentId === agent.id}
              aria-label={agent.name}
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
            // Provider-level added-models list. Computed once so the model
            // chips AND tier dropdowns show the same set. The current model
            // stays listed even if absent (never a "current model missing"
            // state).
            const visibleSet = new Set(modelVisible[p.id] || []);
            const currentId = isCurrent ? activeAgent.current?.modelId : undefined;
            const visibleAfterExclude = p.models.filter(m => visibleSet.has(m.id) || m.id === currentId);
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
                    title={switchLocked ? t('home.activeProviderRequired') : siteEnabled ? (activeAgent.additive ? t('home.disableSite') : t('home.enabled')) : t('home.enable')}
                    aria-label={switchLocked ? t('home.activeProviderRequired') : siteEnabled ? (activeAgent.additive ? t('home.disableSite') : t('home.enabled')) : t('home.enable')}
                    disabled={(switching || '').startsWith(activeAgent.id) || switchLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!siteEnabled) {
                        // Switch ON — set this provider as current. Prefer the
                        // first VISIBLE model; a freshly added site starts
                        // with none, so open the picker to curate first.
                        if (visibleAfterExclude.length === 0) {
                          openHomeModels(p.id);
                        } else {
                          handleSwitch(activeAgent.id, p.id, visibleAfterExclude[0].id);
                        }
                      } else if (activeAgent.additive) {
                        // Switch OFF (additive) — remove this site's entries
                        // from the agent config. Switching happens inside the
                        // agent's own UI, so no official fallback is needed.
                        handleDisableSite(activeAgent.id, p.id);
                      } else {
                        // Switch OFF — for single-type agents, fall back to the
                        // official subscription. The provider stays in the home
                        // list but is no longer active.
                        if (fallback) {
                          handleSwitch(activeAgent.id, fallback.providerId, fallback.modelId);
                        }
                      }
                    }}
                  >
                    <span className="provider-switch-knob" />
                  </button>
                  <button
                    type="button"
                    className="provider-card-remove-btn"
                    title={t('home.removeProvider')}
                    onClick={(e) => { e.stopPropagation(); handleRemoveHome(p.id); }}
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
                          {(() => {
                            // Hidden = not currently visible (excluded and/or
                            // auto-filtered). Always offer the picker — a
                            // freshly added site starts with zero visible
                            // models and this is the entry point to curate.
                            const hiddenCount = totalCount - visibleAfterExclude.length;
                            if (hiddenCount <= 0) return null;
                            return (
                              <button
                                type="button"
                                className="agent-model-add-btn"
                                onClick={() => openHomeModels(p.id)}
                                title={t('home.addModels')}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                {t('home.addModels')} ({hiddenCount})
                              </button>
                            );
                          })()}
                        </>
                      );
                    })()}
                  </div>
                )}
                {/* Claude Code tier mapping — only for non-official providers.
                    Lets the user route haiku/sonnet/opus to different models on
                    the gateway so Claude Code's tier-switching doesn't 404. */}
                {isExpanded && activeAgentId === 'claude' && p.baseUrl !== 'https://api.anthropic.com' && p.models.length > 0 && (
                  <div className="provider-tier-maps">
                    {(['haiku', 'sonnet', 'opus'] as const).map(tier => {
                      const tierMap = tierMaps[p.id] || {};
                      const current = tierMap[tier] || '';
                      return (
                        <label key={tier} className="provider-tier-row">
                          <span className="provider-tier-label">{tier.toUpperCase()}</span>
                          <select
                            className="provider-tier-select"
                            value={current}
                            onChange={(e) => changeTier(p.id, tier, e.target.value)}
                          >
                            <option value="">{t('home.tierDefault')}</option>
                            {visibleAfterExclude.map(m => (
                              <option key={m.id} value={m.id}>{m.name || m.id}</option>
                            ))}
                          </select>
                        </label>
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
          {activeAgent.additive && (activeAgent.externalSites || []).length > 0 && (
            <div className="home-external-sites">
              <span className="home-external-sites-label" title={t('home.externalSitesHint')}>{t('home.externalSites')}</span>
              {(activeAgent.externalSites || []).map(x => (
                <span key={x.id} className={`home-external-chip${x.known ? '' : ' unknown'}`}>
                  <span className="home-external-chip-name">{x.name}</span>
                  {x.known ? (
                    <>
                      <button
                        type="button"
                        className="home-external-adopt"
                        onClick={() => handleAddHome(x.id)}
                        title={t('home.adoptSite')}
                      >＋</button>
                      <button
                        type="button"
                        className="home-external-remove"
                        onClick={() => handleRemoveHome(x.id)}
                        title={t('home.removeEntry')}
                      >✕</button>
                    </>
                  ) : (
                    <span className="home-external-badge" title={t('home.externalSiteHint')}>{t('home.externalBadge')}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {homePickerOpen && activeAgent && (() => {
        const modelProvider = homePickerModelFor
          ? activeAgent.compatibleProviders.find(p => p.id === homePickerModelFor) || null
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
                            // Refresh = full replace on the backend — reload the
                            // adapter data (and visibility lists) so the list
                            // reflects new/delisted models immediately.
                            refreshModelVisible();
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
                      const list = q
                        ? all.filter(p => (p.name || '').toLowerCase().includes(q) || (p.id || '').toLowerCase().includes(q))
                        : all;
                      return (
                        <>
                          {list.map(p => (
                            <label key={p.id} className={`home-add-picker-item${p.added ? ' added' : ''}`}>
                              <input
                                type="checkbox"
                                checked={p.added}
                                onChange={async () => {
                                  if (p.added) { handleRemoveHome(p.id); return; }
                                  // Fresh add — then drill into its models view
                                  // so the user curates what comes in. The back
                                  // button returns here for more multi-select.
                                  await handleAddHome(p.id);
                                  setModelPickerSearch('');
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
                  // The models view lists everything NOT yet added to the
                  // card. The recent flag is a display hint only (non-coding
                  // ids sort naturally low and carry a tag) — it no longer
                  // gates visibility in any way.
                  const addedSet = new Set(modelVisible[modelProvider.id] || []);
                  const currentModelId = activeAgent.current?.providerId === modelProvider.id
                    ? activeAgent.current?.modelId : undefined;
                  const hiddenModels = modelProvider.models.filter(m => !addedSet.has(m.id) && m.id !== currentModelId);
                  const modelQuery = modelPickerSearch.trim().toLowerCase();
                  const filteredModels = modelQuery
                    ? hiddenModels.filter(m => m.id.toLowerCase().includes(modelQuery) || (m.name || '').toLowerCase().includes(modelQuery))
                    : hiddenModels;
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
                        {hiddenModels.length === 0 && (
                          <p className="home-empty-hint">{t('home.noHiddenModels')}</p>
                        )}
                        {hiddenModels.length > 0 && filteredModels.length === 0 && (
                          <p className="home-empty-hint">{t('home.pickerNoMatch')}</p>
                        )}
                        {filteredModels.map(m => (
                          <label key={m.id} className="home-add-picker-item">
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={() => {
                                addToCard(modelProvider.id, m.id);
                                // Additive agents keep per-model entries in their
                                // own config — checking a model here is what writes
                                // it in. Append-only: unchecking later only hides
                                // the OKIT chip.
                                if (activeAgent.additive) {
                                  applyAgentModels(activeAgent.id, modelProvider.id, [m.id])
                                    .catch(err => showToast(err.message, 'error'));
                                }
                              }}
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
