# R1 基线缺陷清单：e378 Qianfan 目录路由候选

## 结论

**QA_BLOCKED（基线完成，但不是发布放行）。** e378 的已存在 P0 命令、构建、package closure 与三次默认并行全量均通过；但跨设备全 adapter reconcile 和 vaultKey lifecycle 两项冻结 P0 尚不存在可运行的测试。因此不得合并 e378、不得启动 CI/Publish/Release，也不得操作真实 B。

逐行状态见 [sync-agent-release-checklist.md](sync-agent-release-checklist.md) 的 Round R1。本报告只归类缺陷；每个 defect ID 都反向链接到该表。

## 候选、环境和变更范围

| 项目 | 记录 |
| --- | --- |
| 候选 SHA | `e3781970299f781014e180a31a4a10d00ad760d0`（冻结；未合并、未发布） |
| 基线 main SHA | `19207a25eb50ea48728ee5ff927d8599b1c802a8` |
| 测试 worktree | clean detached `/tmp/okit-qa-baseline-e378-nhGbVU` |
| 文档分支 | local-only `codex/qa/sync-agent-baseline-e378` |
| 平台 | macOS；Node `v26.7.0`；npm `11.19.1` |
| 隔离 | 每一条有效安装/测试/构建/package 命令以 fresh `HOME`、`USERPROFILE` 与独立 `npm_config_cache` 运行；不访问 `~/.okit`、`~/.codex` 或真实 B。 |
| 监听 | 本轮没有启动 browser fixture；测试 mock 监听端口 `0` 并关闭。结束检查发现 PID 75039 在 `127.0.0.1:3780`，其命令为 `node -e require('./dist/web/server.js').startServer()`，启动时间早于本轮；未触碰。 |
| diff check | `git diff --check main...HEAD` 无输出。 |

候选相对 main：5 files、100 insertions / 6 deletions：

- `src/web/api/qianfan-coding.js`：新增集中式 `qianfanModelDirectoryUrl()`，WHATWG URL 限定官方 hostname、默认端口与精确 `/v2/coding`/`/v2/tokenplan/personal`，归一为 `/v2/models`。
- `src/application/model-discovery-service.js`、`src/application/provider-service.js`：只在 helper 返回 canonical URL 时走 Qianfan directory；其余仍普通 `baseUrl + /models`。
- `tests/qianfan-coding.test.ts`、`tests/web/sync-agent-model-hydration.test.ts`：覆盖 official Qianfan、models.dev 同 ID enrich、catalog-only 拒绝、A→B OpenCode 写入和两个 third-party 同路径负例。

静态 diff 审查未发现新增 `.skip`、`.only`、`todo`、retry、关闭 file parallelism 或放宽全局 timeout。Qianfan 具体路由不散落：helper 位于 `src/web/api/qianfan-coding.js`；`fetchQianfanCodingModels` 用 helper 返回的 directory URL，推理 URL 未改写。现有 unit + hydration 集成均真实运行通过。

## 已执行命令与结果

所有下列命令均在上述 detached worktree；每个测试/构建命令前重新创建临时 HOME/USERPROFILE/npm cache（为可读性省略 shell 的 `mktemp` 前缀）。首次隔离 `npm ci --ignore-scripts` 和 `npm --prefix src/web/frontend ci --ignore-scripts` 后执行 `npx tsc && npm run copy-web`，且成功。

| 层级 | 实际命令 | 结果 |
| --- | --- | --- |
| clean/diff | `git status --short`; `git rev-parse HEAD`; `git diff --check main...HEAD` | clean；SHA 精确；无 diff-check 输出。 |
| Unit/domain | `npx vitest run tests/qianfan-coding.test.ts tests/sync-domain.test.js tests/sync.test.js tests/sync-scheduler.test.ts tests/providers/store.test.ts tests/providers/routing.test.ts tests/utils/atomicWrite-concurrency.test.ts` | **7 files / 70 tests passed**，0.547s。 |
| Isolated integration | `npx vitest run tests/web/sync-agent-model-hydration.test.ts tests/web/agent-config-sync-reconciliation.test.ts tests/web/live-model-source.test.ts tests/web/model-cache-warmup.test.ts tests/web/lan-sync.test.ts` | **5 files / 35 tests passed**，4.90s。 |
| Adapter/native | `npx vitest run tests/providers/adapters/*.test.ts tests/integration/agent-native-route-matrix.test.ts tests/web/agent-provider-switch-matrix.test.ts` | **14 files / 268 tests passed**，9.55s。此结果不替代缺失的全 adapter A→B 行。 |
| Frontend P1 | `npx vitest run tests/frontend/model-cache-warmup.test.ts` | **1 file / 1 test passed**。 |
| Runtime closure | `npx vitest run tests/build/runtime-closure.test.ts` | **1 file / 1 test passed**，0.938s。 |
| Build | `npm run build` | passed：tsc、presets、extension、copy-web、runtime closure `/ping`、frontend Vite build。 |
| Package | `npm pack --dry-run --json` | passed：348 entries；`cing-self-okit-cli-1.0.30.tgz`，3,553,341 bytes，shasum `62b8d5e3a2cfab8c81add556a7776c66e674bddb`。 |
| Full #1 | `npm test -- --run` | **84 files / 768 tests passed**，16.51s。 |
| Full #2 | `npm test -- --run` | **84 files / 768 tests passed**，20.19s。 |
| Full #3 | `npm test -- --run` | **84 files / 768 tests passed**，19.17s。 |

