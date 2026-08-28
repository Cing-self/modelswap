# 跨设备同步、模型发现与 Agent 配置写入：发布验收标准

## 状态、目的与使用方式

本文是同步相关改动的冻结验收标准，而不是某个提交的通过记录。目标是在合并前以隔离的 A→B 流程一次性暴露设计、实现和跨平台问题；真实 B 仅在所有 P0/P1 自动化门禁通过后作为最后确认，不能再充当问题发现环境。

每次候选先按本文跑**完整基线**并输出缺陷清单，按根因合并修复；禁止「发现一个问题、发布一次」的循环。QA 报告必须说明：候选 SHA/改动范围、命令和测试数、已验证与未验证边界、失败根因、临时 HOME 路径是否清理、以及是否允许发布。

逐行门禁的唯一来源是 `docs/testing/sync-agent-release-checklist.md`：每轮复制完整表，保留历史轮次，不能用新一轮覆盖旧记录。任何行只有本行列出的“需要的证据”齐全才能标 `PASS`；全量测试全绿、相邻行通过或人工判断均不能替代该证据。基线报告只归类缺陷，两份文档以 defect ID 相互链接。

## 范围与不覆盖边界

范围：

- `providers.json` 的站点配置、加密 Vault、`user.json` 内 desired Agent state、`models-cache.json`、cloud/LAN 同步、模型发现、所有已注册 adapter 的真实原生配置文件，以及 CI 到 DMG 的发布链。
- 当前注册 Agent 以 `src/providers/agentsMeta.ts` / `src/providers/registry.ts` 为准：Claude、Codex、OpenCode、OpenClaw、WorkBuddy、ZCode、Hermes、Kimi Code、Grok Build、MiMo Code。
- HTTP 目录、provider-specific 目录、native CLI 目录、手动模型、模型下架和同步冲突。

明确不覆盖：

- 不用自动化测试真实客户的 API key、订阅余额、模型权限或第三方服务 SLA；它们属于最后的、经授权的真实 B smoke。
- 不把 `models.dev` 当作远端目录或授权来源；它只能为已发现且同 ID 的模型补能力元数据。
- 不以 UI 展示、API 200 或 mock adapter 代替实际 adapter 文件断言。
- 不以真实 `~/.okit`、`~/.codex`、`~/.claude`、`~/.config/opencode` 或端口 3780 承载 fixture。所有测试设 `HOME` 和 `USERPROFILE`；监听器使用端口 `0`，并在 `finally`/`afterAll` 关闭。

## 架构不变量（P0）

| 域 | 必须恒成立 | 禁止 |
| --- | --- | --- |
| 模型成员资格 | 仅认证的 provider 官方目录、等价官方发现 API、实际 Agent CLI，或显式 user/manual 模型可决定成员资格。 | selected desired state、预置列表、探针模型、`models.dev` catalog-only 行成为目录。 |
| models.dev | 仅为同 `providerId + modelId` 的已发现模型 enrich context/output/reasoning/modalities 等字段。 | 增加模型 ID、在空目录/错误时 fallback。 |
| 存储 | provider 站点写 `~/.okit/providers.json`；目录写本机 `~/.okit/models-cache.json`；选择/desired state 写 user config；密钥写 Vault。 | 在 `providers.json` 写 `models`、`platforms`、`modelCache`；发现时重写 providers 或标记 sync dirty。 |
| 同步 payload | 仅 portable provider sites、Vault secret、`agentProviders`、`modelOverrides` 等可移植状态。 | A 的 `models-cache.json`、Agent 原生文件、运行时目录缓存。 |
| Pull 顺序 | merge provider sites → 写 Vault → 持久化 desired state → 对 B 本机 selected provider 做 canonical discovery（并发最多 2）→ 既有 reconciler 写 Agent 文件。 | 无 cache 时先 reconcile；发现失败时盲写；用 A 的缓存或 selected state 假装发现。 |
| 失败 | desired state 不丢；已有 remote/manual cache 保留；没有有效目录不生成新成员；返回结构化 `MODEL_DISCOVERY_FAILED` 或既有 `PROVIDER_NOT_FOUND`/`AUTH_REQUIRED`。 | 静态 fallback、清空手动模型、把失败写回远端、把未发现模型写入 Agent 文件。 |
| 并发与写入 | user config 经 `sync-config-store` 的队列和原子 rename 写入；同 provider warmup 去重；pull 独占。 | fixture 或生产路径绕过队列直写 user config；用 retry、全局串行化掩盖竞争。 |

