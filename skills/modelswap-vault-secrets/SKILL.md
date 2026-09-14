---
name: modelswap-vault-secrets
description: ModelSwap 密钥安全规范——创建/轮换/使用 Vault 密钥。发起凭证捕获请求（vault request，密钥不进对话）、通过 vault run 安全使用（不进进程列表）、明文披露红线、分组管理与删除确认。当任务需要创建新密钥、密钥不在库中、轮换已泄露的密钥，或在命令中使用密钥时使用；仅查看密钥列表用 modelswap 核心技能即可。
---

# 密钥安全（Vault secrets）

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

## 在命令中使用密钥

优先通过 `vault run` 执行工具——值只被解密并注入子进程的环境块，不会出现在命令参数、进程列表（ps）或 Agent 记录中：

```bash
modelswap vault run --key <KEY> --env <ENV_VAR> -- <命令...>
```

选择原生从环境变量读取配置的工具（git、aws、terraform，以及一切读 `process.env` 的程序）。不要把 `$ENV_VAR` 展开进另一个命令的参数——shell 展开会把值重新暴露在进程列表里；改用 stdin 或配置文件传递。子进程的输出和退出码会原样传递。

## 降级路径与明文披露

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

以下命令属于明文披露：

- `modelswap vault get <KEY>` 把原始值写到 stdout。
- `modelswap vault inject` 把含原始值的 shell export 写到 stdout。

只在任务明确需要明文结果时使用，且不要复述或总结返回的值。`modelswap vault inject` 需要显式 `--keys` 列表或 `--group`；绝不要凭空捏造 key 名——先确认任务需要哪些 key（`vault search` / `vault groups` 可帮助定位真实存在的）。

## 重命名与删除

重命名使用 `modelswap vault mv <OLD> <NEW>`（保留分组/描述/过期时间）。注意此前通过 `vault get <OLD>` 引用旧 key 名的脚本需要同步更新——重命名不会改写它们。

删除是破坏性操作。执行 `modelswap vault delete <KEY>` 前，与用户确认没有 Provider 或 Agent 配置仍在引用该 key（查看 `modelswap provider list` 输出或控制台）。
