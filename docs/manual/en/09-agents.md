# 9. Agent Config & Model Switching

![Agents page](../images/agents.png)

ModelSwap adapts 10 agents: **Claude Code, ChatGPT (Codex), Kimi Code, WorkBuddy, Hermes, OpenCode, OpenClaw, ZCode, Grok, MiMo Code**.

## 9.1 Switch models (web)

1. Pick the agent at the top of the **Quick Start** page
2. Toggle on the provider you want
3. Click a model chip — done

ModelSwap writes the config files (`config.toml`, `auth.json`, `settings.json`, …) correctly; no manual editing needed.

> ModelSwap performs **surgical writes**: it only touches the fields it owns — your own hooks, statusLine, MCP settings are preserved as-is. Every switch takes a config snapshot first (see chapter 12) that you can restore at any time.

## 9.2 Switch models (CLI)

```bash
modelswap provider switch            # interactive switch (agent optional)
modelswap provider use <provider> --agent codex --model <model-id>   # non-interactive, script/CI friendly
modelswap provider current           # current config of all agents
```

## 9.3 Notes

- **Codex users**: after switching, ModelSwap generates the native model catalog — you can switch models inside Codex CLI via `/model` without coming back to ModelSwap
- **Config viewer**: the Agents page shows (and lets you edit) exactly what ModelSwap wrote for each agent
- **Disabling a provider**: toggling it off restores that agent's official defaults; nothing is deleted