## Provider 分类与发现矩阵

| 类别 | 代表/输入 | P0 发现与路由断言 | 失败/负例 | 当前证据或必须新增 |
| --- | --- | --- | --- | --- |
| 普通官方 `/models` | OpenAI-compatible provider、普通第三方 endpoint | 对该 provider 自己的 `baseUrl + /models` 发请求，携带正确授权；只写实际 IDs。 | 无 key、401、404、空 `data`、断网均不注入 catalog。 | `tests/web/live-model-source.test.ts`、`tests/web/model-cache-warmup.test.ts`、`tests/web/sync-agent-model-hydration.test.ts`。 |
| Qianfan Token Plan/Coding Plan | 推理 `https://qianfan.baidubce.com/v2/tokenplan/personal` 或 legacy `/v2/coding` | 推理 URL 原样保留；仅官方 host、默认端口、精确路径映射模型目录到同 host `/v2/models`；Bearer key 相同；`glm-5.1/5.2` 必须来自该响应。 | personal `/models` 绝不请求；non-default port、lookalike/third-party host、额外 path 不映射；目录错误/空不信任 selected state。 | `tests/qianfan-coding.test.ts`、`tests/web/sync-agent-model-hydration.test.ts`；每次必须补 host 大小写、`:443`、query/hash、第三方 `/v2/coding` 和 `/v2/tokenplan/personal` 负例。 |
| 其他 provider-specific directory | 任何将来不等于 `baseUrl + /models` 的 provider | 以 provider-specific adapter/helper 集中定义，明确 host/path/port predicate 与 directory URL。 | 普通 provider 不能误进入该 handler。 | 新 helper 必须有 unit 正/负矩阵及 A→B integration 行。 |
| Native CLI | Codex、Grok、GitHub Copilot | 只读取该 B 上 CLI/OAuth/cache 的真实输出，写 native availability 到 B cache 后才 reconcile。 | CLI 未安装、未登录、空输出不 fallback；保留 desired state，结构化失败。 | `tests/integration/agent-native-route-matrix.test.ts`、`tests/web/sync-agent-model-hydration.test.ts`、adapter tests。 |
| 无目录/空目录 | 404/405、空 200、网络失败、已下线 API | 无新成员；已有 remote/manual cache 留存；首次空 cache 仍为空；不改 providers/sync。 | 不能用探针、models.dev 或预制模型补目录。 | `tests/web/live-model-source.test.ts`、`tests/web/model-cache-warmup.test.ts`；需对每个特殊 provider 明确状态码契约。 |
| 手动模型 | `origin:user` / `source:manual` | 保留并可被 adapter 使用；远端 refresh 不删除。 | 不应因失败、legacy cleanup、重复 pull 被删。 | `tests/providers/store.test.ts`、`tests/web/live-model-source.test.ts`、hydration fixture。 |

### 目录 URL 的统一断言

每个 provider-specific helper 的测试必须输入完整 URL 表：官方 host 小写/大写、默认端口、非默认端口、query/hash、尾部 slash、额外 path、lookalike subdomain、第三方同路径、普通官方根路径。输出必须是 `null`（普通规则）或唯一 canonical directory URL；不得靠散落的字符串判断。

## Agent 与原生文件矩阵

