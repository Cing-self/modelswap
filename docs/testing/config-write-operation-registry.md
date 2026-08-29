# Configuration mutation registry (v4)

Status: **final design gate / implementation paused**. The only normative registry is the machine-readable [config-mutation-registry.json](./config-mutation-registry.json). This file intentionally does not duplicate registry rows, schemas or race IDs.

## How the future implementation consumes it

1. Load `entries` and select `kind: "writer"`; compare the discovered AST writer IDs, registry IDs, `schemaId`s and `raceId`s as equal sets.
2. Compile each `schemaRules[id]` as JSON Schema. Invalid input must be rejected before a counted `fs.read*` or `fs.write*`; the pre/post `user.json` bytes must match.
3. Generate one real temporary-HOME+USERPROFILE race participant per `raceId`; the test fails if an entry has no independent participant.
4. Treat `kind: "native-only-no-write"` separately: its test asserts that reconciliation creates/updates the declared native files while user-config write counters remain zero. It is deliberately outside the writer/schema/race equality set.
5. Enforce `contract.discovery` with an AST inventory, not a grep. It resolves ESM/CommonJS imports, destructuring and aliases, records every mutation entrypoint, and fails on an unresolved dynamic write target.

## A→B cross-acceptance

`aToB.A01` through `A10` are executable acceptance IDs, not narrative examples. The eventual integration test consumes all ten and dynamically derives the registered ten adapters. It must prove that the payload excludes local model cache, B hydrates its own cache before reconciliation, and each native config/auth shape is asserted without reading or printing secret values.

The failed `fbe5143` experiment does not implement this contract and remains excluded from release consideration.
