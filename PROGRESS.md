# OKIT data architecture progress

## Config mutation architecture closure (2026-08-29)

1. Scope: eliminate every production user.json read→full-snapshot save path; no unrelated product work.
2. Full call graph, target API, ownership rules and deterministic test matrix: `docs/testing/config-mutation-architecture-gate.md`.
3. Contract: external code gets read-only snapshots; all production writes are registry-defined, closed-schema semantic operations only. Queue mutation remains store-private.
4. Risk: sync payload, Agent desired state and LAN credentials have independent ownership; merge/delete/timestamp semantics must remain explicit.
5. Migration: remove every production generic/full patch API; replacement is initialization/test-only/private and guarded by name and source scan.
6. Guard: production-source rule plus an injected violating fixture must fail before any runtime race is required.
7. Matrix: settings, scheduler, sync push/pull, LAN/listener, provider/Agent/reconciler and migration interleave against one fresh HOME.
8. Gate only: no implementation is committed before CEO approves this inventory and API; then run focused red→green, full ×3, build and diff.

## DEV-ESCAPE-CONFIG-001 self-certification (2026-08-29)

1. Status: development in progress; prior test/build evidence is insufficient for QA handoff.
2. Required evidence: root-cause graph, zero-pending writer matrix, red→green plus bypass proof, live guard failure, real concurrency integration matrix, and explicit residual bounds.
3. Hold: do not label this P0 complete or request release/QA sign-off until the evidence package is committed and sent to CEO + QA.

## Final semantic-config API design gate (2026-08-29)

1. Status: implementation paused; `fbe5143` is a failed experiment and must not merge.
2. Public business/composition API may expose only field-validated semantic operations; no generic mutation, config/sync snapshot patch, callback or compatibility alias.
3. `writeTail` mutation is infrastructure-private; pull conflict checks consume a remote intent and re-evaluate live state internally.
4. The detailed writer map, schemas, ownership/deletion/timestamp rules, boundaries and negative tests are in `docs/testing/config-mutation-architecture-gate.md`.
5. Wait for QA review of this design revision before source implementation or verification resumes.

## Registry-driven design gate v3 (2026-08-29)

1. Status: paused; no source implementation until QA design PASS.
2. `docs/testing/config-write-operation-registry.md` is the sole implementation definition: every writer has one closed-schema operation and one matrix participant; the earlier `fbe5143` API is explicitly rejected.
3. Registry/test participant counts must match; unregistered writers, generic callbacks/maps, aliases and byte-changing invalid requests fail the gate.
4. The DEV-ESCAPE evidence package now references registry-generated negative and concurrency evidence, not area-level claims.

## Final machine-readable design gate v4 (2026-08-29)

1. Status: paused; this replaces v3's Markdown table as the sole implementation definition.
2. `docs/testing/config-mutation-registry.json` has 42 user-config writers and 11 native-only entries (reconciler + ten adapters); only writer/schema/race IDs are required to be equal sets.
3. Every entry is joined to a stable source symbol and machine-parsed AST selector/position; inventory resolves CommonJS/ESM aliases and re-exports, and rejects unregistered or unresolved targets.
4. The JSON registry contains closed per-operation schemas, retired-key scalar/enum migration rules, and A01–A10 dependency/participant B-side payload→decode→local-hydrate→native-file acceptance; no model cache crosses A→B.
5. `docs/testing/config-mutation-architecture-gate.md` maps all five QA blockers to future runnable acceptance. No production source or test implementation resumes before QA design PASS.

## Sync/Agent release batch start (2026-08-28)

1. Scope: only the frozen sync/model discovery/Agent release acceptance, including e378 and QA-P0-GAP-001/002.
2. Boundary: add the two required P0 A→B temporary-HOME integration tests and their necessary production fixes; no feature/UI/release work.
3. Maximum risk: a fixture can falsely pass without exercising a real adapter file or can leak a Vault secret; every child uses fresh HOME+USERPROFILE and asserts files/ref names only.
4. Plan: dynamic 10-adapter sync reconcile matrix → Vault/auth lifecycle matrix → frozen P0 commands → package/build → three default-parallel full runs.
5. Failure rule: after three identical failures, record it here and change diagnostic path; never retry/skip/serialize the suite to hide it.
6. R2 reopening: replace all truthy credential checks with per-adapter non-secret reference/auth-shape evidence using two isolated Vault bindings; retain the dynamic ten-adapter gate.
7. R2 plan: audit final native credential forms → make a two-reference fixture red → add shared comparison helper → rerun frozen P0/R1/runtime/package/full ×3.

## Independent acceptance (2026-08-27)

1. Scope: test only the 10 registered adapters through real API/CLI routes, always with a temporary HOME.
2. Order: baseline evidence → dynamically derived matrix → native-file assertions → CLI path → deliberate red/green mutation → full verification.
3. Maximum risk: static fixtures or adapter mocks could conceal a canonical-ID / routed-ID / model-facts mix-up; derive candidate combinations from registry and provider data instead.
4. Constraint recorded: baseline test runner is unavailable (`vitest: command not found`); do not install or modify dependencies.
5. Matrix execution: 348 dynamic Agent×built-in-HTTP-site combinations / 696 model writes; 14 explicit exclusions; all 10 CLI `provider use` writes used the real adapters.
6. Result: the initial 72 OpenCode switch failures (36 sites × A/B) are resolved; the rerun has zero routed-ID failures.
7. Claude GLM Tier: HAIKU/OPUS route to GLM 5.3, SONNET to GLM 5.3 Flash, with individual name/description/capability assertions; mutation produced red remote-ID and description errors, restoration green.
8. Fixed unified Agent write preparation: every selected canonical model resolves once to route/remote ID/facts; adapters receive a single endpoint-pinned provider whose models are all remote-ID keyed.
9. OpenCode regression: two selected canonical models now persist only as their two remote keys while retaining distinct resolved context/output limits; mixed endpoint selections reject before a config write.
10. Hermes Web file view now exposes `~/.hermes/config.yaml`; full temporary isolated run passed 68 files / 724 tests, skipped 0, after build.

