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

**Never accept a plaintext secret from the conversation.** A value pasted into chat has already entered model context — and for cloud models, left the machine. When a task needs a secret that is not yet in the Vault, request it instead of asking for it:

```bash
modelswap vault request <KEY>@<服务分组> \
  --desc "<用途说明与权限范围>" \
  --pattern "^sk-[A-Za-z0-9_-]{20,}$" \
  --url "https://console.example.com/api-keys" \
  --step "打开控制台" --step "创建并命名 Key" --step "复制生成的 Key" \
  --wait --timeout 1800
```

The command registers metadata only — key name, group, description, expected key shape, console URL, and human steps — and arms the browser extension: when the user copies the key on the console page it is captured straight into the Vault, and the value never passes through you. `--wait` blocks until every requested key is captured, then prints masked receipts so the task can continue automatically. On timeout, exit gracefully and verify later with `vault list --json` — the request stays armed for 30 minutes and a late capture still lands.

- Include `--pattern` whenever you know the vendor's key shape (regex, 200 chars max). Include `--url` so copies made on that console take the high-confidence auto path; unknown shapes degrade to a one-click user confirmation instead of failing.
- Multi-field credentials (e.g. `app_id` + `app_secret`) are one Vault key per entity with fields packed as JSON, named `服务-实体名`; never split them into separate keys: `--fields "app_id,app_secret"` (optionally `--field-pattern "app_id=^cli_[a-z0-9]+$"`).
- To replace a rotated or mis-scoped key, re-issue the same request with `--replace`; the new value overwrites the old and agent configs embedding it are re-synced.

Fallback only when the user explicitly hands you the value through an authorized secure channel (environment variable, file) — pass it via standard input, never arguments:

```bash
printf '%s' "$SECRET_VALUE" | modelswap vault set <KEY> --stdin --group <服务分组> --desc "<用途说明>"
```

Prefer the interactive `modelswap vault set <KEY>` prompt over echoing values in shared terminals.

Before choosing a group, check existing ones and reuse — do not invent near-duplicate groups:

```bash
modelswap vault groups          # distinct groups with per-group counts
modelswap vault search <query>  # fuzzy match on key / desc / group (--json supported)
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