没有将缺失测试伪装成 skip、todo 或通过；它们未出现在 candidate 的 `tests/` 路径中。

## 缺陷清单（按根因集中修复）

### QA-P0-GAP-001 — 全 adapter 的跨设备 reconcile 证据缺失

| 字段 | 内容 |
| --- | --- |
| P0/P1 | P0 |
| 根因分类 | adapter mapping / sync order / coverage gap |
| 受影响 | 10 个 registry adapters：Claude、Codex、OpenCode、OpenClaw、WorkBuddy、ZCode、Hermes、Kimi Code、Grok Build、MiMo Code；后续新增 adapter 也受影响。 |
| 最小复现 | `rg --files tests/web | rg 'sync-agent-all-adapters-reconcile'` 无输出。现有 14 files / 268 tests 只验证 adapter/native 或本地切换，未提供从动态 `AGENTS_META` + `getAdapters()` 集合，执行 fresh B `syncPull → hydration → reconcile`，并逐项读取 10 个原生目标文件的单一证据。 |
| 预期 / 实际 | 预期存在动态集合为精确 10 项、每个 adapter 验 endpoint/remote model/credential auth shape/tier mapping 的 integration test；实际测试文件不存在。 |
| 对应 checklist | `R1-A01` 至 `R1-A11` 均为 `BLOCKED`。 |
| 阻断 / 回滚 | 阻断合并、CI、release、真实 B；无产品变更或回滚。 |

### QA-P0-GAP-002 — vaultKey 端到端生命周期与鉴权边界证据缺失

| 字段 | 内容 |
| --- | --- |
| P0/P1 | P0 |
| 根因分类 | Vault/auth ref / coverage gap |
| 受影响 | 任意 provider 的局部更新、sync merge/migration、agent save/reconcile、discovery/cache refresh；Codex legacy `requires_openai_auth` 与第三方 auth block。 |
| 最小复现 | `rg --files tests/web | rg 'sync-agent-vaultkey-reconciliation'` 无输出。`tests/sync.test.js` 和 `tests/providers/store.test.ts` 的部分 ref/store 覆盖不能串联完整 lifecycle。 |
| 预期 / 实际 | 预期逐段比较 Vault reference 存在/相等、绝不打印 secret，并验证 Codex 官方 OAuth 与第三方 endpoint 凭据不混淆；实际 P0 test 文件不存在。 |
| 对应 checklist | `R1-S05` 为 `BLOCKED`。 |
| 阻断 / 回滚 | 同上；禁止用全量绿或 adapter unit 替代。 |

## 开发必须集中处理的根因批次

1. **批次 A：全 adapter A→B reconcile contract。** 新增 `tests/web/sync-agent-all-adapters-reconcile.test.ts`；运行时读取 `AGENTS_META` + `getAdapters()`，精确断言 10 项集合。对每项建立 fresh A/B、portable payload、B-local discovery，再读取其真实临时配置文件，检查 endpoint、remote model ID、credential/auth shape 与适用 mapping/tier。新 adapter 必须使集合断言失败直到 fixture 与断言补齐。
2. **批次 B：vaultKey lifecycle / auth-boundary contract。** 新增 `tests/web/sync-agent-vaultkey-reconciliation.test.ts`（可复用批次 A fixture）；覆盖局部 update、null/缺失 remote merge、migration、agent save/reconcile、discovery/cache refresh；仅比较 ref，绝不输出解析后的 key；覆盖 Codex legacy OAuth 和第三方 auth block 不被误清理/误写。
3. **批次 C：统一复验，而非单点 Qianfan 发布。** e378 的 directory URL / Qianfan / third-party 已记录为 R1 已通过行，但仍冻结。批次 A/B 合入新候选后，从 clean detached worktree 重跑验收标准全部 P0、三次默认并行 full、build/package，才可进三 OS CI、release/DMG 和最后真实 B smoke。

## 未验证边界与停线

- 未启动 GitHub macOS/Ubuntu/Windows CI、Publish、tag/Release/DMG 或真实 B，因为两个 P0 缺口未清零；这些行在 checklist 都是 `BLOCKED` 并连接到上述 IDs。
- 未使用真实 API key、订阅权限或 B 的本机 Agent 文件。mock 请求只在隔离 HOME/随机端口里验证，不包含 secret。
- 基线已一次性完成所有存在的 P0 命令。下一个动作不是对 e378 单独验收/合并，而是 CEO 将上述两个根因批次一次性交开发；修复后完整统一复验。