## ResolvedModel adapter/CLI alignment (2026-08-27)

1. Goal: Claude, OpenClaw, Hermes and the `provider switch`/`provider use` CLI paths pass the same resolved model facts to adapter writes.
2. Order: establish baseline → verify official schemas → update adapters/CLI → add isolated regressions → reverse-check and build.
3. Maximum risk: undocumented capability fields could create silently ignored Agent config; only documented fields will be emitted.

### Verified configuration-field mapping

| Agent | ResolvedModel → written field | Evidence / deliberately omitted |
| --- | --- | --- |
| Claude Code | `id` → `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL`; `name`/`description` and `reasoning`/effort/interleaving → documented `*_NAME`, `*_DESCRIPTION`, `*_SUPPORTED_CAPABILITIES` | Official Claude Code Model Configuration / Environment Variables docs (read 2026-08-27). No numeric context/output or modalities field is documented, so none is written. |
| OpenClaw | `id`/`name`, `reasoning`, input modalities, `context`, `output` → model `id`/`name`, `reasoning`, `input`, `contextWindow`, `maxTokens` | Official Model providers docs (read 2026-08-27). Output modalities have no documented model-entry key, so are not written. |
| Hermes | `id`, `context`, `output`, image input → `model.default`, `model.context_length`, `model.max_tokens`, `model.supports_vision` and named provider `default_model`, per-model `context_length`/`supports_vision` | Official Hermes Providers docs (read 2026-08-27). `reasoning` needs provider-specific `extra_body`; no generic field is written. |

### Completion record

- Correction in progress (2026-08-27): review established that `ResolvedModel.id` is canonical while `route.remoteModelId` is the provider-native request ID. Claude, OpenClaw, and Hermes now preserve the latter as their written model ID; resolved facts supply capabilities only.
- Regression coverage: canonical `canonical-model` → `remote-model-v2` routing now exercises actual Claude/OpenClaw/Hermes configuration files, and real OpenClaw files written through CLI `switch`/`use`; synthetic context/reasoning/modality facts remain locked to documented fields.
- Contract check: every adapter now preserves `applyConfig`'s second routed-ID parameter; the third `ResolvedModel` is primary canonical capability metadata, and the optional fourth map carries separately selected canonical facts when an Agent needs more than one model.
- Web-path correction (2026-08-27): Codex/OpenCode now follow the same permanent second-argument contract as every other adapter, and the CLI-only compatibility branch was removed. Web additive writes transform each selected catalog entry to its route's remote ID before OpenCode persists it.
- Web verification: a temporary-HOME real API regression calls Codex `switchProvider` and multi-model OpenCode `configureAgentProvider`; `canonical-model` writes `remote-model-v2` in both native configurations.
- Claude tier-map correction (2026-08-27): `resolvedAgentWrite` is now the shared Web reapply path for tier-map and fallback writes. It resolves catalog facts with user overrides while preserving `resolveModelRoute(...).remoteModelId`; catalog-less built-in fallback entries retain their native model ID without inventing facts.
- Claude tier-map verification: a temporary-HOME API regression configures GLM-like primary and flash canonical models with separate routed IDs, posts `setTierMap`, and reads `~/.claude/settings.json`. HAIKU/OPUS retain primary facts while SONNET writes the flash ID, name, description, and its own capabilities; switching to the official fallback clears all companion metadata variables.
- Reverse check: removing both CLI third arguments made `tests/commands/provider.test.ts` fail 2/2 with missing third-argument diffs; restoration passed 2/2.
- Correction verification: focused Web/adapter/CLI suite 9 files / 92 tests passed; full `npm test -- --run` 67 / 718 passed, skipped 0; `npm run build` and `git diff --check` passed.
- Baseline recovery: initial `npx`/`npm ci` could not install local dependencies because of a corrupt npm cache; a verified existing workspace dependency tree enabled the final successful checks. No source dependency or lockfile changed.

## Return-work plan (2026-08-26)

