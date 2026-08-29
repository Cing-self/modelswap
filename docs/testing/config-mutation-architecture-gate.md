# User config mutation architecture gate

Status: design gate for the P0 lost-update repair. This document inventories every production path that reads or writes `~/.okit/user.json`. It does not authorize a product implementation by itself.

## Invariant

A production business layer must never submit a complete `user.json` object obtained from `loadConfig()`/`loadUserConfig()` for persistence. The only durable production write is a `writeTail` item in `sync-config-store`: it re-reads the live file, applies a narrowly owned mutation or patch, normalizes it, backs it up, and writes with temp-plus-rename. Full replacement is initialization/test-only, has an explicit `ForTest` name, and is not exported through the application/web composition root.

## Current call graph and classification

| Caller / path | Current read and write shape | Classification | Cross-async boundary / required migration |
| --- | --- | --- | --- |
| `sync-config-store` | `loadConfig`; `saveConfig`; `saveUserConfig`; legacy migration | writer root | Keep the queue as the only filesystem writer; replace external snapshot saves with queue-internal mutations. |
| `web/api/settings` | read only for GET/onboarding; update already mutates through core | scoped writer / read-only | Keep update/onboarding in one mutation; no snapshot may leave the handler for a write. |
| `web/api/sync-scheduler#markDirty` | `loadConfig` → change `localChangedAt` → `saveConfig` | unsafe snapshot writer | Replace with a `sync` patch/mutation; this is QA's deterministic rollback path. |
| `application/sync-service#syncPush` | read for targets/payload → update machine/sync timestamps → `saveConfig` | unsafe snapshot writer | Network/vault I/O crosses the boundary; commit only its timestamp/machine-owned fields through a fresh queue mutation. |
| `application/sync-service#syncPull` | read for guards/targets → remote/vault/provider I/O → set desired state/sync → `saveConfig` | unsafe snapshot writer | Re-evaluate conflict guard and apply only remote-owned selections/overrides plus sync bookkeeping inside the mutation. |
| `application/sync-service#importSyncCode` | decrypt/vault I/O → read → mutate sync platform → `saveConfig` | unsafe snapshot writer | Commit only password, primary platform and its platform patch in a fresh mutation. |
| `web/api/sync-lan` enable/disable/regenerate/pair | read/remote pairing I/O → modify `sync.lan` and `platforms.lan` → `saveConfig` | unsafe snapshot writer | Each command owns only LAN fields; validation may read outside, but final mutation rereads live state. |
| `infrastructure/sync-lan-listener#applyConfig` | read listener settings; on assigned port change writes modified snapshot | unsafe snapshot writer | Commit only local LAN port/base URL in a fresh mutation. Other listener reads are read-only. |
| `application/provider-service` / lifecycle | direct user read + migration; Agent delete changes config then `saveUserConfig` | unsafe snapshot writer | Delegate reads/migration to config store and persist only Agent/override delete intent. |
| `application/agent-config-service` | reads desired state; native write async; persists full selected/removed/disabled state | unsafe snapshot writer | Persist agent-id scoped selection/site patch or explicit delete marker after native write; never resave its `before` snapshot on failure. |
| `application/sync-agent-reconciliation` | injects config store `saveConfig` to Agent service | unsafe adapter of snapshot writer | Inject an Agent-scoped mutation/persist operation; remote desired state is committed by sync pull, not full replace. |
| `config/user`, CLI `main`/`commands/sync`/`commands/provider`, i18n, adapters | `updateUserConfig` patches hints/language/sync/one Agent state | patch writers | Preserve as ownership-scoped patch users; legacy file migration must re-read inside the queue. |
| `web/api/sync`, settings GET, LAN status/pairing, listener identity/ping, platform test | reads only | read-only | May retain snapshots for decisions/requests; they must not be handed to a writer. |

`providers.json`, models cache, LAN blob and native Agent files are outside this `user.json` contract; their existing writers are not being changed by this batch.

## Target composition API

`sync-config-store` exposes only these production methods through `cloud-sync-core`:

```js
readConfig()                         // immutable/read-only snapshot
mutateConfig(owner, live => next)   // runs read → normalize → atomic write inside writeTail
patchSyncConfig(syncPatch, owner)   // owns sync; deep-merges platforms, lan, localChangedAt
patchUserConfig(userPatch, owner)   // owns hints/git/repo/modelOverrides/agentProviders/sync
patchAgentSelection(agentId, patch) // owns one Agent selection; site:null is an explicit delete
```

`owner` is a stable producer label for backups/logging. `mutateConfig` is reserved for operations that need conditional live state (sync pull conflict guards, paired LAN updates, migration); the callback receives the queue-fresh object and must return an object derived from that `live` value. `saveConfig`, `saveUserConfig`, and any generic full replacement are removed from production composition. A `replaceConfigForTest` helper is available only through test construction and throws/is absent in production.

Normalization is centralized: `sync.platforms`, `sync.lan`, and `sync.localChangedAt` deep merge; independently owned timestamp keys keep the later value; Agent/model override maps deep merge; an Agent `sites[providerId] === null` means delete and is never persisted as a null site. Sync-pull's replacement semantics are explicit per remote-owned section and re-evaluate `shouldApplyRemoteSection` against live queued timestamps.

## Guard design

Add a source-contract test/script that recursively scans production `src` (excluding frontend, tests, generated output and the test-only replacement helper) and fails on:

1. imports/exports/calls of deprecated `saveConfig` or `saveUserConfig` production APIs;
2. a `loadConfig`/`loadUserConfig` binding subsequently passed as a complete argument to any config persistence call; and
3. direct `user.json` `writeJson`/`writeFile` outside `sync-config-store`.

The guard exposes `assertConfigMutationContract(sources)` so its test injects a synthetic `const c = await core.loadConfig(); await core.saveConfig(c);` source and proves the rule fails; the real source tree must pass. The test does not depend on a hand-maintained allowlist of modules.

## Deterministic competition matrix

One temporary HOME+USERPROFILE child pauses the actual queue read for the first participant, starts each writer, then releases it. It asserts the final on-disk file, not mocks or response bodies.

| Participant | Owned final assertion |
| --- | --- |
| settings | Cloudflare platform partial update remains intact |
| scheduler `markDirty` | its `localChangedAt.providers` is present and newer than its prior value |
| sync push / pull | `lastSyncAt`, `lastRemote`, remote agent selection and model override conflict guard preserve the queue-latest values |
| sync-code import | WebDAV platform/password patch remains alongside unrelated platforms |
| LAN controller + listener assigned-port path | LAN enable/token/port and loopback platform URL change preserve WebDAV/Cloudflare |
| provider lifecycle / Agent selection / reconciler | per-Agent site, active model and explicit delete marker have expected independent results |
| config-user legacy migration | migrated legacy state plus queued model override and sync timestamp remain; no direct write occurs |

The same matrix contains a deliberate old snapshot-save implementation or injected contract violation to demonstrate red, then the target API green. Focused sync/provider/agent/config tests, default-parallel full suite three times with fresh HOME+USERPROFILE per child, build, package/runtime checks and `git diff --check` are the required post-approval verification.
