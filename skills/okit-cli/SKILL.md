---
name: okit-cli
description: Use the OKIT CLI to inspect or manage local AI providers, Agent model routing, encrypted Vault keys, project environment injection, shell hooks, and cloud sync. Apply when a user asks to use `okit`, configure an AI coding Agent, manage its provider/model, or work with OKIT-managed secrets; do not use for unrelated provider APIs.
---

# OKIT CLI

Use OKIT as the local control plane for AI coding Agent credentials and model routing. Preserve the user's authorization boundary: inspecting configuration does not authorize changing Agent files, revealing secrets, installing shell hooks, or syncing data externally.

## Discover and inspect

Prefer machine-readable output for decisions:

```bash
okit provider current --json
okit provider list --json
okit provider auth --json
okit vault list --json
okit hook status
```

`vault list --json` is masked and safe to inspect. Provider JSON contains configuration metadata, not secret values. Run `okit <command> --help` when an option is uncertain, and use stable IDs from JSON rather than guessing from display names.

## Configure an Agent

For an explicit, non-interactive change:

```bash
okit provider use <provider-id> --agent <agent-id> --model <model-id>
okit provider current --json
```

Always provide both `--agent` and `--model` unless the user explicitly wants OKIT's defaults. Omitting `--agent` applies the provider to every compatible Agent; omitting `--model` selects the provider's first model. `provider switch [agent]` is interactive and better suited to a human-operated terminal.

Provider changes create a pre-switch snapshot when possible and write the selected Agent's native configuration files. Inspect first and verify afterward.

## Handle Vault secrets

Never place a secret in command arguments, logs, commentary, or the final response. For a value the user has explicitly authorized storing, pass it through standard input:

```bash
printf '%s' "$SECRET_VALUE" | okit vault set <KEY> --stdin
```

Prefer letting the human run the interactive `okit vault set <KEY>` prompt when the secret is not already available through an authorized secure channel.

Treat these commands as plaintext disclosure:

- `okit vault get <KEY>` writes the raw value to stdout.
- `okit vault inject` writes shell exports containing raw values.

Use either only when the task explicitly requires the plaintext result, and do not echo or summarize the value. `.okitenv` maps project variable names to Vault keys. `okit vault env [file] --dir <path>` writes or replaces the destination environment file and registers bindings; inspect the target and obtain write authority first. `okit vault sync` updates all registered project files.

Deletion is destructive. Inspect `okit vault where <KEY>` before `okit vault delete <KEY>` so affected projects are known.

## Shell hooks and cloud sync

`okit hook install` edits the user's shell profile and `hook uninstall` removes the managed block. Run either only when explicitly requested.

`okit vault push`, `pull`, and `test` contact configured external storage. `push` changes remote state; `pull` merges remote keys into the local Vault. Do not run them based only on a request to inspect sync status.

## Web UI and Skill installation

Use `okit web` for the local dashboard on port 3780. Add `--open` only when the user asks to open a browser. If 3780 belongs to another process, OKIT may select the next available port.

The bundled Skill can be located with `okit skill path`. Install it into a project only when requested:

```bash
okit skill install /path/to/project
```

This writes `.agents/skills/okit-cli/SKILL.md` in the target project. Do not use `--force` unless replacing an existing copy is explicitly intended.

## Verify outcomes

Use command exit status plus the narrowest read-only follow-up (`provider current --json`, `provider auth --json`, `vault list --json`, `vault where`, or `hook status`). Stop after one failed retry when the failure depends on credentials, external services, or user-owned configuration; report the error without exposing secrets.