1. Goal: `providers.json` contains only sites; `models-cache.json` contains every rebuildable model fact.
2. Order: store/migration → route every Web/sync write through store → real resolution into adapters → integration tests → reverse verification.
3. Maximum migration risk: a combined v1 file can contain unknown site/model fields; write a timestamped backup first and retain unknown fields in the independent cache.
4. Baseline: 5 fixed files/53 tests; 62 files/618 tests; build passed; existing working-tree changes are the prior failed implementation.
5. The prior in-file `modelCache` design is rejected because it grows `providers.json` and Web/sync bypass the store.
6. Sync must transfer only sites, selection, and overrides; it must never write or clear another machine's local cache.
7. Completed storage rewrite: `models-cache.json` is independently atomic; `providers.json` strips models/modelCache/platforms; Web and sync now call the shared store rather than serializing provider JSON.
8. Completed resolution wiring: selected models carry `ResolvedModel` into Codex, Claude, and OpenCode configuration; overrides deep-merge per site/model and are removed with a deleted site.
9. Historical state superseded: the earlier sync compatibility failure was repaired during return work; see the final verification entries below.
10. Sync compatibility is green again: old provider files now merge in one v2 write; a temporary-HOME compiled list request returned HTTP 200 with 40 providers after fixing the `id` ReferenceError and restored derived display platforms.
11. Real temporary-HOME API→store→Codex/Claude/OpenCode test now verifies a two-model selection and actual three-Agent files. Reverse verification deliberately restored the Web legacy `{providers,platforms}` write: this test failed, then passed after restoring `_store.saveProviders`.

1. Goal: make one user selection the source of truth for the dashboard and every Agent adapter.
2. Order: baseline → failing acceptance tests → data layers/migration → refresh/resolve → adapters/API/UI → sync → verification.
3. Maximum migration risk: legacy `providers.json` combines user instances with mutable model/catalog data; preserve every unknown field and back up before atomically writing.
4. Baseline 2026-08-26: `git status --short` was clean.
5. Baseline mismatch: `npm test -- --run` failed before discovery because `vitest` is not installed (`sh: vitest: command not found`); build was therefore not run in the chained baseline command.
6. Upstream reread: models.dev documents provider-agnostic model facts and provider overrides; this matches the proposed metadata-cache precedence.
7. Upstream reread: OpenCode documents explicit provider/model configuration; this supports deriving visible models solely from selection.
8. Source variance: models.dev API and DeepSeek script could not be fetched by the browser (safe-URL/content-type errors); their supplied URLs remain the reference and implementation will not infer undocumented fields from them.
9. Implemented v2 providers persistence: site records only; model facts move into local `modelCache`; derived `platforms` are never persisted.
10. Legacy v1 files are atomically upgraded after a timestamped pre-migration backup; unknown root/site/model fields survive in cache `raw`; the obsolete Claude-profile import stays v1 for one release and upgrades on first normal read.
11. Runtime callers remain compatible through materialized providers; `ResolvedModel` applies user override > profile > models.dev > remote/default facts.
12. Refresh marks directory-only models unavailable, retains remote-only models, and never changes data for a failed fetch; model cache and models.dev cache keep provenance/version/fetchedAt.
13. Cloud payload now contains only site records, agent selection and user overrides; it excludes model cache and platform projections. Deleting an active exclusive site falls back before clearing its Agent state.
14. Source variance remains: browser could not fetch models.dev API or DeepSeek script; implementation uses only their supplied contract and the fetched models.dev repository schema.
15. Verification: fixed suite 5 files/53 tests passed; full `npm test -- --run` passed 62 files/618 tests, skipped 0; `npm run build` passed.
16. Reverse verification: deliberately changed unavailable-model route detection to inspect filtered availability; data-architecture test failed as expected, then passed after restoring the check.
17. Return-work race repair: Web, CLI adapters, and sync dirty metadata now serialize user.json commits; stale snapshots merge by Agent/site and override field, while explicit deletion carries a deletion intent.
18. Real temporary-HOME acceptance now covers on-disk migration backup/size/cache split; preview-without-selection-change; refresh remote-only/directory-only/offline; two-model home + Codex/Claude/OpenCode files; tier map; deletion cleanup; and A→B site sync retaining B's cache.
19. Reverse verification (this run): restoring Web's legacy `{providers, platforms}` save made provider-flow fail at expected v2, then restoring `_store.saveProviders` returned the fixed suite green.
20. Final verification (2026-08-26): fixed 5 files/57 tests, full 62 files/622 tests (skipped 0), build, and `git diff --check` all pass; provider-flow passed ten consecutive full-file runs.
21. Independent upgrade-loss regression repaired: syncing into a legacy receiver now backs up its v1 file, merges embedded models into (without replacing) local models-cache facts, then performs one v2 sites write. Temporary-HOME regression verifies legacy-only and pre-existing cached models both survive alongside the remote site; fixed/full/build/diff verification remains green.
22. Sync compatibility regression repaired: an empty legacy receiver has no model facts to preserve, so it is converted directly to the merged v2 sites document without creating a competing legacy backup write. This retains the established fs.writeFile sync compatibility path and its vaultKey assertion. `sync.test.js` passed 5 consecutive runs; fixed suite passed; full suite passed twice; build and diff-check passed.
23. Codex switch regression repaired in the shared c12a worktree: `switchProvider()` now saves its updated Agent state normally rather than passing the deletion intent. The temporary-HOME provider-flow regression switches Codex from one of two selected models to the other and asserts the site plus both models remain while activeModel changes. Reported verification: targeted 2 files/13 tests, full 62 files/622 tests, build, and diff-check passed; real Codex→DeepSeek four-model state survived the auto-sync window in disk/API/UI.


## Agent configuration orchestration (2026-08-27)

- Baseline matched `f49edca`; dependency absence was resolved using an isolated npm cache.
- Added one CommonJS service for model routing, vault authorization, snapshots, Adapter writes, desired-state persistence and operation logs.
- Web save/switch/tier, CLI switch/use, and sync-pull reconciliation delegate to it.
- Sync commits accepted remote desired state first; each site reconciles independently and failures remain local diagnostics/retryable.
- A→B temporary-HOME test verifies Codex, Claude, OpenCode remote IDs plus an unavailable-site retention failure and repeat pull.
- Reverse test: temporarily removing reconciliation made the A→B test fail because native Codex config was absent; restoring made it pass.
- Full verification: 70 files / 726 tests, skipped 0; build and diff check passed.

