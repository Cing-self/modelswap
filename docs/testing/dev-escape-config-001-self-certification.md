# DEV-ESCAPE-CONFIG-001 — configuration mutation self-certification

Status: development in progress. This is the required developer evidence package before this P0 may be sent to QA.

## Root-cause graph

```text
queue-external readConfig snapshot
        │ crosses request / network / native-Adapter async work
        ▼
generic saveConfig(snapshot)
        │ queue serializes only the final overwrite, not the original read
        ▼
newer independent fields disappear
  ├─ scheduler localChangedAt
  ├─ settings platforms/LAN/WebDAV
  ├─ sync lastSyncAt/lastRemote/remote desired state
  └─ Agent selections/model overrides
```

The root fix is not a writer-specific merge: all durable `user.json` changes must be a write-tail mutation that first reads the queue-fresh file and writes only the caller's owned intent.

## Production writer migration checklist

The checklist is now driven by the v4 machine-readable `config-mutation-registry.json`. The failed `fbe5143` experiment satisfies none of these rows. “Migrated” may only be set after its exact registry ID has an AST-inventory match, JSON-Schema negative test, independent real-disk race participant and byte-identical rejection proof; area summaries are not evidence.

| Area | Required target | Status | Evidence still required |
| --- | --- | --- | --- |
| config store + legacy migration | queue-internal semantic operation, temp+rename | design target | direct migration versus competing writer integration |
| settings/onboarding | individually registered sync/preference operation | design target | settings paused-read competitor |
| scheduler markDirty | `recordLocalChange` narrow operation | design target | scheduled markDirty competitor |
| sync push/pull/import | decoded per-action operations with live re-evaluation | design target | real push and pull competitors, including stale remote guard |
| LAN controllers + listener | one closed LAN action per entrypoint | design target | listener assigned-port and pair competitors |
| provider lifecycle | one-provider deletion operation | design target | provider delete versus Agent/override competitor |
| Agent config service/reconciler | one binding/action operation, no snapshot restore | design target | native write/reconcile competitor |
| CLI/config-user/i18n/adapters | individually registered preference/sync/Agent operations | design target | one CLI and every adapter persisted-state check |
| direct user.json writers | config store only; test private replacement | pending audit proof | source guard plus injected direct-write fixture |

No item is eligible for “complete” until its final column has executable evidence. Any exception must be explicitly approved by CEO and listed here.

## Required executable evidence

1. **Red → green:** preserve the existing paused settings-read race, demonstrate the old snapshot save loses a field, and demonstrate the scoped implementation keeps every field.
2. **Bypass proof:** inject both `loadConfig(); saveConfig(snapshot)` and a non-store direct `user.json` write into the AST guard input; CommonJS/ESM aliases, destructuring and re-exports must each fail independently.
3. **Integration matrix:** one temporary HOME+USERPROFILE process with actual store I/O must interleave settings, scheduler, sync push, sync pull, sync-code import, LAN controller/listener, provider delete, Agent native/reconcile, model override and legacy migration. Assert the on-disk final file contains every independent latest intent.
4. **Adapter matrix:** derive all registered adapters; each must persist a scoped Agent selection and no adapter may call a generic config writer.
5. **A→B proof:** execute A01–A10 from the registry, dynamically cover all ten adapters, prove payload/cache separation and prove native-only reconciliation cannot persist user config.
6. **Release record:** enumerate changed files, source-guard results, default-parallel full runs, package/build result, known no-coverage bounds and release recommendation.
