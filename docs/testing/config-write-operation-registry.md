# Configuration mutation registry (v4)

Status: **final design gate / implementation paused**. The only normative registry is the machine-readable [config-mutation-registry.json](./config-mutation-registry.json). This file intentionally does not duplicate registry rows, schemas or race IDs.

## How the future implementation consumes it

1. Load `entries` and select `kind: "writer"`; join every ID to `astSelectors[id]`, then compare AST-discovered writer IDs, registry IDs, `schemaId`s and `raceId`s as equal sets.
2. Compile each `schemaRules[id]` as JSON Schema. Invalid input must be rejected before a counted `fs.read*` or `fs.write*`; the pre/post `user.json` bytes must match.
3. Generate one real temporary-HOME+USERPROFILE race participant per `raceId`; the test fails if an entry has no independent participant.
4. Treat all `kind: "native-only-no-write"` entries separately: reconciliation and every adapter must create/update their declared native file while user-config write counters remain zero. They are deliberately outside the writer/schema/race equality set.
5. Enforce `contract.discovery` with an AST inventory, not a grep. It resolves ESM/CommonJS imports, destructuring, aliases and re-exports, records every selector location, and fails on an unresolved dynamic write target.

## A→B cross-acceptance

`aToB.steps` contains the ordered A01→A10 dependency graph and bound participant IDs. The eventual integration test obtains its exact ten-adapter set from `AGENTS_META` and `getAdapters`, rather than a fixture list. It must prove that the payload excludes local model cache, B hydrates its own cache before reconciliation, and each native config/auth shape is asserted without reading or printing secret values.

The failed `fbe5143` experiment does not implement this contract and remains excluded from release consideration.
