# User config mutation architecture gate

Status: design gate for the P0 lost-update repair. This document inventories every production path that reads or writes `~/.okit/user.json`. It does not authorize a product implementation by itself.

## Invariant

A production business layer must never submit a complete `user.json` object obtained from `loadConfig()`/`loadUserConfig()` for persistence. The only durable production write is a `writeTail` item in `sync-config-store`: it re-reads the live file, applies a narrowly owned mutation or patch, normalizes it, backs it up, and writes with temp-plus-rename. Full replacement is initialization/test-only, has an explicit `ForTest` name, is private to test construction, and is not exported through the application/web composition root.

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

## Final semantic API boundary

`writeTail`, file reads, normalization and temp-plus-rename are private implementation details of `sync-config-store`. Neither application modules nor `cloud-sync-core` exports a generic mutation callback, a full replacement, a `save*` alias, or an API accepting `sync`, `platforms`, `lan` or a whole user configuration object.

The public composition boundary contains only the following semantic operations. Each validates an exact input schema before entering the private queue; unknown fields, nested snapshots and old aliases are rejected.

| Current writer | Public semantic operation | Allowed input / ownership | Delete and timestamp rule |
| --- | --- | --- | --- |
| settings sync form | `updateSyncPlatform(platformId, fieldPatch)` and `updateSyncSettings(fieldPatch)` | platform id from registered adapters; per-platform allowlist; `autoSync`, `syncPlatform`, password-ref only | field patch may not contain `platforms`, `lan`, `localChangedAt` or config; no delete except explicit approved credential clear |
| scheduler markDirty | `recordLocalChange(scope, timestamp)` | scope is `secrets`, `agentProviders`, `modelOverrides`, or `providers`; timestamp is ISO string | invalid timestamp rejects; stored value is max(valid live, valid input) |
| sync push | `recordSyncSuccess(metadata)` | machine id, pushed target ids, remote version, successful sections and timestamp | metadata schema only; timestamp monotonic; no platform/Agent data |
| sync pull | `applyPulledSyncState(remoteIntent)` | validated decrypted wire intent: remote version/machine id, optional provider sites, Agent selection and model overrides | private queue recomputes conflict guards from live `localChangedAt`; replaces only eligible remote sections, never accepts local snapshot |
| sync-code import | `importSyncTarget(intent)` | password plus one registered platform id and its registered field schema | merge only that platform; no arbitrary platform map |
| LAN enable/disable/regenerate/pair/listener fallback | `updateLanConfig(operation, fields)` | operation enum plus `port`, `enabled`, generated token or paired remote endpoint; endpoint URL validated | only LAN and local LAN platform fields; listener writes port only if current token/enable state still matches |
| provider lifecycle deletion | `removeProviderSelections(providerId)` | one known provider id | deletes that provider's model overrides and matching Agent sites only |
| Agent configuration + adapters + CLI | `patchAgentSelection(agentId, selectionIntent)` | registered agent id; active ids and site map with normalized model ids/tier map | `site: null` and active id `null` are explicit deletes; omission preserves live state |
| model UI / sync desired state | `patchModelOverrides(providerId, modelPatch)` | one provider id; model-id keyed allowed override fields | explicit model delete marker only; omitted model preserves live state |
| i18n/onboarding/project preference | `patchUserPreferences(preferencePatch)` | language, hints, git and repo allowlists only | no sync/Agent/model keys; explicit supported preference clear only |
| legacy migration | `applyLegacyMigration(migrationIntent)` | versioned legacy-shape discriminator produced by reader, never whole read snapshot | private queue re-reads live, migrates only legacy fields, preserves current new fields |

Read APIs may return snapshots for rendering or remote requests, but a read result cannot be accepted by any write API. `replaceConfigForTest` is private to test-store construction; it is not re-exported by production modules.

## Private normalization semantics

The store validates and normalizes intent after its queue-fresh read. Valid ISO timestamp keys retain the later instant; invalid input rejects rather than replacing valid state. Agent/model maps deep merge only their owning IDs. `site:null`, active-id `null`, and an explicit model deletion marker are the only deletions; omitted fields always preserve live state. `applyPulledSyncState` receives a remote wire intent, not a callback: it recalculates `shouldApplyRemoteSection` against live timestamps within the private queue before changing any desired state.

## Guard design

Add a source-contract test/script that recursively scans production `src` (excluding frontend, tests, generated output and the test-only replacement helper) and fails on:

1. imports/exports/calls of deprecated `saveConfig`, `saveUserConfig`, generic `updateUserConfig` or generic `patchUserConfig` production APIs;
2. a `loadConfig`/`loadUserConfig` binding subsequently passed as a complete argument to any config persistence call; and
3. direct `user.json` `writeJson`/`writeFile` outside `sync-config-store`.

The guard is intentionally limited to deprecated API/direct-write surface checks; it must not claim to prove dataflow. Runtime API-shape tests prove that every public semantic operation rejects config/sync/platform/LAN snapshots, unknown fields and deprecated aliases. Its test injects a synthetic old `loadConfig(); saveConfig(snapshot)` call and a direct `user.json` write; each must fail independently.

## Required negative acceptance

1. **Alias attack:** invoke every removed generic alias (`mutateConfig`, `saveConfig`, `saveUserConfig`, generic sync patch) from the production composition module and assert it is absent/throws before disk access.
2. **Deep-copy attack:** pass `{...loadedConfig}`, `{sync: loaded.sync}`, `{platforms: loaded.sync.platforms}`, and unknown nested keys into each semantic write operation. Assert schema rejection and byte-identical `user.json`.
3. **Old-sync attack:** capture an old valid sync object, make a newer settings/scheduler/LAN write, then attempt to apply the old object through every public route. Assert rejection and byte-identical newer fields.
4. **Real-disk rollback attack:** temporary HOME+USERPROFILE; pause queue processing and interleave every semantic writer from the table. Verify every newest owned field from actual `user.json`, including Cloudflare/WebDAV/LAN/lastSync/localChangedAt/Agent/overrides, survives.

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