## Review follow-up (2026-08-27)

- Moved the service to `src/application`; API/CLI/sync now depend on this application boundary rather than another HTTP module.
- Native remove, fallback and additive disable paths are service operations; catalog-less official fallback now completes instead of restoring the removed snapshot.
- Added temporary-HOME tests for default/injected dependencies and precise Codex provider deletion; 72 files / 729 tests, build and diff check pass.

## Migration cleanup (2026-08-27)

- Removed the stale API-layer service and duplicate TypeScript copy; `src/application/agent-config-service.js` is the sole CommonJS source.
- Verified zero source/test references to the old API path; focused 18-test suite, full 72-file/729-test suite, build and diff check pass.

## Provider API layering phase 1 (2026-08-27)

| Old HTTP export/handler | Application owner |
| --- | --- |
| CRUD / provider deletion | `provider-service` |
| auth, Vault binding, connection checks | `provider-service` |
| model discovery, preview, cache merge | `provider-service` |
| Agent selection/configuration | existing `agent-config-service` |
- Baseline `126a7fa`: 72 files / 729 tests passed; controller delegation preserves the existing exported handler surface.

## Provider API layering phase 2 (2026-08-27)

| Module | Lines | Responsibility |
| --- | ---: | --- |
| `provider-service` | 819 | compatibility exports and HTTP entry mapping for provider flows |
| `provider-lifecycle-service` | 100 | provider create/update/delete and Agent-site cleanup orchestration |
| `provider-auth-service` | 535 | Vault binding repair, authentication and OAuth checks |
| `model-discovery-service` | 497 | endpoint/CLI discovery, preview and model-cache merge |
| `provider-status-service` | 432 | provider/Agent status projection and launch support |

- Module handoff repair: status receives `sortProviders`; discovery receives `findCommand`; auth receives both `loadProviders` and `providerEndpointEntries` through explicit dependencies.
- Lifecycle deletion still delegates native Agent cleanup exclusively to `agent-config-service`; it retains other providers and uses the existing response semantics.
- Focused verification after the lifecycle extraction: 5 files / 108 tests passed.

## Provider HTTP boundary correction (2026-08-27)

- `src/web/api/providers-controller.js` is now the sole Express transport adapter; `providers.js` only exposes that controller for the historical route module.
- Lifecycle operations are pure `createProvider(input)`, `updateProvider(id, patch)`, and `deleteProvider(id)` calls that return result values or throw errors carrying the established status/code.
- Discovery, authentication, status, launch, Agent selection and config-file operations now likewise return values/throw domain errors; no application Provider service reads Express `req`/`res` or calls `status/json`.
- Added direct application lifecycle coverage for vault-key preservation and scoped Agent-site cleanup. Existing temporary-HOME `provider-flow` coverage verifies offline empty discovery preserves cache.
- Boundary check: `rg` found no Express `req/res` or `status/json` usage under the Provider application services. Focused 5 files / 101 tests and full 73 files / 730 tests passed; build and diff-check passed.

## Auto-create split baseline (2026-08-27)

1. HEAD `199d382`, worktree clean; `auto-create.js` is 5734 lines.
2. Existing scope: credential resolver, form state and platform directory tests.
3. Sequence: pure extractors/scoring/catalogue → run state machine → browser runtime/flows → thin controller.
4. Maximum risk: browser capture/verification flow is timing-sensitive; preserve URLs, protocol calls and response shapes exactly.
5. No baseline mismatch observed; begin with dependency-free modules and focused tests.
6. In progress: added pure extraction/action/directory modules, DI run lifecycle and browser runtime; route status/resume/interactive execution now use the lifecycle service.
7. Focused auto-create suite: 4 files / 115 tests passed; full suite: 74 files / 734 tests passed; build and diff-check passed.
8. Not ready to commit: `auto-create.js` is still above the controller line target while remaining browser platform flows are being separated.
9. Further split in progress: Zhipu (540 lines), Volcengine/MiniMax (451), specialized delete (294), generic delete (751), capture extraction (355), and static platform catalogue (191) are now separate modules; `auto-create.js` is 3277 lines.
10. `sync.test.js` 的超时已在干净当前树和独立子集复现，落在远端 Agent 选择 reconciliation 与 fake timers 的交界；不是 Auto-create 异步句柄，不作为本阶段 BLOCKED。
11. 通用 browser create 已实拆为 navigation 470 行、form 862 行、result 483 行；创建/恢复编排 289 行，浏览器状态 248 行，所有模块均低于 900 行。
12. `auto-create.js` 现为 421 行，仅保留 HTTP 映射、依赖装配与兼容导出；Cloudflare REST 与 key parser 已移到 application。
13. 复核：4 个 Auto-create 聚焦文件 / 115 测试通过，`npm run build` 与 `git diff --check` 通过；全量为 73 files/733 tests 通过，唯一 `sync.test.js` 既有 fake-timer 超时（按任务要求非本工作阻塞）。

## Usage split baseline (2026-08-27)

