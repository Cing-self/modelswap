# 10. Driving ModelSwap from an AI Agent (Skill)

ModelSwap ships a plain-markdown **agent skill** that teaches AI coding agents (Claude Code, Codex, OpenCode, …) to drive the CLI: inspect state with machine-readable output, switch models non-interactively, and follow the security boundaries around secrets.

## 10.1 Locate & install

```bash
modelswap skill path                      # print the built-in skill file location
modelswap skill install /path/to/project  # writes .agents/skills/modelswap/SKILL.md
```

Or fetch it straight from the public repo:

```bash
npx skills add Cing-self/modelswap --skill modelswap
```

## 10.2 What it enables

- **Inspect**: `modelswap provider current --json`, `provider list --json`, `provider auth --json`, `vault list --json` — masked and safe to read
- **Switch without prompting**: `modelswap provider use <provider> --agent <agent> --model <model>` — the skill tells the agent to always pass explicit agent + model ids instead of relying on defaults
- **Know the boundaries**: secrets never appear in command arguments or logs (`--stdin` instead); `vault get` / `vault inject` are treated as plaintext disclosure and used only when the task truly needs them; `vault push` / `pull` only on explicit request; `vault delete` only after inspecting `vault where` first

Raw commands are in chapter 14. The skill is written for agents — humans can just use the web console or the CLI directly.