所有 Agent 必须走 `agent-config-service` / reconciler 的生产路径，并读取临时 HOME 下的**真实目标文件**。每项至少验证 provider endpoint、remote model ID、主/备用或 tier 参数、凭据引用，以及多站点 Agent 不丢既有站点。

| Agent | 原生文件/主要断言 | 自动化基础 |
| --- | --- | --- |
| Claude | `~/.claude/settings.json`；`ANTHROPIC_MODEL` 与 tier map 的 remote ID、metadata。 | `tests/providers/adapters/claude*.test.ts`、`tests/web/agent-provider-switch-matrix.test.ts`、hydration。 |
| Codex | `~/.codex/config.toml`、`.env`、`model-catalogs/model-catalogs.json`；选择模型和路由。 | `tests/providers/adapters/codex.test.ts`、`tests/providers/mappings/codex.test.ts`、native route matrix、hydration。 |
| OpenCode | `~/.config/opencode/opencode.json`；provider block、各模型和 endpoint。 | `tests/providers/adapters/opencode.test.ts`、hydration。 |
| OpenClaw | `~/.openclaw/openclaw.json`。 | `tests/providers/adapters/openclaw.test.ts`、native route matrix。 |
| WorkBuddy | `~/.workbuddy/models.json`。 | `tests/providers/adapters/workbuddy.test.ts`、native route matrix。 |
| ZCode | `~/.zcode/v2/config.json` 与 `~/.zcode/cli/config.json`。 | `tests/providers/adapters/zcode.test.ts`、native route matrix。 |
| Hermes | `~/.hermes/config.yaml`。 | `tests/providers/adapters/hermes.test.ts`、native route matrix。 |
| Kimi Code | `~/.kimi-code/config.toml`。 | `tests/providers/adapters/kimi-code.test.ts`、native route matrix。 |
| Grok Build | `~/.grok/config.toml`。 | `tests/providers/adapters/grok.test.ts`、native route matrix。 |
| MiMo Code | MiMo adapter 的真实配置输出与模型路由。 | `tests/providers/adapters/mimo-code.test.ts`、native route matrix。 |

`tests/web/agent-provider-switch-matrix.test.ts` 已提供多 Agent/站点/模型的真实写入矩阵；发布前必须以当前 `AGENTS_META` 全量核对其覆盖的 Agent 数。新增 adapter 或文件字段时，必须新增对应 adapter test 与矩阵行，不能只改 API handler。

### 跨设备 reconcile 的全 adapter 动态矩阵（P0，必须新增）

现有 adapter unit 和切换矩阵**不能**替代同步 pull 后的 reconcile 覆盖。冻结前必须新增一个独立 integration 用例（建议文件：`tests/web/sync-agent-all-adapters-reconcile.test.ts`），从运行时 `AGENTS_META` 和 `getAdapters()` 取得集合，而不是在测试内手写一个较短列表。

该用例的强制契约：

1. 动态取得的 ID 集合（排序后）必须恰为 `claude`、`codex`、`opencode`、`openclaw`、`workbuddy`、`zcode`、`hermes`、`kimi-code`、`grok`、`mimo-code`，并且 `AGENTS_META` 与 registry 不得有集合差异。
2. 为每个 adapter 在 A 建立支持其 protocol 的 provider、Vault **引用**、一个真实 discovered remote model 和所需 mapping/tier；B 必须是 fresh HOME、无 provider/model cache，走真实 `syncPull → hydration → reconcile`。
3. 对每一项读取 B 上该 adapter 的真实目标文件，断言 provider endpoint、路由后的 remote model ID、凭据**引用/鉴权形态**（不得读取或打印密钥值）以及其适用参数（例如 Claude tier、Codex mapping、OpenCode model map）。API 200、内存 state 或 mock adapter 不算通过。
4. 若 `AGENTS_META`/registry 新增 adapter，集合断言必须立即失败，直到 fixture、目标文件和参数断言一起新增；不得通过排除列表、skip 或把它降为 adapter unit 来放行。

