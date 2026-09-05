---
name: modelswap
description: Use the ModelSwap CLI to inspect or manage local AI providers, Agent model routing, encrypted Vault keys, project environment injection, and cloud sync. Apply when a user asks to use `modelswap`, configure an AI coding Agent, manage its provider/model, or work with ModelSwap-managed secrets; do not use for unrelated provider APIs.
---

# ModelSwap CLI

Use ModelSwap as the local control plane for AI coding Agent credentials and model routing. Preserve the user's authorization boundary: inspecting configuration does not authorize changing Agent files, revealing secrets, or syncing data externally.

## Discover and inspect

Prefer machine-readable output for decisions:

```bash
modelswap provider current --json
modelswap provider list --json
modelswap provider auth --json
modelswap vault list --json
```

`vault list --json` is masked and safe to inspect. Provider JSON contains configuration metadata, not secret values. Run `modelswap <command> --help` when an option is uncertain, and use stable IDs from JSON rather than guessing from display names.

## Configure an Agent

For an explicit, non-interactive change:

```bash
modelswap provider use <provider-id> --agent <agent-id> --model <model-id>
modelswap provider current --json
```

Always provide both `--agent` and `--model` unless the user explicitly wants ModelSwap's defaults. Omitting `--agent` applies the provider to every compatible Agent; omitting `--model` selects the provider's first model. `provider switch [agent]` is interactive and better suited to a human-operated terminal.

Provider changes create a pre-switch snapshot when possible and write the selected Agent's native configuration files. Inspect first and verify afterward.

## Handle Vault secrets

Never place a secret in command arguments, logs, commentary, or the final response. For a value the user has explicitly authorized storing, pass it through standard input — always with a group and a description (group = service category, description = what the credential is for and its permission scope):

```bash
printf '%s' "$SECRET_VALUE" | modelswap vault set <KEY> --stdin --group <服务分组> --desc "<用途说明>"
```

Prefer letting the human run the interactive `modelswap vault set <KEY>` prompt when the secret is not already available through an authorized secure channel.

Before choosing a group, check existing ones and reuse — do not invent near-duplicate groups:

```bash
modelswap vault groups          # distinct groups with per-group counts
modelswap vault search <query>  # fuzzy match on key / desc / group (--json supported)
```

Multi-field credentials (e.g. `app_id` + `app_secret` pairs) are one key per entity with the fields packed as JSON in the value, named `服务-实体名`; do not split them into separate keys:

```bash
printf '%s' '{"app_id":"cli_xxx","app_secret":"xxx"}' | modelswap vault set feishu-app1 --stdin --group "飞书开放平台" --desc "自建应用1（多维表格 API）"
```

Treat these commands as plaintext disclosure:

- `modelswap vault get <KEY>` writes the raw value to stdout.
- `modelswap vault inject` writes shell exports containing raw values.

Use either only when the task explicitly requires the plaintext result, and do not echo or summarize the value. `modelswap vault inject` requires an explicit `--keys` list or a `--group`; never invent key names — confirm which keys the task needs first (`vault search` / `vault groups` help resolve real ones).

Renaming uses `modelswap vault mv <OLD> <NEW>` (metadata preserved). Note scripts that reference the old key name by `vault get <OLD>` must be updated — renaming does not rewrite them.

Deletion is destructive. Before `modelswap vault delete <KEY>`, confirm with the user that no provider or agent configuration still binds that key (check `modelswap provider list` output or the dashboard).

## Cloud sync

`modelswap vault push`, `pull`, and `test` contact configured external storage. `push` changes remote state; `pull` merges remote keys into the local Vault. Do not run them based only on a request to inspect sync status.

## Web UI and Skill installation

Use `modelswap web` for the local dashboard on port 3780. Add `--open` only when the user asks to open a browser. If 3780 belongs to another process, ModelSwap may select the next available port.

The bundled Skill can be located with `modelswap skill path`. Install it into a project only when requested:

```bash
modelswap skill install /path/to/project
```

This writes `.agents/skills/modelswap/SKILL.md` in the target project. Do not use `--force` unless replacing an existing copy is explicitly intended.

## Verify outcomes

Use command exit status plus the narrowest read-only follow-up (`provider current --json`, `provider auth --json`, or `vault list --json`). Stop after one failed retry when the failure depends on credentials, external services, or user-owned configuration; report the error without exposing secrets.