1. HEAD `5fc54e4`, clean worktree; `usage.js` is 2122 lines and exports HTTP routes plus parsers/signers/provider queries.
2. Existing focused coverage is `tests/usage.test.ts`; preserve return shapes, provider endpoints, Vault keys and browser-session boundaries.
3. Order: pure parsers/signers → Vault/session access → injected provider registry → thin HTTP controller.
4. Maximum risk: Xiaomi browser session isolation and provider-specific fallback text; preserve current error paths exactly.
5. Completed: `usage.js` is now a 2-line compatibility controller entry; `usage-controller.js` is 111 lines and is the only Express transport mapping.
6. Strategies: API/local credentials 864 lines, browser/session 804, cloud control-plane 154, parsers/signers 366, provider registry 30, Vault service 31; each is below 900.
7. Verification: `tests/usage.test.ts` 14 tests, full `npm test -- --run` 74 files/736 tests, build and diff-check all passed.
8. Sync stabilization: fake-timer timeout came from reconciling remote sites absent from local provider sites through full model-catalog hydration. `syncPull` now records those as retryable per-site `PROVIDER_NOT_FOUND` results before hydration; desired remote state is still persisted and real local sites still use Agent service reconciliation.
9. Evidence: `tests/sync.test.js` passed 5 consecutive times (0.36–0.42s); full suite passed twice consecutively (74 files / 736 tests); Usage 14/14, build and diff-check passed.

## ModelsPage split baseline (2026-08-27)

1. HEAD `30a271f`, clean worktree; `ModelsPage.tsx` is 2225 lines.
2. Existing page contains page state/API calls (lines 160–1086), detail/grid/action components, and a 500+ line provider editor.
3. Split order: shared types/filter utilities → API/state hook → list/detail/editor components → ≤400-line orchestration page.
4. Maximum risk: preserve editor connection/Vault/OAuth callbacks and the existing Paper Cutout design tokens exactly.
5. Completed: `ModelsPage.tsx` is now a six-line composition root. API calls and page state live in `useModelsPageState`; the editor connection probe and model fetch lifecycle live in `useProviderConnectionTest`.
6. Presentation is split by responsibility into workspace, platform cards, platform/model details, action menu, and provider form components. Existing CSS class names and callbacks were preserved.
7. Removed the two state values which had no writer/reader path (`endpointResults` and the unused card authentication-method map). Cross-view authentication and endpoint normalization now share `modelsCatalog` rather than copying rules.
8. Added pure catalog regression coverage for protocol filtering, endpoint normalization, and authentication readiness. Focused test: 4/4. Full suite: 75 files / 740 tests. Frontend and root builds plus `git diff --check` pass.

## Sync domain end-to-end split (2026-08-28)

### Dependency and migration plan

1. Existing transport modules depended on `cloud-sync-core` for encrypted cloud payloads, LAN pairing/listener state, config persistence, provider-site merges and direct post-pull Agent application. The risk was that a successful pull could persist UI desired state without applying the native Agent file.
2. Preserve the public `cloud-sync-core` and `sync.js` exports for scheduler, settings, platform adapters and server route registration. Move application decisions behind injected boundaries; do not alter payload/encryption formats or user data schema.
3. Pull order is explicit: merge portable provider sites → merge vault secrets → persist timestamp-accepted Agent selection/overrides → invoke only `agent-config-service` for native configuration → publish UI event and structured diagnostics.

### Resulting responsibilities

| Module | Responsibility |
| --- | --- |
| `src/web/api/cloud-sync-core.js` | Compatibility composition facade; no cloud merge business logic. |
| `src/web/api/sync.js` | Cloud HTTP responses and scheduler locking only. |
| `src/web/api/sync-lan.js` | LAN HTTP/pairing protocol validation and responses. |
| `src/web/api/lan-sync-server.js` | Thin listener facade. |
| `src/application/sync-service.js` | Push/pull/sync-code use cases, conflict ordering and observable result. |
| `src/application/sync-agent-reconciliation.js` | Desired-state diagnostics and sole delegation to `agent-config-service`. |
| `src/application/sync-config-state.js` | Pure nested user-state merge/removal and timestamp comparison. |
| `src/infrastructure/sync-*.js` | Config atomic-write queue, encrypted wire codec, remote platform/Vault references, portable provider sites, LAN socket/blob/pairing state. |

### Acceptance evidence to date

1. Static boundaries: `cloud-sync-core.js` is 115 lines, `sync.js` 141, `lan-sync-server.js` 14. Application sync modules have no Express `req`/`res`/`status`/`json` calls.
2. Temporary-HOME A→B integration starts B without local provider sites or Agent selection. B first accepts desired state but intentionally holds the provider partition back; it reports per-site `PROVIDER_NOT_FOUND` and writes no native configuration. When sites become eligible, B rebuilds model facts from its own models.dev snapshot, retries, and writes real Codex, Claude and OpenCode files. The remaining unresolvable site stays desired state with `MODEL_NOT_FOUND` diagnostic.
3. Controlled red→green: temporarily replacing the reconciler's `agent-config-service.reconcile()` call with `return []` made the isolated A→B integration fail with absent `~/.codex/config.toml` (expected red). The line was restored and the same integration passed (green).
4. Pure regressions cover nested selection/override merges, strict timestamp conflict policy, per-agent/per-site desired diagnostics, portable provider payload projection, and provider→vault→config→Agent pull ordering.
5. Focused current result: `npx vitest run tests/sync.test.js tests/sync-domain.test.js tests/sync-scheduler.test.ts tests/web/lan-sync.test.ts tests/web/agent-config-sync-reconciliation.test.ts` — 5 files / 65 tests passed in five consecutive runs.
6. Final verification: `npm test -- --run` passed twice consecutively — 77 files / 750 tests, skipped 0 both times. `npm run build` and `git diff --check` passed after the final test change.

