# ModelSwap 当前架构盘点（重构前基线）

> 基线：`main` 的 `f49edca`（2026-08-27）  
> 范围：全部 346 个 Git 跟踪文件。完整逐文件职责与静态调用关系见 [文件目录](./current-codebase-file-catalog.md)；完整机器可读调用边见 [Import Graph](./current-source-import-graph.json)。

## 当前系统入口

| 入口 | 组合根 | 主要职责 |
| --- | --- | --- |
| CLI | `src/main.ts` | 注册 `src/commands/*`，直接调用 Provider、Vault、Sync 等模块。 |
| Web | `src/web/server.js` | 启动 Express、挂载 `src/web/api/*`、静态前端、SSE/WS 与同步调度器。 |
| Desktop | `src/electron/main.ts` + `preload.ts` | 管理窗口、标题栏、更新下载和前端桥接。 |
| React | `src/web/frontend/src/main.tsx` + `App.tsx` | 路由、常驻页面、页面级 API 请求与数据变更订阅。 |
| 浏览器扩展 | `extension/src/*` | CDP/用量数据采集，通过扩展专用 WebSocket 连接本地 Web 服务。 |

## 主调用链

### 站点、模型与 Agent 配置（本机页面/CLI）

```text
HomePage / ModelsPage / CLI provider command
  → src/web/api/providers.js
  → loadProviders + resolveModel/resolveModelRoute + Vault 授权
  → Agent adapter（Codex / Claude / OpenCode / …）
  → Agent 原生配置文件
  → saveUserConfig(user.json) + log + data-changed 事件
```

这条链路目前包含模型路由、模型能力参数、密钥验证、快照恢复和实际原生配置写入；它是目前唯一能让 Agent 真正生效的链路。

### 多机同步（当前实现）

```text
syncPull / 自动同步调度器
  → 解密远端 blob
  → VaultStore 写入密钥
  → mergeProvidersConfig 写入站点目录
  → 直接写入 user.json 的 agentProviders / modelOverrides
  → publishDataChanged（页面刷新）
```

**当前缺口**：此链路没有调用 Agent adapter。因此页面显示了远端选择，但 B 机的 `~/.codex`、`~/.claude`、`~/.config/opencode` 等文件不会同步更新。

### 模型目录与数据来源

```text
providers.json：用户站点、端点、密钥引用（持久化）
models-cache.json：可重建模型目录与能力事实（本地缓存）
models.dev / 站点模型接口：模型目录与能力信息来源
user.json：Agent 已选站点、已选模型、覆盖值、同步设置（用户意图）
```

`providers.json` 不再承担模型事实；实际运行时由 Provider Store + Model Resolver 组合站点、缓存和用户覆盖值。

## 当前职责边界问题

| 模块 | 当前混合职责 | 导致的问题 |
| --- | --- | --- |
| `src/web/api/providers.js` | HTTP、选择状态、模型路由、密钥校验、快照、Adapter 写入、日志、同步脏标记 | 任何新入口都容易绕过某一环；文件继续膨胀。 |
| `src/web/api/cloud-sync-core.js` | 传输、加密、同步合并、配置持久化、事件通知 | 直接落 `user.json`，没有统一的 Agent 原生配置下发。 |
| `src/commands/provider.ts` | CLI 输入处理和部分 Provider/Adapter 编排 | 与 Web 的业务规则存在分叉风险。 |
| `src/providers/*` | 数据模型、缓存、路由、Adapter、快照分散但可复用 | 具备领域层雏形，但没有被统一的应用服务收口。 |

## 优先拆分热点（非按文件大小机械拆）

| 文件 | 当前行数 | 优先原因 |
| --- | ---: | --- |
| `src/web/api/auto-create.js` | 5,735 | 自动建号流程、浏览器自动化、平台策略与 HTTP 响应耦合，独立风险最高。 |
| `src/web/api/providers.js` | 2,681 | 本次同步缺口的直接来源；应首先抽离 Agent 配置应用服务和 Provider 查询/管理服务。 |
| `src/web/api/usage.js` | 2,123 | 多平台用量查询、鉴权、解析、缓存与 HTTP 边界混合。 |
| `src/web/api/cloud-sync-core.js` | 626 | 不是最大，但属于跨设备数据一致性的关键编排点；需改为只协调 Repository 和 Reconciler。 |
| `src/web/frontend/src/components/models/ModelsPage.tsx` | 2,226 | 模型页的展示、编辑状态、请求和弹窗逻辑应拆成页面容器与子组件/Hook。 |

大型 CSS 文件同样需要按页面/组件边界整理，但不应和业务编排重构混在同一批提交中。

## 重构目标边界

保留现有 Provider、Vault、Adapter 的实现，先把编排从 HTTP/CLI/同步中抽离；不要进行一次性“重写全部”。

```text
Controller（Web API / CLI / Sync trigger）
  → Application Service
      → Domain policy（模型解析、路由、选择校验）
      → Repository（user、provider、model cache、vault）
      → Agent adapter（原生配置文件）
      → Runtime status / log（本机状态，不参与同步）
```

建议的第一批应用服务：

1. `AgentConfigurationService.configureSite()`：保存站点与模型；供 Web 和 CLI 共用。
2. `AgentConfigurationService.switchModel()`：切换当前模型；供 Web 和 CLI 共用。
3. `AgentConfigurationService.applyTierMap()`：处理 Claude 档位映射；供 Web 和 CLI 共用。
4. `AgentConfigurationReconciler.reconcile()`：把已持久化的期望选择下发到本机原生配置；供同步拉取、启动恢复和手动重试共用。

同步只负责合并“期望状态”，随后调用 `reconcile()`。下发失败时保留远端选择并记录本机待重试状态，绝不能清空同步数据或反向同步失败状态。

## 重构验收基线

- 页面保存、CLI、同步拉取对同一站点/模型产生完全相同的 Agent 原生配置。
- 同步到新设备后，密钥、站点、模型选择及真实 Agent 配置文件都生效。
- 缺少模型缓存、密钥或本机 Agent 时：选择保留、失败可诊断、恢复后可重试。
- Adapter 只接收已解析的 Provider、远端模型 ID 与 `ResolvedModel`；不再自行读取持久化文件或推断选择。
- HTTP handler 不直接进行持久化编排；只转换请求/响应和错误码。
- 所有 Agent×站点×模型切换、同步 A→B、CLI 三条路径纳入临时 HOME 集成测试。
