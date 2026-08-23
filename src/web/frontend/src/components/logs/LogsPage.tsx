import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, Download, RefreshCw, Search } from 'lucide-react';
import { getLogs, type LogEntry } from '../../api/logs';
import { presentLog } from '../../lib/logPresentation';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';

type StatusFilter = 'all' | 'success' | 'failed';

export default function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const { setConnectionStatus } = useApp();
  const { t, lang } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => { loadLogs(); }, []);

  async function loadLogs(manual = false) {
    manual ? setRefreshing(true) : setLoading(true);
    try {
      const data = await getLogs();
      setLogs(data);
      setConnectionStatus('connected');
    } catch {
      setConnectionStatus('error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function getLogKey(log: LogEntry, i: number) {
    return `${log.timestamp || 'log'}-${log.name || 'target'}-${i}`;
  }

  function toggleRow(key: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function formatTimeParts(ts: string) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return { date: '--/--', time: '--:--:--' };
    const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
    return {
      date: date.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' }),
      time: date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    };
  }

  function formatDuration(ms: number | undefined) {
    if (!ms) return '—';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  function compactText(value: string, length = 120) {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function exportLogs() {
    const payload = { exportedAt: new Date().toISOString(), source: 'OKIT', logs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `okit-logs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const logStats = useMemo(() => {
    const failed = logs.filter(log => !log.success).length;
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentFailed = logs.filter(log => !log.success && new Date(log.timestamp).getTime() >= recentCutoff).length;
    const todayKey = new Date().toDateString();
    const today = logs.filter(log => new Date(log.timestamp).toDateString() === todayKey).length;
    const syncEvents = logs.filter(log => presentLog(log, t).category === 'sync').length;
    return { failed, recentFailed, today, syncEvents };
  }, [logs, t]);

  const filteredLogs = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return logs.filter(log => {
      if (statusFilter === 'success' && !log.success) return false;
      if (statusFilter === 'failed' && log.success) return false;
      if (!query) return true;
      const presentation = presentLog(log, t);
      return [presentation.title, presentation.target, presentation.summary, log.name, log.action, log.timestamp, log.duration, log.command, log.output, log.message]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }, [logs, searchTerm, statusFilter, t]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedLogs = filteredLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const resultStart = filteredLogs.length ? (currentPage - 1) * pageSize + 1 : 0;
  const resultEnd = Math.min(currentPage * pageSize, filteredLogs.length);

  if (loading) return <div className="logs-loading"><Activity size={17} />{t('common.loading')}</div>;

  return (
    <div className={`logs-workspace${embedded ? ' logs-workspace--embedded' : ''}`}>
      <section className="logs-overview" aria-label={t('logs.summary')}>
        <div className="logs-overview-copy">
          <span className={`logs-health-mark${logStats.recentFailed ? ' logs-health-mark--warn' : ''}`} aria-hidden="true" />
          <div>
            <strong>{logStats.recentFailed ? t('logs.healthIssuesRecent', { n: logStats.recentFailed }) : t('logs.healthOk')}</strong>
            <span>{t('logs.lede')}</span>
            {logStats.recentFailed > 0 && (
              <button
                type="button"
                className="logs-overview-action"
                onClick={() => { setStatusFilter(statusFilter === 'failed' ? 'all' : 'failed'); setPage(1); }}
              >
                {statusFilter === 'failed' ? t('logs.viewAll') : t('logs.viewFailures')}
              </button>
            )}
          </div>
        </div>
        <div className="logs-metrics">
          <div><span>{t('common.total')}</span><strong>{logs.length}</strong></div>
          <div className={logStats.failed ? 'is-danger' : ''}><span>{t('logs.failed')}</span><strong>{logStats.failed}</strong></div>
          <div><span>{t('logs.today')}</span><strong>{logStats.today}</strong></div>
          <div><span>{t('logs.syncEvents')}</span><strong>{logStats.syncEvents}</strong></div>
        </div>
      </section>

      <section className="logs-console">
        <header className="logs-toolbar">
          <label className="logs-search">
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            <input type="search" aria-label={t('logs.searchPlaceholder')} value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setPage(1); }} placeholder={t('logs.searchPlaceholder')} />
          </label>
          <div className="logs-filter" role="group" aria-label={t('logs.status')}>
            {(['all', 'success', 'failed'] as StatusFilter[]).map(filter => (
              <button key={filter} type="button" aria-pressed={statusFilter === filter} className={statusFilter === filter ? 'is-active' : ''} onClick={() => { setStatusFilter(filter); setPage(1); }}>
                {t(`logs.filter.${filter}`)}
              </button>
            ))}
          </div>
          <div className="logs-toolbar-actions">
            <button type="button" onClick={() => loadLogs(true)} disabled={refreshing} title={t('logs.refresh')}>
              <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} /><span>{t('logs.refresh')}</span>
            </button>
            <button className="logs-export-btn" type="button" onClick={exportLogs}>
              <Download size={15} /><span>{t('logs.export')}</span>
            </button>
          </div>
        </header>

        <div className="logs-stream" role="list">
          {paginatedLogs.length === 0 ? (
            <div className="logs-empty"><Search size={22} strokeWidth={1.5} /><strong>{t('logs.noRecords')}</strong><span>{t('logs.noRecordsHint')}</span></div>
          ) : paginatedLogs.map((log, index) => {
            const absoluteIndex = (currentPage - 1) * pageSize + index;
            const rowKey = getLogKey(log, absoluteIndex);
            const presentation = presentLog(log, t);
            const outputText = log.output || log.message || '';
            const command = log.command || '';
            const hasDetails = Boolean(command || outputText || presentation.technicalId);
            const isExpanded = expandedRows.has(rowKey);
            const time = formatTimeParts(log.timestamp);
            return (
              <article key={rowKey} className={`log-entry${log.success ? '' : ' log-entry--failed'}${isExpanded ? ' is-expanded' : ''}`} role="listitem">
                <button type="button" className="log-entry-main" onClick={() => hasDetails && toggleRow(rowKey)} aria-expanded={hasDetails ? isExpanded : undefined} disabled={!hasDetails}>
                  <time className="log-entry-time" dateTime={log.timestamp}><span>{time.date}</span><strong>{time.time}</strong></time>
                  <span className="log-entry-status" aria-label={log.success ? t('common.success') : t('common.failed')}>
                    {log.success ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                  </span>
                  <span className="log-entry-body">
                    <span className="log-entry-heading"><strong>{presentation.title}</strong><span className="log-action-tag">{presentation.target}</span></span>
                    <span className="log-entry-summary">{compactText(presentation.summary)}</span>
                  </span>
                  <span className="log-entry-meta"><span>{formatDuration(log.duration)}</span>{hasDetails && <ChevronDown size={15} className="log-entry-chevron" />}</span>
                </button>
                {isExpanded && (
                  <div className="log-entry-details">
                    {command && <div><span>{t('logs.command')}</span><code>{command}</code></div>}
                    {outputText && <div><span>{t('logs.rawDetail')}</span><pre>{outputText}</pre></div>}
                    <div><span>{t('logs.technicalInfo')}</span><code>{presentation.technicalId}</code></div>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <footer className="logs-pagination">
          <span>{t('logs.showing', { start: resultStart, end: resultEnd, total: filteredLogs.length })}</span>
          <div className="logs-pagination-actions">
            <label className="logs-page-size"><span>{t('logs.pageSize')}</span><select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
            <button onClick={() => setPage(value => Math.max(1, value - 1))} disabled={currentPage <= 1}>{t('logs.prev')}</button>
            <span>{currentPage} / {totalPages}</span>
            <button onClick={() => setPage(value => Math.min(totalPages, value + 1))} disabled={currentPage >= totalPages}>{t('logs.next')}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