---

# Update watcher（2026-08-30，分支 codex/feat/update-watcher @ 5ebc9ec）
目标：常开桌面端在 GitHub latest 传播后的下一个 15 分钟周期内静默显示更新徽章。实现：后端 watcher（15min 固定间隔+启动随机相位、ETag/304、403/429 指数退避封顶 2h、新 tag>运行版本且变化时 SSE 广播 update-available 恰一次）+ 前端（SSE section 触发静默 check、visibilitychange 5min 冷却复查）。fake-timer 后端 7 测试 + SSE section 测试 + 聚焦策略测试；全量 821/822（唯一失败=已知 v1.0.38 notes 门禁）。

# QA P0 修复（2026-08-31，基于 5ebc9ec）
- P0-1：stop/start 后 304 吞通知——latestEtag 跨重启保留但 hasBaseline 重置，304 不重建基线，后续新 tag 被当首次。修复：304 在无基线时从共享 cache 重建基线（绝不为既有 release 广播）。精确序列反证测试先红后绿（update-watcher.test.js 第 8 用例）。
- P0-2：silent check 先把 available 改 checking，失败时守卫失效→回退 error。修复：抽出 beginUpdateCheck/failUpdateCheck 纯函数——silent 且 available/upToDate 时进行中与失败后均保留原状态（含 release 信息）；显式检查错误照常上浮。转换语义 9 用例先红后绿（useAppUpdate.policy.test.ts）。
状态：定向三文件全绿；fresh 全量除已知 v1.0.38 门禁基线失败外无新增失败。

# 诊断页更新入口调整（2026-08-31，@ 3eadd36）
格式门禁：PROGRESS.md EOF 多余空行清除（9b191f3）。诊断页 UpdateDetailsEntry（常驻“查看更新详情”）替换为 UpdateCheckButton：settings.updateCheck 标签 + RefreshCw，检查中 Loader+禁用，点击经 performSettingsUpdateCheck 调 check(false) 并以既有 toast 键反馈，不打开详情面板；详情/下载/安装仅由左上角 TitlebarUpdateIndicator 承接。回归测试 tests/frontend/update-check-entry.test.ts（编排行为 + 真实 renderToString 断言），红→绿 7 失败→7 通过。

# Ubuntu CI provider-flow 竞态修复（2026-08-31，基于 origin/main e0ea6b1）
任务书后半截断，按可见使命执行（细节假设记入 BLOCKED.md）。CI 33355240086 ubuntu 失败：provider-flow「runs API → store → adapters」行 127 modelOverrides['flow-open'] undefined。根因（代码级+体外双重实证）：createProvider/updateProvider 的 markDirty→recordLocalChange 为发射后不管排队写，夹具裸写 user.json 与其「读在裸写前、写在裸写后」的 straddle 交错时，旧快照落盘覆盖 overrides 段——与 b5ab9d6（hydration 夹具）同族；recordLocalChange 在 handler 内同步入队（sync-scheduler.js:41-43），故裸写前 await 一个排队写即严密 drain。修复仅动夹具：裸写前 `await syncCore.recordLocalChange('providers', …)`。验证：定向 14/14 ×6 轮（3 轮 CPU 饱和）；体外 A/B 对照（未修复 straddle 必丢 overrides=CI 同错；drain 后 overrides={context:777,output:333} 存活）；fresh 全量 98 文件/839 测试全绿（main 已含 v1.0.38 notes，基线无已知失败）；build 绿。未改业务生产逻辑。

# Provider 真实验收工具·第一阶段开工（2026-08-31，worktree integration-refactor-suite）
- 目标：新增发布前人工触发的 `scripts/provider-live-acceptance.mjs`（guest / auth-verify / create-cleanup 三模式），平台目录自动读 AUTO_CREATE_PLATFORMS，产物仅入 `~/.okit/provider-live-acceptance/`；同步收紧旧 auto-create-key-check.mjs 的无平台批量创建。
- 顺序：先基线核对 → 设计安全边界（专用 profile、只读探针、动作白名单）→ 实现脚本与启动器 → 离线测试（含假浏览器反例）→ 反向验证三例 → 文档+提交（不 push）。
- 最大安全风险：误碰日常 Chrome 登录态（profile 复用/复制）与真实创建第三方 Key；对策=guest/auth-verify 走专用 profile Chrome + CDP 只读探针（结构上无创建通路），create-cleanup 双重确认且单平台、清理失败即停。
- 基线实测（2026-08-31 21:4x）：`--list` 32 平台=1 api(cloudflare)+31 browser ✓；定向 4 文件 57/57 通过 ✓；`npm run build` 见下一条回执。
- 基线补记：`npm run build` exit 0（141 行日志，前端构建成功）；三项基线均与任务书一致，未触发 BLOCKED。

