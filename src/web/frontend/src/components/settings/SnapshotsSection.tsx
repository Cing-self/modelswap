import React, { useCallback, useEffect, useState } from 'react';
import ReactDiffViewer, { DiffMethod, type ReactDiffViewerStylesOverride } from 'react-diff-viewer-continued';
import { diffLines } from 'diff';
import { getAdapters, type AgentInfo } from '../../api/providers';
import {
  listSnapshots, getSnapshotDetail, restoreSnapshot,
  type Snapshot, type SnapshotDetailFile,
} from '../../api/snapshots';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';
import CustomSelect from '../shared/CustomSelect';
import { getAgentIcon, getAgentIconClass } from '../../assets/agents';
import { Clock3, Eye, GitCompareArrows, History, RotateCcw, X } from 'lucide-react';

// Theme the third-party diff viewer with OKIT's palette. Values are plain CSS
// so var() references resolve inside the modal like anywhere else.
const DIFF_STYLES: ReactDiffViewerStylesOverride = {
  variables: {
    light: {
      diffViewerBackground: 'var(--card-surface)',
      diffViewerColor: 'var(--ink)',
      // The lightweight version headers resolve through theme variables in snapshots.css.
      diffViewerTitleBackground: 'var(--snap-title-bg)',
      diffViewerTitleColor: 'var(--snap-title-fg)',
      diffViewerTitleBorderColor: 'var(--snap-divider)',
      gutterBackground: 'var(--snap-gutter-bg)',
      gutterBackgroundDark: 'color-mix(in srgb, var(--ink) 3%, transparent)',
      gutterColor: 'var(--ink-muted)',
      addedBackground: 'rgba(5, 150, 105, 0.07)',
      addedColor: 'var(--green)',
      addedGutterBackground: 'rgba(5, 150, 105, 0.07)',
      addedGutterColor: 'var(--green)',
      removedBackground: 'rgba(220, 38, 38, 0.07)',
      removedColor: 'var(--red)',
      removedGutterBackground: 'rgba(220, 38, 38, 0.07)',
      removedGutterColor: 'var(--red)',
      wordAddedBackground: 'rgba(5, 150, 105, 0.22)',
      wordRemovedBackground: 'rgba(220, 38, 38, 0.22)',
      codeFoldBackground: 'rgba(0, 0, 0, 0.035)',
      codeFoldGutterBackground: 'rgba(0, 0, 0, 0.035)',
    },
    dark: {
      diffViewerBackground: 'var(--card-surface)',
      diffViewerColor: 'var(--ink)',
      diffViewerTitleBackground: 'var(--snap-title-bg)',
      diffViewerTitleColor: 'var(--snap-title-fg)',
      diffViewerTitleBorderColor: 'var(--snap-divider)',
      gutterBackground: 'var(--snap-gutter-bg)',
      gutterBackgroundDark: 'rgba(255, 255, 255, 0.035)',
      gutterColor: 'var(--ink-muted)',
      addedBackground: 'rgba(52, 211, 153, 0.08)',
      addedColor: 'var(--green)',
      addedGutterBackground: 'rgba(52, 211, 153, 0.08)',
      addedGutterColor: 'var(--green)',
      removedBackground: 'rgba(248, 113, 113, 0.08)',
      removedColor: 'var(--red)',
      removedGutterBackground: 'rgba(248, 113, 113, 0.08)',
      removedGutterColor: 'var(--red)',
      wordAddedBackground: 'rgba(52, 211, 153, 0.28)',
      wordRemovedBackground: 'rgba(248, 113, 113, 0.28)',
      codeFoldBackground: 'rgba(255, 255, 255, 0.04)',
      codeFoldGutterBackground: 'rgba(255, 255, 255, 0.04)',
    },
  },
  diffContainer: {
    width: '100%',
    minWidth: 0,
    tableLayout: 'fixed',
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: '11.5px',
  },
  titleBlock: {
    display: 'flex',
    alignItems: 'center',
    height: '38px',
    padding: '0 14px',
    borderBottom: '1px solid var(--snap-divider)',
    fontFamily: 'var(--font)',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    '&:last-child:not(:only-child)': {
      borderLeft: '1px solid var(--snap-divider)',
    },
  },
  contentText: {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  gutter: {
    minWidth: '42px',
    width: '42px',
    padding: '0 7px',
  },
  marker: {
    width: '22px',
    paddingRight: '6px',
    paddingLeft: '6px',
  },
  // The lib renders the "no counterpart line" cells via backgroundColor, which
  // cannot carry a gradient. Draw the hatch ourselves through a theme-aware
  // CSS variable instead (see snapshots.css).
  emptyLine: {
    backgroundColor: 'transparent',
    backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 5px, var(--snap-hatch) 5px 10px)',
  },
};

