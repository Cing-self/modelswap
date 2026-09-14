---
name: modelswap
description: 使用 ModelSwap CLI 检查或管理本地 AI Provider、Agent 模型路由、加密 Vault 密钥（含发起凭证捕获请求、以安全方式使用密钥）与云同步。覆盖 Claude Code、Codex、OpenCode 等 10 个编码 Agent，以及 30+ 主流模型平台的密钥创建/轮换/使用。当用户要求使用 modelswap、配置 AI 编码 Agent、管理其 Provider/模型，或处理 ModelSwap 管理的密钥时使用；不要用于无关的 Provider API。
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
modelswap vault list --json
```

`vault list --json` 输出已脱敏，可安全查看。Provider JSON 只含配置元数据，不含密钥明文。不确定某个选项时运行 `modelswap <命令> --help`；引用 ID 时以 JSON 里的稳定 ID 为准，不要凭显示名称猜测。

## 配置 Agent

进行明确的非交互式变更：

```bash
modelswap provider use <provider-id> --agent <agent-id> --model <model-id>
modelswap provider current --json
```

除非用户明确想用 ModelSwap 的默认值，否则始终同时提供 `--agent` 和 `--model`。省略 `--agent` 会把该 Provider 应用到所有兼容 Agent；省略 `--model` 会选中该 Provider 的第一个模型。`provider switch [agent]` 是交互式的，更适合由人操作的终端。

Provider 变更会尽可能创建切换前快照，并写入所选 Agent 的原生配置文件。先检查，后验证。

## 处理 Vault 密钥

**绝对不要接受对话中的明文密钥。** 粘贴进对话的值已经进入模型上下文——对云端模型而言，它已经离开这台机器。当任务需要的密钥还不在 Vault 中时，发起请求而不是开口索要：

```bash
modelswap vault request <KEY>@<服务分组> \
  --desc "<用途说明与权限范围>" \
  --pattern "^sk-[A-Za-z0-9_-]{20,}$" \
  --url "https://console.example.com/api-keys" \
  --step "打开控制台" --step "创建并命名 Key" --step "复制生成的 Key" \
  --wait --timeout 1800
```

该命令只登记元数据——key 名、分组、描述、预期 key 形状、控制台地址和给用户的操作步骤——并武装浏览器扩展：用户在控制台页面复制 key 的瞬间，值会直接进入 Vault，全程不经过你。`--wait` 会阻塞到所有请求的 key 都被捕获，然后打印掩码回执，任务自动继续。超时则优雅退出，事后用 `vault list --json` 验证——请求会保持待命 30 分钟，迟到的捕获依然落库。

- 知道厂商 key 形状时尽量带上 `--pattern`（正则，最长 200 字符）。带上 `--url`，在该控制台上的复制会走高置信自动路径；未知形状会降级为用户一次点击确认，而不是直接失败。
- 多字段凭证（如 `app_id` + `app_secret`）在 Vault 中一个实体一个 key，字段打包为 JSON，命名为 `服务-实体名`；不要拆成多个 key：`--fields "app_id,app_secret"`（可选 `--field-pattern "app_id=^cli_[a-z0-9]+$"`）。
- 替换已泄露或权限配错的 key：用同样参数重发请求并加 `--replace`；新值覆盖旧值，引用它的 Agent 配置会自动重新同步。

仅当用户通过授权的安全渠道（环境变量、文件）明确把值交给你时才走降级路径——通过标准输入传递，绝不放进参数：

```bash
printf '%s' "$SECRET_VALUE" | modelswap vault set <KEY> --stdin --group <服务分组> --desc "<用途说明>"
```

在共享终端里，优先让用户运行交互式 `modelswap vault set <KEY>` 提示，而不是回显值。

选择分组前先查既有分组并复用——不要发明近似重复的分组：

```bash
modelswap vault groups          # 去重后的分组及各自数量
modelswap vault search <query>  # 按 key 名/描述/分组模糊搜索（支持 --json）
```

在命令中使用密钥时，优先通过 `vault run` 执行工具——值只被解密并注入子进程的环境块，不会出现在命令参数、进程列表（ps）或 Agent 记录中：

```bash
modelswap vault run --key <KEY> --env <ENV_VAR> -- <命令...>
```

选择原生从环境变量读取配置的工具（git、aws、terraform，以及一切读 `process.env` 的程序）。不要把 `$ENV_VAR` 展开进另一个命令的参数——shell 展开会把值重新暴露在进程列表里；改用 stdin 或配置文件传递。子进程的输出和退出码会原样传递。

以下命令属于明文披露：

- `modelswap vault get <KEY>` 把原始值写到 stdout。
- `modelswap vault inject` 把含原始值的 shell export 写到 stdout。

只在任务明确需要明文结果时使用，且不要复述或总结返回的值。`modelswap vault inject` 需要显式 `--keys` 列表或 `--group`；绝不要凭空捏造 key 名——先确认任务需要哪些 key（`vault search` / `vault groups` 可帮助定位真实存在的）。

重命名使用 `modelswap vault mv <OLD> <NEW>`（保留分组/描述/过期时间）。注意此前通过 `vault get <OLD>` 引用旧 key 名的脚本需要同步更新——重命名不会改写它们。

删除是破坏性操作。执行 `modelswap vault delete <KEY>` 前，与用户确认没有 Provider 或 Agent 配置仍在引用该 key（查看 `modelswap provider list` 输出或控制台）。

## 云同步

`modelswap vault push`、`pull`、`test` 会接触已配置的外部存储。`push` 改变远端状态；`pull` 把远端 key 合并进本地 Vault。仅凭一句「看一下同步状态」不要执行它们。

## Web UI 与 Skill 安装

用 `modelswap web` 启动本地控制台（端口 3780）。仅在用户要求打开浏览器时加 `--open`。如果 3780 被其他进程占用，ModelSwap 会顺延选择下一个可用端口。

内置 Skill 可通过 `modelswap skill path` 定位。仅在用户要求时装入项目：

```bash
modelswap skill install /path/to/project
```

这会在目标项目写入 `.agents/skills/modelswap/SKILL.md`。除非明确要替换已有副本，否则不要用 `--force`。

## 验证结果

以命令退出状态为准，配合最窄的只读复核（`provider current --json`、`provider auth --json` 或 `vault list --json`）。当失败依赖凭证、外部服务或用户自有配置时，重试一次仍不成功即停止：报告错误，不暴露密钥。