# Provider 真实验收工具·第一阶段交付回执（2026-08-31）
- 新增 `scripts/provider-live-acceptance.mjs`（npm run test:providers:live）+ `scripts/provider-live-chrome.mjs`（专用 Chrome 启动/登录辅助）+ `scripts/lib/live-acceptance/`（safety/args/platforms/probe/report/browser/orchestrate 七模块）。guest=临时 profile CDP 只读探针验证登录墙；auth-verify=专用持久 profile 验证安全入口（不点击创建类动作）；create-cleanup=单平台+`--allow-create-and-cleanup`+`--with-extension` 三重门槛，委托 auto-create-key-check.mjs，清理失败即停。平台单一真源 AUTO_CREATE_PLATFORMS（32=1 api+31 browser），未另抄名单。
- 安全边界实证：日常 profile/Cookie 迁移/无平台批量创建均拒绝（反向验证#1/#2 exit 1/2）；假浏览器"页面改版入口消失"走真实编排管线 exit 1 且产出可定位报告（tests/fixtures/live-acceptance-reverse-harness.mjs）；报告脱敏（key/JWT/query 串）有测试断言；产物只写 ~/.okit/provider-live-acceptance/。
- 旧 auto-create-key-check.mjs 收紧：真实创建需显式平台+危险确认开关，--list/--cleanup/dry-run 保留。
- 测试结果：新增 tests/provider-live-acceptance.test.ts 54/54；定向 4 文件 57/57；全量 `npm test -- --run` 104 文件/919 测试全过零 skip；`npm run build` exit 0。本阶段未真实创建任何第三方 Key（create-cleanup 仅 dry-run 验证）。

# Provider 真实验收工具·guest 真实巡检回执（2026-08-31，续 35e3340）
- 应用户要求继续推进不越界的部分：真实 guest 巡检（无需登录、不创建任何 Key、一次性临时 profile）。首轮单平台即暴露真 bug：新版 Chrome /json/new 忽略 ?url= → 探针停在 about:blank（报告 loginUrl=nullblank）；修复=Page.navigate 显式导航 + about:blank 信号 + 内容感知结算（等正文出现，上限 30s）。
- 二轮暴露镜像偏差并修复（均有产品侧既有逻辑对应）：anthropic「Continue with Google」、kimi「注册/登录」、volcengine-agent「立即登录使用」入显式登录动作族（对应 isLoginFailure/detectVolcengineLoginSurface）；auth.* host 入登录页判定（opencode-go 跳 auth.opencode.ai）；登录动作检测并入锚链接（产品原版扫描 a+button 合集，xai 的 Sign in 是 <a>）。另修探针模板转义回归（\/ 提前闭合正则致页面脚本报错），新增 new Function 可编译离线测试防复发。
- 三轮全量 31 平台矩阵：稳定通过 14；波动 13（渲染时序/第三方风控抖动，重跑可过）；从未通过 4 = volcengine/qwen-token-plan/stepfun/xai——未登录可浏览控制台的真发现（登录面仅在动作时出现），按 failed 如实报告，未做超产品语义的假修。报告/截图均落 ~/.okit/provider-live-acceptance/，全程零创建动作。
- 离线测试 56/56（新增可编译+显式动作族断言）；全量与 build 见提交前验证。auth-verify 真实巡检仍待人工在专用 profile 登录后执行（外部前置，未声称任何平台验收通过）。

# live-acceptance P0/P1 修复（2026-08-31 晚，基于 d9f955d，不改产品自动创建业务）
- P0（create-cleanup 扩展身份）：cdp-status 只证明"某个扩展在线"（产品 WS hello 仅 version/protocol），日常 Chrome 扩展可被误用。落地方案=一次性会话绑定：`provider-live-chrome --with-extension` 生成 sessionId + 启动记录（sessions/<id>.json：专用 profile/调试端口/pid/副本目录，24h 时效）+ 物化**补丁扩展副本**（只复制运行时文件，产品扩展零修改；hello 附 acceptanceSession，auth-ok 与 ~20s keepalive 心跳向本地 witness 127.0.0.1:9341 上报 {sessionId, wsUrl, wsState}；锚点替换校验"恰好一次"，漂移即 fail closed）。create-cleanup 闸门（scripts/lib/live-acceptance/sessions.mjs + orchestrate verifyDedicatedExtensionIdentity）：--session 必填→记录校验（隔离/时效/副本完整性）→专用 Chrome CDP 存活→witness 新鲜窗口内收到本会话、wsState=OPEN、目标端口心跳；任一无法证明→`unverified_extension_identity`（exit 1）且**零委托调用**，不降级为"提示停用日常扩展"（残余竞态=单扩展槽位被日常扩展抢占的理论窗口，文档如实说明，非放行条件）。
- P1（guest 信号清理）：signals.mjs registerSignalCleanup——SIGINT/SIGTERM 尽力（3s 预算）driver.dispose（关本次启动的 Chrome + 删临时 profile）后 130/143 退出；SIGKILL 不可捕获已如实写入文档（残留 tmp 手工清理）。CLI 在驱动创建后注册、runAcceptance 结束后注销。
- 关键工程点：extension/dist 被 .gitignore（CI checkout 无产物）→ 提交真实产物快照夹具 tests/fixtures/extension-dist-sample/ 驱动补丁测试（node --check 语法校验），真实 dist 存在时跑逐字节一致性锚点漂移检测；vitest 4 移除 it 第三参 timeout（改二参）。
- 实跑证据：普通扩展在线（本地假 cdp-status available=true）+ 无会话证明 → unverified_extension_identity/exit 1/委托哨兵未触发（tests/fixtures/live-identity-reverse-harness.mjs）；CLI 有危险确认但无 --session → exit 2 拒绝；dry-run 计划含 verify-extension-session 步骤。测试：定向 71/71；全量 `npm test -- --run` 104 文件/936 测试全过零退化（基线 921+15 新增）；`npm run build` exit 0。未真实创建任何第三方 Key，未 push。