function paneTitle(kind: 'old' | 'new', label: string) {
  return (
    <span className={`snapshots-pane-title snapshots-pane-title--${kind}`}>
      <i className="snapshots-pane-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

// Syntax-highlight languages understood by the viewer's Prism integration,
// keyed by file extension. Unknown extensions stay unhighlighted.
const HIGHLIGHT_LANGS: Record<string, string> = {
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
};

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// jsdiff's JSON mode canonicalizes (sorts keys) before comparing, so key
// reordering alone no longer shows up as a mass add/delete. It renders the
// canonicalized text, so only use it when both sides are strictly parseable;
// jsonc with comments or empty sides fall back to the line diff.
function jsonCompareMethod(file: SnapshotDetailFile): DiffMethod | undefined {
  const ext = fileExt(file.name);
  if (ext !== 'json' && ext !== 'jsonc') return undefined;
  try {
    JSON.parse(file.snapshotContent ?? 'null');
    JSON.parse(file.currentContent ?? 'null');
    return DiffMethod.JSON;
  } catch {
    return undefined;
  }
}

function changedLineCount(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/\r\n/g, '\n');
  return normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0);
}

function getLineChangeStats(file: SnapshotDetailFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(file.snapshotContent ?? '', file.currentContent ?? '')) {
    const count = change.count ?? changedLineCount(change.value);
    if (change.added) added += count;
    if (change.removed) removed += count;
  }
  return { added, removed };
}

// Snapshot ids look like "2026-08-20T03-34-47-123Z" (ISO with : and . replaced
// by -). Fold that back into a parseable timestamp and render in local time.
function formatSnapshotTime(iso: string): string {
  try {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/.exec(iso);
    if (!m) return iso;
    const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] || '000'}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  } catch {
    return iso;
  }
}

// Compact stamp for list rows: today → HH:mm, this year → MM-DD HH:mm,
// otherwise the date only. The modal keeps the full timestamp.
function formatShortTime(iso: string): string {
  const full = formatSnapshotTime(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(full);
  if (!m) return full;
  const now = new Date();
  const [, y, mo, d, hh, mm] = m;
  const sameDay = Number(y) === now.getFullYear()
    && Number(mo) === now.getMonth() + 1
    && Number(d) === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  if (Number(y) === now.getFullYear()) return `${mo}-${d} ${hh}:${mm}`;
  return `${y}-${mo}-${d}`;
}

function formatTimelineTime(iso: string): string {
  const full = formatSnapshotTime(iso);
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})$/.exec(full);
  return m?.[1] || formatShortTime(iso);
}

