# OKIT data architecture progress

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