# create-cleanup 真实执行硬禁用（2026-08-31 深夜，裁定落地，基于 a354471）
- 裁定确认根因未消除：服务端单扩展槽位（后认证者替换 extWs）+ 自动创建命令不按 session 绑定 → witness 只能证明专用扩展“刚刚在线”，同机无法证明真实创建不落日常 Chrome。属约束冲突（不改产品扩展/WS 协议即无解），P0 仅被缩小。
- 落地：orchestrate 真实分支前置硬禁用——`disabled` 状态（exit 1，零 fetch/零委托/零网络），三重门槛+身份证明全过也拒绝；`createCleanupRealRunEnabled` 选项仅测试注入（CLI 永不传），委托管道逻辑保留并用注入验证。dry-run 计划不变。
- 定位调整：guest/auth-verify = 发布前巡检能力（保留）；create-cleanup = 已实现但禁用，不作为可执行真实验收能力宣传。文档写明解禁二选一：① 隔离 VM/独立机器跑专用服务+专用 Chrome；② 改产品 WS 协议（服务端记录 acceptanceSession、命令按 session 发送、被替换即拒绝）。P1 信号清理保留（独立有效改进）。
- 测试：73/73（新增默认硬禁用反例=身份全过仍拒绝零 fetch 零委托；CLI 全参数 exit 1 disabled；既有身份/委托用例改注入解禁，语义不变）；全量与 build 见提交信息。未 push。

# 报告同秒覆盖 P1 修复（2026-08-31 深夜，验收方复现：20260831155122-live-create-cleanup.json 被同秒两跑共享覆盖）
- 根因：报告文件名精度只到秒。修复：① uniqueRunStamp=毫秒(17位)+随机4位hex，orchestrate 默认 stamp、CLI guest 临时目录、截图目录统一改用该 runKey（同秒 guest 双跑也不再共享临时 profile/截图目录）；② writeReportFile 改独占创建（flag:'wx'，EEXIST 重试追加随机后缀，上限8次）——即使调用方传入完全相同 stamp 也绝不覆盖，只会改名落盘。
- 实跑复现修复：同秒两次 `--mode create-cleanup --platform zhipu --dry-run` → 20260831160132871-eafd-…json 与 20260831160133458-3943-…json 两份并存。
- 测试：新增3例（同秒双跑两份报告互不覆盖、writeReportFile 独占反例、默认 stamp 唯一性+格式），定向 76/76；全量 104 文件/941 测试零退化；build exit 0。仅提交于 integration-refactor-suite（e93e worktree 有他人已暂存删除，未触碰）；未 push。

# 报告碰撞测试缺口修正（2026-09-01，验收方指出 44dc5ba 的"双跑"测试用两个 tmpRoot()，路径冲突从未发生）
- 修正：双跑用例改为共享同一 root + 相同秒级 stamp，且读取两份报告内容断言各自完好（requestedPlatforms 分别为 zhipu/openai，共享 reports/ 目录中恰有两份文件，第一份未被第二份覆盖）。
- 红→绿实证：将 report.mjs+orchestrate.mjs 临时回退到修复前（f0bf6fb）后，新测试以"两次 reportPath 完全相同"变红（AssertionError: expected … not to be …，即覆盖症状本体）；恢复修复后转绿——测试现在是真实回归护栏而非空转。
- 定向 76/76；全量 104 文件/941 测试零退化；build exit 0。仅提交于 integration-refactor-suite；未 push。

# auth-verify 判定修复（2026-09-01 凌晨，基于 afdd40e，修 20260831171718115-d390 报告证实的五类误判）
- 方法：先写测试（8 例，7 红 1 绿——"真改版"护栏未被削弱）再改实现。新页内信号全部按真实报告证据标定：登录跳转过渡（openai "Signing in…"：标题/正文短语或 ≤40 字正文+零可操作元素）、首次组织选择（anthropic Create Organization + Individual/Organization 按钮）、管理页级确认（moonshot 路由+导航+≥300 字已渲染内容；volcengine 标题 "API Key 管理"）、骨架（class 含 skeleton/shimmer 且按钮≤3）、空壳。
- 判定顺序重排 + 有界稳定性等待（连续两次探针签名一致才可下改版结论；签名=正文字数+按钮数+链接数，窗口=既有 settle 上限，不无限等待）。新状态 page_not_ready（exit 2）：未就绪 ≠ 改版。safe_entry_missing 仅当"稳定+控制台可确认+配置入口全缺"。
- 验证：定向 84/84；全量 104 文件/949 测试零退化；build exit 0；真实只读复跑 17 平台（D）零 failed：入口级 10、管理页级 1（volcengine 补强生效）、page_not_ready 2（volcengine-agent/qianfan 本轮未就绪）、blocked 3（qwen 系/qianfan-coding 需人工订阅前置，语义保持）、waiting 1（openai 登录过渡）。报告 20260831173056766-9421-live-auth-verify.json，退出码 2 为诚实非通过项。未点击/输入/创建/删除任何第三方资源；create-cleanup 真实创建保持硬禁用；未 push。
