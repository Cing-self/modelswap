import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, Database, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { getModelData, refreshDemoProviderModels, refreshModelData, ModelDataProvider, ModelDataRecord, ModelDataSnapshot } from '../../api/providers';
import { useDataChanged } from '../../hooks/useDataChanged';
import { useApp } from '../Layout/AppContext';

const SOURCE_LABELS: Record<string, string> = {
  remote: '平台接口',
  modelsdev: 'models.dev',
  preset: '内置',
  manual: '手动',
  legacy: '旧数据',
  unknown: '未知',
};

function formatTokens(value?: number) {
  if (!Number.isFinite(value)) return '—';
  if ((value as number) >= 1_000_000) return `${+((value as number) / 1_000_000).toFixed(2)}M`;
  if ((value as number) >= 1024) return `${Math.round((value as number) / 1024)}K`;
  return String(value);
}

function fact(value: boolean | undefined) {
  if (value === true) return <span className="model-data-bool is-yes">是</span>;
  if (value === false) return <span className="model-data-bool is-no">否</span>;
  return <span className="model-data-empty">—</span>;
}

function formatCost(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toLocaleString()}` : '—';
}

function optionLabel(option: NonNullable<ModelDataRecord['reasoningOptions']>[number]) {
  if (option.type === 'toggle') return '开关';
  if (option.type === 'effort') return option.values?.join(' / ') || '等级';
  if (option.type === 'budget_tokens') {
    if (option.min != null || option.max != null) return `${formatTokens(option.min)} – ${formatTokens(option.max)}`;
    return 'Token 预算';
  }
  return option.type;
}

function DataFact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return <div className="model-data-fact"><dt>{label}</dt><dd className={mono ? 'is-mono' : ''}>{value ?? '—'}</dd></div>;
}

function Capability({ label, value }: { label: string; value: boolean | undefined }) {
  return (
    <span className={`model-data-capability ${value === true ? 'is-on' : value === false ? 'is-off' : 'is-unknown'}`}>
      <i />{label}<b>{value === true ? '支持' : value === false ? '不支持' : '未知'}</b>
    </span>
  );
}

function coverage(provider: ModelDataProvider) {
  const total = provider.models.length || 1;
  const known = provider.models.filter(model =>
    Number.isFinite(model.context)
    || Number.isFinite(model.output)
    || typeof model.reasoning === 'boolean'
    || typeof model.tool === 'boolean'
    || Boolean(model.modalities)
  ).length;
  return Math.round((known / total) * 100);
}

function ModelRow({ model }: { model: ModelDataRecord }) {
  const [open, setOpen] = useState(false);
  const inputModes = model.modalities?.input || [];
  const outputModes = model.modalities?.output || [];
  const costs = model.cost || {};
  const primaryCosts = [
    ['输入', costs.input], ['输出', costs.output], ['缓存读取', costs.cache_read],
    ['缓存写入', costs.cache_write], ['音频输入', costs.input_audio],
    ['音频输出', costs.output_audio], ['推理', costs.reasoning],
  ].filter(([, value]) => typeof value === 'number');
  const advancedCosts = Object.fromEntries(Object.entries(costs).filter(([key]) => ![
    'input', 'output', 'cache_read', 'cache_write', 'input_audio', 'output_audio', 'reasoning',
  ].includes(key)));
  return (
    <div className={`model-data-row${open ? ' is-open' : ''}`}>
      <button type="button" className="model-data-row-main" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className="model-data-model-name">
          <strong>{model.name || model.id}</strong>
          {model.name && model.name !== model.id && <code>{model.id}</code>}
        </span>
        <span className="model-data-family-cell">
          <i className={`model-data-source source-${model.source}`}>{SOURCE_LABELS[model.source] || model.source}</i>
          {model.family && <small>{model.family}</small>}
        </span>
        <span className="model-data-number">{formatTokens(model.context)}</span>
        <span className="model-data-number">{formatTokens(model.input)} / {formatTokens(model.output)}</span>
        <span>{fact(model.reasoning)}</span>
        <span>{fact(model.tool)}</span>
        <span className="model-data-date-cell">{model.lastUpdated || '—'}</span>
        <ChevronDown size={15} className="model-data-chevron" />
      </button>
      {open && (
        <div className="model-data-row-detail">
          <div className="model-data-detail-lead">
            <p>{model.description || 'models.dev 没有提供模型描述。'}</p>
            <div>
              {model.status && <span>{model.status}</span>}
              {model.experimental && <span>实验性</span>}
              {model.selectedBy.map(agent => <span key={agent}>{agent}</span>)}
            </div>
          </div>

          <div className="model-data-detail-grid">
            <section>
              <h3>能力</h3>
              <div className="model-data-capabilities">
                <Capability label="附件" value={model.attachment} />
                <Capability label="推理" value={model.reasoning} />
                <Capability label="工具调用" value={model.tool} />
                <Capability label="结构化输出" value={model.structuredOutput} />
                <Capability label="温度参数" value={model.temperature} />
                <Capability label="开放权重" value={model.openWeights} />
              </div>
            </section>

            <section>
              <h3>推理方式</h3>
              <div className="model-data-option-list">
                {model.reasoningOptions?.length
                  ? model.reasoningOptions.map((option, index) => (
                    <span key={`${option.type}-${index}`}><b>{option.type}</b>{optionLabel(option)}</span>
                  ))
                  : <em>未提供</em>}
              </div>
              {model.interleaved?.field && <p className="model-data-inline-note">交错推理字段 <code>{model.interleaved.field}</code></p>}
            </section>

            <section>
              <h3>Token 限制</h3>
              <dl className="model-data-facts">
                <DataFact label="上下文" value={formatTokens(model.context)} mono />
                <DataFact label="最大输入" value={formatTokens(model.input)} mono />
                <DataFact label="最大输出" value={formatTokens(model.output)} mono />
              </dl>
              <div className="model-data-modalities">
                <span>输入</span>{inputModes.length ? inputModes.map(mode => <i key={mode}>{mode}</i>) : <em>—</em>}
                <span>输出</span>{outputModes.length ? outputModes.map(mode => <i key={mode}>{mode}</i>) : <em>—</em>}
              </div>
            </section>

            <section>
              <h3>生命周期</h3>
              <dl className="model-data-facts">
                <DataFact label="知识截止" value={model.knowledge || '—'} mono />
                <DataFact label="发布日期" value={model.releaseDate || '—'} mono />
                <DataFact label="最后更新" value={model.lastUpdated || '—'} mono />
                <DataFact label="状态" value={model.status || '—'} mono />
              </dl>
            </section>

            <section className="model-data-cost-section">
              <h3>价格 <small>每百万 Tokens</small></h3>
              {primaryCosts.length ? (
                <dl className="model-data-costs">
                  {primaryCosts.map(([label, value]) => <DataFact key={String(label)} label={String(label)} value={formatCost(value)} mono />)}
                </dl>
              ) : <em>未提供价格</em>}
              {Object.keys(advancedCosts).length > 0 && (
                <details className="model-data-json-block"><summary>阶梯及长上下文价格</summary><pre>{JSON.stringify(advancedCosts, null, 2)}</pre></details>
              )}
            </section>

            <section>
              <h3>采集信息</h3>
              <dl className="model-data-facts">
                <DataFact label="来源" value={SOURCE_LABELS[model.source] || model.source} />
                <DataFact label="可信度" value={model.confidence || '—'} />
                <DataFact label="采集时间" value={model.fetchedAt ? new Date(model.fetchedAt).toLocaleString() : '—'} mono />
              </dl>
            </section>
          </div>

          {(model.providerConfig || model.experimental) && (
            <div className="model-data-special-config">
              {model.providerConfig && <details className="model-data-json-block"><summary>平台专用配置</summary><pre>{JSON.stringify(model.providerConfig, null, 2)}</pre></details>}
              {model.experimental && <details className="model-data-json-block"><summary>实验性配置</summary><pre>{JSON.stringify(model.experimental, null, 2)}</pre></details>}
            </div>
          )}

          <details className="model-data-raw">
            <summary>查看本次采集原始响应</summary>
            <pre>{JSON.stringify(model.raw ?? model, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

export default function ModelDataPage() {
  const { showToast } = useApp();
  const [snapshot, setSnapshot] = useState<ModelDataSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const data = fresh ? await refreshModelData() : await getModelData();
      setSnapshot(data);
      setActiveId(current => current && data.providers.some(provider => provider.id === current)
        ? current
        : data.providers.find(provider => provider.models.length > 0)?.id || data.providers[0]?.id || null);
    } catch (error: any) {
      showToast(error.message || '模型数据读取失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(true); }, [load]);
  useDataChanged(['providers', 'agents'], load);

  const providers = useMemo(() => {
    if (!snapshot) return [];
    const search = query.trim().toLowerCase();
    return snapshot.providers
      .filter(provider => !search
        || provider.id.toLowerCase().includes(search)
        || provider.name.toLowerCase().includes(search)
        || provider.models.some(model => model.id.toLowerCase().includes(search) || model.name?.toLowerCase().includes(search)))
      .sort((a, b) => {
        if (search) {
          const aExact = a.id.toLowerCase() === search || a.name.toLowerCase() === search;
          const bExact = b.id.toLowerCase() === search || b.name.toLowerCase() === search;
          if (aExact !== bExact) return aExact ? -1 : 1;
        }
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
  }, [snapshot, query]);

  const active = providers.find(provider => provider.id === activeId) || providers[0];
  const activeModels = useMemo(() => {
    if (!active) return [];
    const search = query.trim().toLowerCase();
    return active.models
      .filter(model => !search || model.id.toLowerCase().includes(search) || model.name?.toLowerCase().includes(search))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [active, query]);

  async function refreshActive() {
    if (!active || active.executionMode === 'agent_native') return;
    setRefreshing(true);
    try {
      const result = await refreshDemoProviderModels(active.id);
      if (result.success) showToast(`已从 ${active.name} 拉取 ${result.provider.models.length} 个模型`, 'success');
      await load();
    } catch (error: any) {
      showToast(error.message || '模型拉取失败', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshAll() {
    setRefreshingAll(true);
    try {
      const data = await refreshModelData();
      setSnapshot(data);
      showToast(`已重新联网采集 ${data.summary.models} 条模型记录`, 'success');
    } catch (error: any) {
      showToast(error.message || '全新数据采集失败', 'error');
    } finally {
      setRefreshingAll(false);
    }
  }

  if (loading || !snapshot) {
    return (
      <div className="model-data-page model-data-loading" aria-busy="true">
        <div className="skeleton-line route-skeleton-vault-title" />
        <div className="model-data-shell">
          <div className="model-data-provider-index" />
          <div className="model-data-inspector" />
        </div>
      </div>
    );
  }

  const summary = snapshot.summary;
  const knownFacts = summary.withContext + summary.withOutput + summary.withReasoning + summary.withTool + summary.withModalities;
  const possibleFacts = Math.max(summary.models * 5, 1);
  const knownPercent = Math.round((knownFacts / possibleFacts) * 100);

  return (
    <div className="model-data-page">
      <header className="model-data-header">
        <div>
          <span className="model-data-eyebrow"><Database size={13} /> LIVE MODEL DATA</span>
          <h1>模型与平台</h1>
          <p>与首页、模型管控和 Agent 配置共用同一代模型数据。</p>
        </div>
        <div className="model-data-header-actions">
          <div className="model-data-summary">
          <div><strong>{summary.providers}</strong><span>平台</span></div>
          <div><strong>{summary.models}</strong><span>模型记录</span></div>
          <div className={knownPercent < 30 ? 'is-warning' : ''}><strong>{knownPercent}%</strong><span>能力字段</span></div>
          </div>
          <button type="button" className="model-data-refresh-all" onClick={refreshAll} disabled={refreshingAll}>
            <RefreshCw size={15} className={refreshingAll ? 'is-spinning' : ''} />
            {refreshingAll ? '正在采集' : '重新联网采集'}
          </button>
        </div>
      </header>

      <div className="model-data-source-line">
        <code>{snapshot.cache.file}</code>
        <span>v{snapshot.cache.version}</span>
        <span>{snapshot.cache.source}</span>
        {snapshot.cache.generation !== undefined && <span>generation {snapshot.cache.generation}</span>}
        {snapshot.cache.status && <span>{snapshot.cache.status}</span>}
        <span>{snapshot.cache.sourceFetchedAt ? new Date(snapshot.cache.sourceFetchedAt).toLocaleString() : '尚未联网采集'}</span>
        {snapshot.cache.lastError && <span title={snapshot.cache.lastError}>上次刷新失败</span>}
      </div>

      <div className="model-data-shell">
        <aside className="model-data-provider-index">
          <label className="model-data-search">
            <Search size={15} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="平台或模型 ID" />
          </label>
          <div className="model-data-provider-list">
            {providers.map(provider => {
              const providerCoverage = coverage(provider);
              return (
                <button
                  type="button"
                  key={provider.id}
                  className={provider.id === active?.id ? 'is-active' : ''}
                  onClick={() => setActiveId(provider.id)}
                >
                  <span><strong>{provider.name}</strong><code>{provider.id}</code></span>
                  <span className="model-data-provider-count">{provider.models.length}</span>
                  <i style={{ '--coverage': `${providerCoverage}%` } as CSSProperties} />
                </button>
              );
            })}
          </div>
        </aside>

        <section className="model-data-inspector">
          {active ? (
            <>
              <div className="model-data-provider-head">
                <div>
                  <span className="model-data-provider-kicker">{active.type} · {active.executionMode}</span>
                  <h2>{active.name}</h2>
                  <code>{active.id}</code>
                </div>
                <button type="button" onClick={refreshActive} disabled={refreshing || active.executionMode === 'agent_native'}>
                  <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} />
                  {refreshing ? '正在拉取' : '从平台刷新'}
                </button>
              </div>

              <div className="model-data-provider-meta">
                <div className="model-data-endpoints">
                  {active.endpoints.length
                    ? active.endpoints.map(endpoint => <code key={endpoint.id}>{endpoint.type}{endpoint.protocol ? `/${endpoint.protocol}` : ''} · {endpoint.baseUrl}</code>)
                    : <code>Agent 原生目录</code>}
                </div>
                <div className="model-data-sources">
                  {Object.entries(active.sources).map(([source, count]) => (
                    <span key={source}><i className={`model-data-source source-${source}`}>{SOURCE_LABELS[source] || source}</i>{count}</span>
                  ))}
                </div>
              </div>

              {active.catalog && (
                <div className="model-data-catalog-strip">
                  <span><small>models.dev</small><strong>{active.catalog.name || active.catalog.id || active.catalog.key}</strong><code>{active.catalog.key}</code></span>
                  {active.catalog.api && <span><small>API</small><code>{active.catalog.api}</code></span>}
                  {active.catalog.npm && <span><small>SDK</small><code>{active.catalog.npm}</code></span>}
                  {active.catalog.env.length > 0 && <span><small>环境变量</small><code>{active.catalog.env.join(' · ')}</code></span>}
                  {active.catalog.doc && <a href={active.catalog.doc} target="_blank" rel="noreferrer">文档 <ExternalLink size={12} /></a>}
                </div>
              )}

              <div className="model-data-columns" aria-hidden="true">
                <span>模型</span><span>来源 / 系列</span><span>上下文</span><span>输入 / 输出</span><span>推理</span><span>工具</span><span>最后更新</span><span />
              </div>
              <div className="model-data-rows">
                {activeModels.map(model => <ModelRow key={model.id} model={model} />)}
                {activeModels.length === 0 && <div className="model-data-empty-state">本次采集没有匹配的模型记录</div>}
              </div>
            </>
          ) : <div className="model-data-empty-state">没有平台数据</div>}
        </section>
      </div>
    </div>
  );
}