在该用例落地前，本文的 adapter/native 层只能作为已有覆盖，不能使跨设备发布门禁变绿。

## A→B 生命周期矩阵（P0）

| 场景 | 输入 | 必须观察的结果 |
| --- | --- | --- |
| 空 B 首次 pull | A 有 sites、Vault、desired selections；B 无 `providers.json` 与 `models-cache.json`。 | blob 无 cache；B merge sites/Vault/desired state 后本机发现，再写 Codex/Claude/OpenCode（及选择的其他 adapter）文件。 |
| B 有 remote/manual cache | 对应 provider cache 非空。 | 不重复网络/CLI discovery；bytes 不变；手动模型保留。 |
| B legacy catalog-only cache | `source:modelsdev` 且非 user。 | 首读最多清理一次；remote/manual/user 不删；随后 canonical discover 可恢复真实模型。 |
| B selected model | selected ID 同时是官方目录和 models.dev overlap。 | cache 成员来自目录；同 ID enrichment 生效；catalog-only 不入 cache。 |
| Qianfan selected GLM | selected `glm-5.1/5.2`，personal inference URL。 | 只请求官方 `/v2/models`，用同一个 key；OpenCode 成功写模型；personal `/models` 未请求。 |
| 两个第三方同路径 | `baseUrl` 分别为第三方 `/v2/coding`、`/v2/tokenplan/personal`。 | 均请求各自 `baseUrl + /models`，不是 Qianfan canonical host；各自 OpenCode block 写入。 |
| Pull 重复/冲突 | 连续 pull、remote 时间戳较旧、localChangedAt 较新、并发 sync 操作。 | 不重复 discovery；本地更新不被旧 blob 覆盖；`runExclusive` 拒绝并发；config 队列不丢 password/selection。 |
| Payload 边界 | push A，再解密 blob。 | 仅 portable sites/Vault/desired/overrides；site 无 `models/platforms/modelCache`；B cache 不回传。 |

### Vault 引用保留与鉴权边界（P0）

`vaultKey` 是 Vault entry 的引用，不是 API key 值；所有断言只比较引用是否存在/相等，测试、日志和证据不得输出解析后的 secret。冻结前必须覆盖以下序列：

1. 已有 provider 绑定 `vaultKey` 后，仅局部更新任意非凭据字段（名称、endpoint、models、metadata 等），引用仍存在且相等。
2. sync merge 收到缺失/`null`/空 `vaultKey` 的远端 site、endpoint migration、preset migration 后，本地既有工作引用不被擦除；显式换绑/删除才可改变它。
3. `agent-config-service` 的保存、pull 后 reconcile、模型发现与 cache refresh 之后，provider 中同一引用仍存在，且 providers payload 只带引用而不带 secret。
4. Codex legacy `requires_openai_auth` 清理必须只影响 Codex 官方 OAuth 语义；第三方 provider 的 auth block/endpoint 凭据引用不能被当作 OAuth token、不能被清空或写入 Agent 文件的错误字段。

已有 `tests/sync.test.js` 覆盖 site merge 输出包含 `vaultKey`，`tests/providers/store.test.ts` 覆盖 store/migration 的部分行为；但它们不足以证明完整 lifecycle。必须新增 P0 lifecycle regression（建议 `tests/web/sync-agent-vaultkey-reconciliation.test.ts`，可与全 adapter A→B matrix 共用 fixture），逐段比较引用并覆盖上述 Codex/第三方 auth 分支。

现有主入口为 `tests/web/sync-agent-model-hydration.test.ts`，`tests/sync-domain.test.js` 明确顺序，`tests/sync.test.js` 覆盖 merge/conflict，`tests/sync-scheduler.test.ts` 覆盖 dirty/exclusive。该 integration fixture 的 mock listener 必须端口 0、`finally` 关闭，且 A/B config 初始化必须使用 `sync.saveConfig()`，不能直写 `user.json` 绕开队列。

