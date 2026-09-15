---
name: modelswap
description: 使用 ModelSwap CLI 检查或管理本地 AI Provider、Agent 模型路由、加密 Vault 密钥与云同步。覆盖 Claude Code、Codex、OpenCode 等 10 个编码 Agent，以及 30+ 主流模型平台的密钥创建/轮换/使用。当用户要求使用 modelswap、配置 AI 编码 Agent、管理其 Provider/模型，或处理 ModelSwap 管理的密钥时使用；不要用于无关的 Provider API。
---

# ModelSwap CLI

把 ModelSwap 当作本地控制面，管理 AI 编码 Agent 的凭证与模型路由。始终守住用户的授权边界：查看配置不等于被授权修改 Agent 文件、泄露密钥或把数据同步到外部。

## 可管理的范围

- **Agent 模型路由**（10 个）：Claude Code、Codex、OpenCode、WorkBuddy、ZCode、Grok、OpenClaw、Kimi Code、MiMo Code、Hermes
- **密钥自动创建/轮换**（30+ 平台变体）：
  - 国际：OpenAI、Anthropic、xAI（Grok）、Mistral、OpenRouter、MiniMax（国际站）、Z.AI（国际站）、OpenCode Go
  - 国内：智谱 AI、DeepSeek、Moonshot、Kimi、阿里云百炼、硅基流动、百度千帆、火山方舟、腾讯云、小米 MiMo、阶跃星辰
  - 各平台的 Coding Plan / Token Plan 变体同样支持
- **Vault 密钥**：任意服务的凭证存取、捕获请求、安全注入、轮换与分组管理

清单随版本增长，以 `modelswap provider list --json` 与 Web 控制台的实际输出为准。

## 查看与检查

做决策时优先使用机器可读输出：

```bash
modelswap provider current --json
modelswap provider list --json
modelswap provider auth --json
modelswap provider search <模型名或平台名> [--exact] [--json]
modelswap vault list --json
```

`vault list --json` 输出已脱敏，可安全查看。Provider JSON 只含配置元数据，不含密钥明文。`provider search` 回答「某模型在哪些平台可用」：默认模糊匹配（精确 > 系列变体 > 子串，每条带 match 标识与认证状态），`--exact` 只返回 id 完全一致的命中。不确定某个选项时运行 `modelswap <命令> --help`；引用 ID 时以 JSON 里的稳定 ID 为准，不要凭显示名称猜测。

## 相关技能（按需加载）

本技能是入口与概览，随 ModelSwap CLI 分发。涉及以下任务时，读取对应子技能再行动：

| 任务 | 子技能 |
|---|---|
| 任何涉及密钥的操作（查看/搜索/创建/捕获/使用/轮换/重命名/删除） | `modelswap-vault-secrets`（密钥技能，必读） |
| 为 Agent 配置 Provider 与模型路由 | `modelswap-agent-routing` |
| Vault 云同步（push/pull/test） | `modelswap-sync` |

## 安装到其他 Agent

拿到本技能（`skills/<名字>/SKILL.md`）后，装进 Agent 的技能目录即可被识别：

1. **交互安装（推荐，已装 ModelSwap CLI 时）**：运行 `modelswap skill add`，选择目标 Agent（自动检测 Claude Code / Codex / OpenCode / 共享 `~/.agents/skills`）与要装的技能，一键落盘。
2. **非交互直装**：`modelswap skill add --agent claude --all`，或精确组合 `--agent codex --skill modelswap-sync --force`（覆盖已存在副本）。
3. **没有 ModelSwap CLI**：`npx skills add Cing-self/modelswap`（仓库遵循社区 skills 目录约定），或手动把 `skills/<名字>/` 整个目录拷贝到目标 Agent 的技能目录（如 `~/.claude/skills/`、`~/.agents/skills/`）。

更新：CLI 升级后重跑 `modelswap skill add --force`（或先删旧目录再装）即可同步全部副本。

## Web 控制台

`modelswap web` 启动本地控制台（端口 3780）。仅在用户要求打开浏览器时加 `--open`。如果 3780 被其他进程占用，ModelSwap 会顺延选择下一个可用端口。

## 验证结果

以命令退出状态为准，配合最窄的只读复核（`provider current --json`、`provider auth --json` 或 `vault list --json`）。当失败依赖凭证、外部服务或用户自有配置时，重试一次仍不成功即停止：报告错误，不暴露密钥。
