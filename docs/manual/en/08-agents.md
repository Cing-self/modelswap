# 8. Agent Config & Model Switching

![Agents page](../images/agents.png)

OKIT adapts 10 agents: **Claude Code, ChatGPT (Codex), Kimi Code, WorkBuddy, Hermes, OpenCode, OpenClaw, ZCode, Grok, MiMo Code**.

## 8.1 Switch models (web)

1. Pick the agent at the top of the **Quick Start** page
2. Toggle on the provider you want
3. Click a model chip — done

OKIT writes the config files (`config.toml`, `auth.json`, `settings.json`, …) correctly; no manual editing needed.

> OKIT performs **surgical writes**: it only touches the fields it owns — your own hooks, statusLine, MCP settings are preserved as-is. Every switch takes a config snapshot first (see chapter 11) that you can restore at any time.

## 8.2 Switch models (CLI)

```bash
okit provider switch            # interactive switch (agent optional)
okit provider use <provider> --agent codex --model <model-id>   # non-interactive, script/CI friendly
okit provider current           # current config of all agents
```

## 8.3 Notes

- **Codex users**: after switching, OKIT generates the native model catalog — you can switch models inside Codex CLI via `/model` without coming back to OKIT
- **Config viewer**: the Agents page shows (and lets you edit) exactly what OKIT wrote for each agent
- **Disabling a provider**: toggling it off restores that agent's official defaults; nothing is deleted
