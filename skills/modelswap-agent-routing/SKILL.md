---
name: modelswap-agent-routing
description: 配置 AI 编码 Agent 的 Provider 与模型路由——为 Claude Code、Codex、OpenCode、WorkBuddy 等 10 个 Agent 查询、切换或指定 Provider 与模型。当用户要求为某个 Agent 换模型、换 Provider、设置默认路由，或排查 Agent 没用上某模型时使用；仅查看配置用 modelswap 核心技能即可。
---

# Agent 模型路由

核心动作只有一条命令，但**先查、再改、后验证**的流程不可省略：

```bash
# 1) 查现状（谁在用什么）
modelswap provider current --json
# 2) 变更
modelswap provider use <provider-id> --agent <agent-id> --model <model-id>
# 3) 验证
modelswap provider current --json
```

## 查看命令与 JSON 结构

- `provider current --json` —— 每个 Agent 一条：`agentId` / `agentName` / `configured` / `providerId` / `providerName` / `modelId`。这是「某 Agent 现在用什么」的唯一可信来源。
- `provider auth --json` —— 每个 Provider 的认证状态：`hasApiKey`（Vault 中是否绑定 key）、`oauthLoggedIn`（OAuth 类登录态，如 ChatGPT/Claude 订阅）。
- `provider list --json` —— 全部 Provider：`id` / `name` / `type`（协议）/ `baseUrl` / `auth.hasApiKey` / `models[]`（含每个模型的 id 与元数据）。选模型前先在这里确认 `modelId` 真实存在。

引用 Provider 和模型时**始终用 JSON 里的稳定 id**（如 `xiaomi-coding` / `mimo-v2.5-pro`），不要凭显示名猜测或翻译。

## provider use 的行为细节

- Provider 参数按 **id 或 name 匹配**（`id` 优先，两者都区分大小写）。
- 除非用户明确要默认值，**始终同时给出 `--agent` 和 `--model`**：
  - 省略 `--model` → 使用该 Provider 的**第一个模型**（不一定是用户想要的）；
  - 省略 `--agent` → 应用到**所有兼容该 Provider 的 Agent**（波及面大，仅在用户明确说「全部」时使用）。
- 变更会尽可能创建切换前快照，然后写入所选 Agent 的**原生配置文件**：
  - Claude Code → `~/.claude`（settings）
  - Codex → `~/.codex`（config.toml 及 model-catalogs）
  - OpenCode → `~/.config/opencode/opencode.json`（注意不是 `~/.opencode/config.json`）
  - 其余 Agent 同理写入各自原生配置
- `provider switch [agent]` 是交互式向导，适合用户自己操作；agent 自动化一律用 `use`。

## 支持的 Agent

`--agent` 参数使用下表的 agentId（不是显示名）。**运行时以 `modelswap provider current --json` 的输出为准**——它就是当前的 Agent 清单（每条含 `agentId` / `agentName` / `configured`，`configured: false` 表示已识别但未配置）。新装了某个 Agent 后，出现该输出里即说明 ModelSwap 已能管理它。

| agentId | 显示名 |
|---|---|
| `claude` | Claude Code |
| `codex` | ChatGPT (Codex) |
| `opencode` | OpenCode |
| `workbuddy` | WorkBuddy |
| `zcode` | ZCode |
| `grok` | Grok Build |
| `openclaw` | OpenClaw |
| `kimi-code` | Kimi Code |
| `mimo-code` | MiMo Code |
| `hermes` | Hermes |

## 与密钥的关系

Provider 的 API key 存在 Vault 中（`auth.hasApiKey` 反映绑定状态）。切换 Provider 只是改路由，**不会自动创建或迁移 key**——目标 Provider 没绑定 key 时，先按 `modelswap-vault-secrets` 技能发起捕获请求，拿到 key 后再切换。OAuth 类（ChatGPT / Claude 订阅）看 `oauthLoggedIn`，走登录而不是 key。

## 添加与删除 Provider

- `modelswap provider add` —— 交互式，内置预设（OpenAI、Anthropic、智谱、火山方舟等 22+ 平台）或自定义（type/baseUrl/key）。适合让用户自己跑；agent 需要非交互添加时优先用预设。
- `modelswap provider delete <name>` —— 删除前确认没有 Agent 仍在路由到它（`provider current --json`）。

## 常见任务配方

- **只换模型（同 Provider）**：`provider use <当前provider-id> --agent <agent> --model <新model-id>`
- **整体换 Provider**：`provider use <新provider-id> --agent <agent>`（用默认模型）或带 `--model`
- **新装了个 Agent 想接入**：`provider current --json` 看它是否已被识别（`configured: false` 表示未配置）→ `provider use` 指定它
- **改了没生效**：先 `provider current --json` 确认路由已变更；若路由对但行为不对，检查目标 Agent 是否需要重启/重载配置，以及 `provider auth --json` 里该 Provider 的认证状态