function snapshotFileSummary(files: Snapshot['files']): string {
  if (files.length === 0) return '—';
  const names = files.map(file => file.name);
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} · +${names.length - 2}`;
}

function snapshotDayKey(iso: string): string {
  return formatSnapshotTime(iso).slice(0, 10);
}

function formatSnapshotDay(iso: string, lang: 'zh' | 'en', t: (key: string) => string): string {
  const key = snapshotDayKey(iso);
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (offset === 0) return t('settings.snapshots.today');
  if (offset === 1) return t('settings.snapshots.yesterday');

  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

type SnapshotItem = Snapshot & { agentId: string; agentName: string };

export default function SnapshotsSection() {
  const { showToast, confirm, theme } = useApp() as any;
  const { t, lang } = useI18n();

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // '' means "all agents" — the default landing view shows every snapshot.
  const [filterAgent, setFilterAgent] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<SnapshotDetailFile[] | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTime, setDetailTime] = useState('');
  const [detailAgentName, setDetailAgentName] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSnapshot, setDetailSnapshot] = useState<SnapshotItem | null>(null);
  const [activeFile, setActiveFile] = useState(0);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAdapters();
        if (cancelled) return;
        setAgents(data.adapters || []);
      } catch { /* server unreachable; keep empty state */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const reloadSnapshots = useCallback(async () => {
    if (agents.length === 0) return;
    setListLoading(true);
    const targets = filterAgent ? agents.filter(a => a.id === filterAgent) : agents;
    const results = await Promise.all(targets.map(async a => {
      try {
        const data = await listSnapshots(a.id);
        return (data.snapshots || []).map(s => ({ ...s, agentId: a.id, agentName: a.name }));
      } catch { return [] as SnapshotItem[]; }
    }));
    setSnapshots(results.flat().sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
    setListLoading(false);
  }, [agents, filterAgent]);

  useEffect(() => {
    reloadSnapshots();
  }, [reloadSnapshots]);

  async function openDetail(snapshot: SnapshotItem) {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setActiveFile(0);
    setDetailSnapshot(snapshot);
    setDetailTime(formatSnapshotTime(snapshot.createdAt));
    setDetailAgentName(snapshot.agentName);
    try {
      const data = await getSnapshotDetail(snapshot.agentId, snapshot.id);
      setDetail(data.files || []);
    } catch {
      setDetail([]);
      showToast(t('settings.snapshots.restoreFail'), 'error');
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetailOpen(false);
    setDetail(null);
    setDetailSnapshot(null);
  }

  async function handleRestore(snapshot: SnapshotItem) {
    if (restoring) return;
    const ok = await confirm(t('settings.snapshots.confirmBody'), {
      title: t('settings.snapshots.confirmTitle'),
      type: 'warning',
    });
    if (!ok) return;
    setRestoring(true);
    try {
      await restoreSnapshot(snapshot.agentId, snapshot.id);
      showToast(t('settings.snapshots.restoreOk'), 'success');
      if (detailOpen) closeDetail();
      await reloadSnapshots();
    } catch {
      showToast(t('settings.snapshots.restoreFail'), 'error');
    } finally {
      setRestoring(false);
    }
  }

  const snapshotGroups = snapshots.reduce<Array<{ key: string; label: string; items: SnapshotItem[] }>>((groups, snapshot) => {
    const key = snapshotDayKey(snapshot.createdAt);
    const current = groups[groups.length - 1];
    if (current?.key === key) {
      current.items.push(snapshot);
    } else {
      groups.push({
        key,
        label: formatSnapshotDay(snapshot.createdAt, lang, t),
        items: [snapshot],
      });
    }
    return groups;
  }, []);

  return (
    <div className="settings-section" id="snapshots">
      <div className="settings-block">
        <header className="settings-page-header">
          <span className="settings-page-eyebrow"><History size={14} />{t('settings.snapshots.eyebrow')}</span>
          <h2>{t('settings.snapshots.title')}</h2>
          <p>{t('settings.snapshots.description')}</p>
        </header>
        <div className="settings-card snapshots-card">
          <div className="snapshots-toolbar">
            <div className="snapshots-overview">
              <span className="snapshots-overview-icon" aria-hidden="true"><History size={17} strokeWidth={1.7} /></span>
              <div>
                <strong>{snapshots.length}</strong>
                <span>{t('settings.snapshots.versions')}</span>
              </div>
            </div>
            <div className="settings-block-head-controls">
              <CustomSelect
                className="settings-select-wrap snapshots-select-wrap"
                value={filterAgent}
                onChange={setFilterAgent}
                placeholder={t('settings.snapshots.selectAgent')}
                options={[
                  { value: '', label: t('settings.snapshots.allAgents') },
                  ...agents.map(a => ({ value: a.id, label: a.name })),
                ]}
              />
            </div>
          </div>
          <div className="settings-card-body snapshots-card-body">
            {listLoading && snapshots.length === 0 ? (
              <div className="snapshots-empty">{t('settings.snapshots.loading')}</div>
            ) : snapshots.length === 0 ? (
              <div className="snapshots-empty">{t('settings.snapshots.empty')}</div>
            ) : (
              <div className="snapshots-timeline">
                {snapshotGroups.map(group => (
                  <section key={group.key} className="snapshots-group">
                    <div className="snapshots-group-head">
                      <span>{group.label}</span>
                      <span>{t('settings.snapshots.groupCount', { n: group.items.length })}</span>
                    </div>
                    <div className="snapshots-list">
                      {group.items.map(snapshot => (
                        <div key={`${snapshot.agentId}/${snapshot.id}`} className="snapshots-item">
                          <div className="snapshots-item-info">
                            <span className="snapshots-item-avatar" aria-hidden="true">
                              {getAgentIcon(snapshot.agentId) ? (
                                <img
                                  src={getAgentIcon(snapshot.agentId)}
                                  className={getAgentIconClass(snapshot.agentId)}
                                  alt=""
                                  draggable={false}
                                />
                              ) : snapshot.agentName.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="snapshots-item-copy">
                              <strong className="snapshots-item-agent">{snapshot.agentName}</strong>
                              <small title={snapshot.files.map(file => file.name).join(' · ')}>{snapshotFileSummary(snapshot.files)}</small>
                            </span>
                          </div>
                          <span className="snapshots-item-time">
                            <Clock3 size={13} strokeWidth={1.7} />
                            {formatTimelineTime(snapshot.createdAt)}
                          </span>
                          <div className="snapshots-item-actions">
                            <button
                              type="button"
                              className="snapshots-btn"
                              aria-label={`${t('settings.snapshots.viewChanges')} · ${snapshot.agentName}`}
                              title={t('settings.snapshots.viewChanges')}
                              onClick={() => openDetail(snapshot)}
                            >
                              <Eye size={14} strokeWidth={1.8} />
                            </button>
                            <button
                              type="button"
                              className="snapshots-btn snapshots-btn--restore"
                              aria-label={`${t('settings.snapshots.restore')} · ${snapshot.agentName}`}
                              title={t('settings.snapshots.restore')}
                              onClick={() => handleRestore(snapshot)}
                              disabled={restoring}
                            >
                              <RotateCcw size={14} strokeWidth={1.8} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {detailOpen && (
        <div className="usage-guide-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) closeDetail(); }}>
          <section className="usage-guide-panel snapshots-modal" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            {(() => {
              const files = detail || [];
              const current = files[Math.min(activeFile, Math.max(files.length - 1, 0))] ?? null;
              const changeStats = current ? getLineChangeStats(current) : { added: 0, removed: 0 };
              return (
                <>
                  <div className="snapshots-topbar">
                    <div className="snapshots-topbar-heading">
                      <span className="snapshots-topbar-icon" aria-hidden="true">
                        <GitCompareArrows size={17} strokeWidth={1.7} />
                      </span>
                      <div>
                        <strong className="snapshots-topbar-label">{detailAgentName}</strong>
                        <span className="snapshots-topbar-time">{detailTime}</span>
                      </div>
                    </div>
                    <div className="snapshots-topbar-file">
                      {files.length > 1 && (
                        <div className="snapshots-topbar-tabs" role="tablist">
                          {files.map((f, i) => (
                            <button
                              key={f.name}
                              type="button"
                              role="tab"
                              aria-selected={i === activeFile}
                              className={`snapshots-tab${i === activeFile ? ' snapshots-tab--active' : ''}`}
                              onClick={() => setActiveFile(i)}
                            >
                              {f.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {files.length === 1 && current && (
                        <span className="snapshots-current-file">{current.name}</span>
                      )}
                      {current && current.currentContent == null && (
                        <span className="snapshots-file-missing">{t('settings.snapshots.fileMissing')}</span>
                      )}
                      {detailSnapshot && (
                        <button
                          type="button"
                          className="snapshots-topbar-restore"
                          onClick={() => handleRestore(detailSnapshot)}
                          disabled={restoring || detailLoading}
                        >
                          <RotateCcw size={14} strokeWidth={1.8} />
                          {t('settings.snapshots.restore')}
                        </button>
                      )}
                      <button className="snapshots-topbar-close" type="button" onClick={closeDetail} aria-label={t('common.close')}>
                        <X size={16} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>
                  {detailLoading ? (
                    <div className="snapshots-detail snapshots-detail--loading">{t('settings.snapshots.loading')}</div>
                  ) : current ? (
                    <div className="snapshots-detail">
                      <div className="snapshots-diffwrap">
                        <div className="snapshots-change-summary" role="status">
                          <span className="snapshots-change-summary-label">{t('settings.snapshots.changeSummary')}</span>
                          <span className="snapshots-change-stat snapshots-change-stat--removed">
                            <i aria-hidden="true" />
                            {t('settings.snapshots.removedLines', { n: changeStats.removed })}
                          </span>
                          <span className="snapshots-change-stat snapshots-change-stat--added">
                            <i aria-hidden="true" />
                            {t('settings.snapshots.addedLines', { n: changeStats.added })}
                          </span>
                        </div>
                        <ReactDiffViewer
                          oldValue={current.snapshotContent ?? ''}
                          newValue={current.currentContent ?? ''}
                          splitView
                          hideSummary
                          showDiffOnly={false}
                          disableWorker
                          useDarkTheme={theme === 'dark'}
                          compareMethod={jsonCompareMethod(current) ?? undefined}
                          highlightLanguage={HIGHLIGHT_LANGS[fileExt(current.name)]}
                          leftTitle={paneTitle('old', t('settings.snapshots.paneSnapshot'))}
                          rightTitle={paneTitle('new', t('settings.snapshots.paneCurrent'))}
                          styles={DIFF_STYLES}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="snapshots-detail snapshots-detail--loading">{t('settings.snapshots.noFiles')}</div>
                  )}
                </>
              );
            })()}
          </section>
        </div>
      )}
    </div>
  );
}
