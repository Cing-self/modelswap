# 跨设备同步 + 模型发现 + Agent 写入：逐轮验收 check 表

## 状态和使用规则

状态枚举：`NOT RUN`、`PASS`、`FAIL`、`BLOCKED`。

- `PASS` 仅在该行“需要的证据”全部具备时有效；不得由其它行、全量测试全绿或口头结论替代。
- `FAIL` 与 `BLOCKED` 必须链接到基线报告中的 defect ID；`NOT RUN` 不代表通过。
- 每一轮复制**完整表**并保留历史；当前轮不得覆盖旧轮。需要新增的测试在实现且实际运行前保持 `NOT RUN`，并显式关联 coverage-gap defect。
- 所有自动化使用 fresh `HOME` 与 `USERPROFILE`、独立 npm cache；fixture 监听端口 `0`，在 `finally`/`afterAll` 清理。真实 B 默认不运行，且必须是所有前置 P0 完成后的最后一行。

## Round R1 — e378 冻结基线

| 元数据 | 值 |
| --- | --- |
| Round | R1（一次性基线；不是候选放行） |
| 候选 / base SHA | `e3781970299f781014e180a31a4a10d00ad760d0` / `19207a25eb50ea48728ee5ff927d8599b1c802a8` |
| 开始 / 完成 | 2026-08-28 20:33 +0800 / 2026-08-28 20:40 +0800 |
| QA 环境 | macOS；Node `v26.7.0`；npm `11.19.1`；每条命令 fresh HOME+USERPROFILE+isolated npm cache |
| 测试 worktree | detached `/tmp/okit-qa-baseline-e378-nhGbVU`；文档 QA 分支 `/tmp/okit-qa-qianfan2-At55oJ` |
| 真实 B | 否；未操作真实用户目录、B 或 3780 |
| 全量测试数 | #1 `84 files / 768 tests`；#2 `84 / 768`；#3 `84 / 768` |
| 缺陷报告 | `docs/testing/sync-agent-release-baseline-e378.md` |