## 失败矩阵（P0）

| 故障 | cache/desired state | Agent 文件 | 返回与同步 |
| --- | --- | --- | --- |
| 无 Vault key / 无 key | 既有 cache 留存；desired state 留存。 | 不写入新模型配置。 | `AUTH_REQUIRED` 或 `MODEL_DISCOVERY_FAILED`；providers 不变、不 dirty。 |
| key 无效/401 | 同上。 | 拒写。 | provider-specific安全消息；不泄露 key。 |
| 断网/超时 | 同上。 | 拒写。 | `MODEL_DISCOVERY_FAILED`，可保留错误消息。 |
| 404/405/空目录 | 首次无 cache 不注入成员；已有 manual/remote 留存。 | 若 selected 不可 route，返回 `MODEL_NOT_FOUND`，不盲写。 | 无 static fallback、无远端回写。 |
| native CLI 未登录/未安装/空输出 | 不创建 preset directory。 | 拒写新模型。 | 结构化 discovery/auth 失败，desired state 可后续重试。 |
| 模型下架 | refresh 删除未选 remote ID；active/desired 与 user/manual 的兼容策略须显式测试。 | 不指向已下架 remote ID。 | 不使用 models.dev 把其补回。 |
| provider 不存在 | desired state 留存。 | 不写。 | `PROVIDER_NOT_FOUND`。 |

## 测试分层、命令与通过判据

所有命令从候选 detached worktree 执行。每次使用新临时路径；Windows 子进程依赖 `USERPROFILE`，所以不可只设置 `HOME`。

```bash
QA_HOME=$(mktemp -d /tmp/okit-sync-qa-home-XXXXXX)
QA_NPM_CACHE=$(mktemp -d /tmp/okit-sync-qa-npm-cache-XXXXXX)
HOME="$QA_HOME" USERPROFILE="$QA_HOME" npm_config_cache="$QA_NPM_CACHE" npm ci --ignore-scripts
HOME="$QA_HOME" USERPROFILE="$QA_HOME" npm_config_cache="$QA_NPM_CACHE" npm --prefix src/web/frontend ci --ignore-scripts
HOME="$QA_HOME" USERPROFILE="$QA_HOME" npm_config_cache="$QA_NPM_CACHE" npx tsc
HOME="$QA_HOME" USERPROFILE="$QA_HOME" npm_config_cache="$QA_NPM_CACHE" npm run copy-web
```

| 层级 | P0/P1 命令或文件 | 通过判据 |
| --- | --- | --- |
| Unit/domain（P0） | `npx vitest run tests/qianfan-coding.test.ts tests/sync-domain.test.js tests/sync.test.js tests/sync-scheduler.test.ts tests/providers/store.test.ts tests/providers/routing.test.ts tests/utils/atomicWrite-concurrency.test.ts` | provider helper 正/负 URL、payload strip、顺序、冲突、store/cache 边界、原子写入均通过。 |
| Isolated integration（P0） | `npx vitest run tests/web/sync-agent-model-hydration.test.ts tests/web/agent-config-sync-reconciliation.test.ts tests/web/live-model-source.test.ts tests/web/model-cache-warmup.test.ts tests/web/lan-sync.test.ts`，以及落地后的 `tests/web/sync-agent-all-adapters-reconcile.test.ts`、`tests/web/sync-agent-vaultkey-reconciliation.test.ts` | A→B 空/已有 cache、offline、Qianfan、third party、Codex/Claude/OpenCode 与全 adapter 文件真实写入；Vault 引用 lifecycle 不丢失。 |
| Adapter/native（P0） | `npx vitest run tests/providers/adapters/*.test.ts tests/integration/agent-native-route-matrix.test.ts tests/web/agent-provider-switch-matrix.test.ts` | 每个当前 registry adapter 至少一个真实 native 文件、remote ID、模型参数映射断言；但不替代上方全 adapter sync reconcile。 |
| Runtime/package（P0） | `npx vitest run tests/build/runtime-closure.test.ts`; `npm run build`; `npm pack --dry-run --json` | `dist` closure、`/ping`、frontend、CLI runtime 和发布包文件齐全。 |
| 默认并行 full（P0） | 连续三次 `npm test -- --run` | 每次完全成功；记录 files/tests 数。不得添加 `--no-file-parallelism`、retry、skip/todo/only、放宽 timeout 或全局 config 绕过。 |
| CI（P0） | GitHub Actions CI 的 macOS/Ubuntu/Windows job。 | 与 `.github/workflows/ci.yml` 相同顺序：两份 lockfile `npm ci` → `tsc` → `copy-web` → Vitest → frontend build → root build，三个 job 都 success。 |
| 真实 B smoke（P0，最后） | 按下一节手测；只在发布产物/备份后。 | 每项记录版本、时间、endpoint 类型、非秘密请求结果、cache/Agent 文件变化；无真实 key 写入自动化日志。 |

