---
name: modelswap-agent-routing
description: 配置 AI 编码 Agent 的 Provider 与模型路由——为 Claude Code、Codex、OpenCode、WorkBuddy 等 10 个 Agent 切换或指定 Provider 与模型。当用户要求为某个 Agent 换模型、换 Provider 或设置默认路由时使用；仅查看配置用 modelswap 核心技能即可。
---

# Agent 模型路由

进行明确的非交互式变更：

```bash
modelswap provider use <provider-id> --agent <agent-id> --model <model-id>
modelswap provider current --json
```

除非用户明确想用 ModelSwap 的默认值，否则始终同时提供 `--agent` 和 `--model`。省略 `--agent` 会把该 Provider 应用到所有兼容 Agent；省略 `--model` 会选中该 Provider 的第一个模型。`provider switch [agent]` 是交互式的，更适合由人操作的终端。

Provider 变更会尽可能创建切换前快照，并写入所选 Agent 的原生配置文件。先检查，后验证（`provider current --json` / `provider auth --json`）。

支持的 Agent：Claude Code、Codex、OpenCode、WorkBuddy、ZCode、Grok、OpenClaw、Kimi Code、MiMo Code、Hermes。