| ID | P0/P1 | 域 | 场景/预期 | 执行命令或测试文件 | 需要的证据 | 状态 | 证据摘要/defect ID |
| --- | --- | --- | --- | --- | --- | --- |
| R1-D01 | P0 | membership | 成员只来自认证目录/CLI/manual；models.dev 仅同 ID enrich | `live-model-source`, `model-cache-warmup`, `providers/store` | cache 无 catalog-only、新模型真实来源 | PASS | 定向 integration 35/35，unit/domain 70/70；见基线命令 U/I。 |
| R1-D02 | P0 | storage | providers 无 `models/platforms/modelCache`；目录只写 B 本地 cache | `providers/store`, `sync`, hydration | providers/payload 与 cache 分离 | PASS | unit/domain 70/70；hydration integration 35/35。 |
| R1-D03 | P0 | payload | A blob 只含 portable sites/Vault/desired，绝不含 A cache/agent 原生文件 | `sync.test.js`, `sync-domain.test.js`, hydration | 解密/merge assertions 与 B 无 cache 起步 | PASS | unit/domain 70/70；hydration 35/35。 |
| R1-D04 | P0 | pull order | B merge site/Vault/desired → local discover(≤2) → reconciler | `sync-domain`, `sync-agent-model-hydration` | discovery 在 Agent 写入前；无 selected-state 信任 | PASS | 35/35 integration；e378 Qianfan A→B 行也通过。 |
| R1-D05 | P0 | cache/failure | remote/manual/user 保留；失败不 fallback/不盲写/不 dirty | live-source、warmup、hydration | 空/失败结构化结果及 bytes/state assertions | PASS | 定向 integration 35/35。 |
| R1-P01 | P0 | official directory | 普通 provider 用自身 `baseUrl + /models` 和正确 auth | `tests/web/live-model-source.test.ts` | 实际远端 IDs、无 catalog membership | PASS | integration 35/35。 |
| R1-P02 | P0 | Qianfan directory | official personal/legacy coding 仅映射 official `/v2/models` | `tests/qianfan-coding.test.ts`; hydration | personal 不请求；同 Bearer；GLM 来自 canonical response | PASS | unit/domain 70/70；hydration 35/35。冻结 e378 只作基线行，未放行。 |
| R1-P03 | P0 | third-party negative | 两个第三方同路径保持各自 `baseUrl + /models` | `tests/qianfan-coding.test.ts`; hydration | host/port/path 负例；各自 OpenCode 写入 | PASS | e378 新增路径矩阵在 unit/domain 70/70、integration 35/35。 |
| R1-P04 | P0 | native CLI | Codex/Grok/Copilot 仅采用本机 CLI/OAuth 实际输出 | `tests/integration/agent-native-route-matrix.test.ts` | native availability 后才 reconcile；空/未登录无 fallback | PASS | adapter/native 268/268。 |
| R1-P05 | P0 | manual model | `origin:user`/manual 模型在 refresh/cleanup/repeat pull 中保留 | store/live-source/hydration | cache 成员与可路由性断言 | PASS | unit/domain 70/70；integration 35/35。 |
| R1-P06 | P0 | legacy cache | legacy `modelsdev` non-user 清理一次、随后可 canonical discover | `tests/web/live-model-source.test.ts` | 仅旧 catalog-only 删除；remote/manual/user 保留 | PASS | integration 35/35。 |
| R1-F01 | P0 | no key / 401 | 不写新成员或 Agent 文件，desired/cache 保留 | live-source/warmup/hydration | `AUTH_REQUIRED`/structured failure；无 secret | PASS | integration 35/35。 |
| R1-F02 | P0 | 404 / empty / timeout | 首次 cache 空仍空，既有 cache 保留且无 static fallback | live-source/warmup/hydration | error/empty/network 三种结果断言 | PASS | integration 35/35。 |
| R1-F03 | P0 | CLI empty | 未登录/空 CLI 不构造预制目录或盲写 | native route matrix | structured failure 与 desired 保留 | PASS | adapter/native 268/268。 |
| R1-S01 | P0 | A→B empty | empty B 从 sites/Vault/desired 起步、仅本机 discover 后写入 | hydration | B 无 cache，真实临时 Agent 文件检查 | PASS | integration 35/35（当前 Codex/Claude/OpenCode/Qianfan 覆盖）。 |
| R1-S02 | P0 | existing cache | B 有 remote/manual cache 不触网且 bytes 不变 | warmup/hydration | 请求计数和 cache bytes | PASS | integration 35/35。 |
| R1-S03 | P0 | repeat/concurrency | repeat pull 不重复发现；冲突/排他不覆盖本地更新 | sync/scheduler/atomic write | runExclusive、timestamp、三次默认并行 full | PASS | unit/domain 70/70；full 3×84/768。 |
| R1-S04 | P0 | config queue | fixture 与生产经 `sync.saveConfig`，队列不丢 password/selection | atomic write/hydration | 无 direct fs fixture 写 user config；稳定 full | PASS | unit/domain 70/70；full 3×84/768。 |
| R1-S05 | P0 | vaultKey lifecycle | 部分更新、sync merge/migration、save/reconcile 后 Vault ref 保留；Codex legacy/third-party auth 边界 | **需新增** `tests/web/sync-agent-vaultkey-reconciliation.test.ts` | 完整 lifecycle 逐段比较 ref（不泄露 secret） | BLOCKED | `QA-P0-GAP-002`：文件不存在；store/sync unit 不能替代 lifecycle。 |
| R1-A01 | P0 | Claude adapter | fresh B 原生文件：endpoint、remote model、credential/auth shape、tier mapping | **需新增全 adapter A→B matrix** | 真实 B-temp `~/.claude/settings.json` | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A02 | P0 | Codex adapter | fresh B 原生 `config.toml/.env/catalog`：endpoint、model、auth、mapping | **需新增全 adapter A→B matrix** | 临时 Codex 原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A03 | P0 | OpenCode adapter | fresh B `opencode.json`：endpoint、model、credential/auth、map | **需新增全 adapter A→B matrix** | 临时 OpenCode 原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A04 | P0 | OpenClaw adapter | fresh B `openclaw.json` 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A05 | P0 | WorkBuddy adapter | fresh B `models.json` 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A06 | P0 | ZCode adapter | fresh B v2/CLI config 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A07 | P0 | Hermes adapter | fresh B YAML 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A08 | P0 | Kimi Code adapter | fresh B TOML 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A09 | P0 | Grok Build adapter | fresh B TOML 全字段 | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A10 | P0 | MiMo Code adapter | fresh B 原生输出、endpoint/model/auth/tier | **需新增全 adapter A→B matrix** | 临时原生文件 | BLOCKED | `QA-P0-GAP-001`。 |
| R1-A11 | P0 | dynamic registry full set | `AGENTS_META` 与 `getAdapters()` 精确 10 个，新增 adapter 必须失败 | **需新增** `tests/web/sync-agent-all-adapters-reconcile.test.ts` | 动态集合 + 10 个 A→B 原生文件 assertions | BLOCKED | `QA-P0-GAP-001`：文件不存在；268 adapter/native tests 不可替代。 |
| R1-R01 | P0 | packaged runtime | dist closure、CLI/server `/ping` 与 frontend runtime 齐全 | `tests/build/runtime-closure.test.ts` | dist 不依赖 src；健康检查 | PASS | 1 file / 1 test。 |
| R1-R02 | P0 | package | 发布包包含运行时文件 | `npm pack --dry-run --json` | package JSON: 348 entries；`cing-self-okit-cli-1.0.30.tgz` | PASS | `size=3553341`、`shasum=62b8d5e3a2cfab8c81add556a7776c66e674bddb`。 |
| R1-R03 | P0 | build | extension、copy-web、runtime closure、frontend 全完成 | `npm run build` | exit 0；Vite build 通过 | PASS | 2026-08-28 R1。 |
| R1-R04 | P0 | full #1 | 默认并行、无 retry/skip/serial 化 | `npm test -- --run` | 84 files / 768 tests | PASS | 16.51s。 |
| R1-R05 | P0 | full #2 | 同上、独立 fresh HOME/cache | `npm test -- --run` | 84 files / 768 tests | PASS | 20.19s。 |
| R1-R06 | P0 | full #3 | 同上、独立 fresh HOME/cache | `npm test -- --run` | 84 files / 768 tests | PASS | 19.17s。 |
| R1-G01 | P0 | three-OS CI | macOS/Ubuntu/Windows 与 CI 顺序均 success | GitHub CI after merged unified retest | 3 jobs/run URLs | BLOCKED | `QA-P0-GAP-001`, `QA-P0-GAP-002` 未清零；候选冻结，不创建 CI run。 |
| R1-G02 | P0 | release/DMG | tag/release/npm/arm64+x64 DMG 均成功 | Publish after three-OS CI | tag、release、DMG SHA-256 | BLOCKED | `QA-P0-GAP-001`, `QA-P0-GAP-002`；禁止发布。 |
| R1-G03 | P0 | real B smoke | 发布产物后最后确认 Qianfan/third-party/native/adapter 文件 | acceptance §真实 B smoke | 最小非秘密证据与可回滚备份 | BLOCKED | `QA-P0-GAP-001`, `QA-P0-GAP-002`；不操作真实 B。 |

R1 结束时间、最终 defect 分类与集中修复批次在基线报告中固定；未覆盖行不能因 R1 其它命令通过而改为 `PASS`。