P1：`tests/frontend/model-cache-warmup.test.ts`、`tests/frontend-sync-import-status.test.ts`、`tests/web/models-dev.test.ts`、`tests/web/provider-flow.test.ts`、`tests/web/endpoint-profiles.test.ts`、`tests/web/ui-events.test.ts`。它们验证页面事件、metadata、导入状态和 endpoint profile；P1 不得替代 P0 runtime 行为。

## 基线缺陷清单与停线规则

首次基线必须把本文所有已存在的 P0 命令**一次跑完**，并以固定模板交给 CEO/开发；不能在某个单文件刚绿时就开始合并或发布。模板：

```text
候选 SHA / 基线 main SHA:
环境: OS、Node/npm、fresh HOME/USERPROFILE、worktree:
基线命令与结果: 每条命令、files/tests 数、构建/package/CI 状态:
缺陷 ID:
P0/P1:
根因分类: directory URL | membership/cache | Vault/auth ref | sync order | config writer/concurrency | adapter mapping | dist/package | test isolation
受影响 provider / agent / OS:
最小复现（不含密钥）:
预期 / 实际:
现有覆盖与缺失测试:
修复批次:
阻断状态 / 回滚影响:
```

停线规则：

1. 首次基线结束前，不向开发逐个派发“先修一个再发”的发布任务；可记录所有失败，但只在清单完成后按根因合并成修复批次。
2. 同一根因（例如特殊目录 URL、Vault ref 丢失、写入竞争）必须以一个批次修完相关 provider/adapter/OS 的负例，不能只针对当前触发 provider 加例外。
3. P0 缺陷清单未清零，不得进入统一复验、合并、CI 发布或真实 B；统一复验必须从新 SHA 重跑本文所有 P0，而非只重跑修复文件。
4. 当前 `e3781970299f781014e180a31a4a10d00ad760d0`（Qianfan URL 边界候选）明确作为本基线的 `directory URL / Qianfan / third-party` 一行保持冻结；不得先单独合并或发布。只有基线清单 P0 清零后才能随集中修复批次进入统一复验。

## 执行顺序与发布门禁

1. **冻结基线**：在候选 SHA 创建 clean detached worktree，记录 `git status --short`、`git diff --check main...HEAD`、提交范围和新/变测试；在 checklist 新增本轮完整表和元数据，初始状态均为 `NOT RUN`。
2. **一次性基线盘点**：先运行 Unit/domain、integration、adapter/native、runtime/package、三次 full。逐行填 checklist，并把所有 `FAIL`/`BLOCKED` 以 defect ID 收录到基线报告，按根因归类（目录 URL、membership、Vault/auth、sync order、config writer/concurrency、adapter mapping、dist/package、测试隔离），而非按单个症状拆小发布。
3. **集中修复**：CEO 审核根因清单后，开发统一修复；每项必须附 regression test。禁止 retry、skip/todo/only、弱化断言、增大全局 timeout、关闭默认 file parallelism、把 mock 变成 API 200 断言。
4. **统一复验**：新 SHA 从步骤 1 全量重跑；只要 P0 有一次失败即 `QA_BLOCKED`，不以第二次成功覆盖不稳定。
5. **合并后 CI**：三平台 CI 全绿才允许自动 Publish；任何失败立即报告 run/job/step/日志摘要，禁止手工绕过 workflow。
6. **发布门禁**：Publish 必须完成 version-bump tag、测试、build、`npm pack`、arm64/x64 DMG、npm publish、GitHub Release；QA 核对 Release 非 draft、tag/main commit、arm64 DMG 文件名/大小/SHA-256 与 `.sha256` 资产。
7. **真实 B**：仅发布门禁成功后按下方 smoke；若失败，停止 B 服务/保留备份/收集最小非秘密证据，回到步骤 2，不追加临时发布。

## 真实 B 最终 smoke 与回滚证据

执行前：记录发布版本/commit；备份 B 的 `providers.json`、`user.json`、Vault（使用产品安全备份机制，不提交或上传）、`models-cache.json` 与相关 Agent 文件；确认没有测试 fixture 监听 3780：

```bash
lsof -nP -iTCP:3780 -sTCP:LISTEN
```

手测清单：

1. A 选择一个普通 HTTP provider、Qianfan Token Plan `glm-5.1/5.2`、一个 native CLI provider 和一个手动模型，完成同步 push；确认 A 的模型缓存未进入 payload。
2. B 清理/迁移目标 provider 的本地 cache（保留用户手动模型的规定场景），pull 后检查：普通 endpoint、官方 Qianfan `/v2/models`、CLI 各只发现一次；推理 personal URL 未被用作 `/models`；第三方同路径仍请求其自身 `/models`。
3. 读取 B 的 Codex、Claude、OpenCode 配置，及本轮涉及的其余 adapter 文件；核对 endpoint、remote model ID、primary/tier 模型。页面刷新后 providers/model-data/Agent view 集合一致。
4. 对一个 provider 人为使用无效 key、一个断网/空目录输入，确认 structured error、desired state/cache 保留且没有盲写 Agent 文件、没有同步回 A。
5. 再 pull 一次，确认无额外发现、providers.json bytes 不变、models-cache 只因真实 discovery 变化。

证据格式：`SHA | version/tag | OS | provider/endpoint kind | selected IDs | discovery request paths（不含 token） | cache IDs/origin | Agent 文件与关键字段 | expected/actual | logs/run URL | rollback state`。若必须回滚，使用发布前备份恢复 B 本地文件并停止自动 sync，记录恢复版本与时间；不得用真实密钥或完整配置粘贴到 issue、CI log 或聊天。

## 当前风险盘点（冻结前必须关闭）

- provider-specific directory helper 必须严格限定官方 host/port/path；Qianfan 是已暴露过的 P0 类问题，今后新增同类 adapter 先写负例。
- A→B fixture 已证明 queue 直写竞争会在默认并行 full 中间歇失败；所有 fixture config 初始化必须经 `sync.saveConfig`，并以三次 default-parallel full 作为稳定性门槛。
- 当前 A→B integration 已覆盖 Codex/Claude/OpenCode、Qianfan 与第三方同路径；其余 7 个 adapter 的同步后写入需要以 native-route/adapter matrix 逐项核对并在矩阵中标明覆盖，而不是假定 adapter unit 即等于 sync reconcile。
- 自动化 mock 不能证明真实订阅 key 的服务端目录权限；这保留给最后的最小真实 B smoke，但该 smoke 不能替代所有自动化 gate。
