---
name: modelswap-vault-secrets
description: ModelSwap 密钥技能——凡涉及密钥/凭证/API key/token/secret 的任务一律使用本技能：查看与搜索、创建与凭证捕获（vault request，密钥不进对话）、通过 vault run 安全使用（不进进程列表）、多字段凭证、轮换（--replace）、重命名与分组、删除确认、明文披露红线。只要任务中出现任何密钥相关操作就应用本技能，先读规范再动手。典型触发说法：「把 XX 密钥的值给我/打印出来」「导出这个 key」——这类明文披露请求同样必须先读本技能再行动。
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

## 发起捕获请求的三条纪律

### 纪律一：`--step` 步骤先实测，后生成

`--step` 里的控制台导航路径描述的是易变的产品 UI，**永远不要凭训练记忆或搜索猜测编写**——记忆里的门户版本几乎必然过期。生成步骤前，先用浏览器控制实地走一遍（优先驱动用户的浏览器——扩展就在那个浏览器里，自带控制台登录态）：

1. 打开 `--url` 指向的控制台；遇到登录墙就停下来请用户登录（「我需要看一眼控制台导航，请先登录」），**等待**，登录后继续——用户只在这一步出现；
2. 自己走到密钥所在页面，边走边记录真实路径，照所见写 `--step`；
3. 实测结果按控制台域名记入你的持久笔记（附验证日期），下次同控制台直接复用，不重复走查。

走查红线：只导航和读取，**绝不点击** Regenerate / Delete / Save 等任何有副作用的按钮——走查确认的是路径，密钥值仍然只经扩展捕获，全程不需要你看到值。浏览器控制不可用时才降级为请用户提供截图或口述路径——这是兜底，不是首选。有把握时优先写**值锚点**（前缀、位数、所在区块名）而非菜单路径：值形状由 `--pattern`/`--field-pattern` 机器校验，路径写错最多重发一次请求，形状写错会静默失败。

### 纪律二：发请求前，先向用户预告交互

命令参数决定用户在扩展里看到的交互形态，发请求前必须预告：

| 请求形态 | 用户在扩展里看到的交互 |
|---|---|
| 单 key + `--pattern` | 该控制台上复制自动捕获（域名+形状双中免确认）；无 pattern 降级为一次点击确认 |
| 多 key 一条请求 | 公共步骤区和「打开控制台」按钮各显示一次；每 key 一张卡片（只有名称和粘贴输入框），把值贴进对应卡片；复制捕获走一次点击确认，无形状校验 |
| `--fields` 多字段 | 一个多行输入框**整块粘贴** `字段名: 值`（每行一条，不是每字段一个框），字段清单逐项显示 待复制/已捕获 |

### 纪律三：多 key 请求先选型，拿不准问用户

- 同一页面收多个**相互独立**的 key → 默认 N 条单 key 请求、各带 `--pattern`（当前 CLI 限制 pattern 仅单 key 请求）；
- 真正单实体、永远成对使用的凭证（如 `app_id`+`app_secret`）→ `--fields`，并预告「单框多行整块粘贴」；
- 多把 key **操作步骤完全相同**、或用户明确要一条请求 → 多 key 合并：`--step` 写一遍、全部 key 共用（扩展显示一次公共步骤区和打开控制台按钮），预告「每 key 一张卡片手动归位、无形状校验」；
- 各 key 需要**不同**操作步骤时只能拆多条请求——CLI 没有 per-key 步骤，合并请求里步骤拆不开；
- 拆条与合并都可行时，**先问用户偏好再发**（已知偏好案例：一条请求 > 形状校验）。

## 查看与搜索（已脱敏，安全）

日常的查看、检索、分组确认都在这里完成，输出不包含明文：

```bash
modelswap vault list --json          # 全部密钥（脱敏）
modelswap vault list --json --group "火山引擎"   # 按分组过滤
modelswap vault search <query>       # 按 key 名/描述/分组模糊搜索（支持 --json）
modelswap vault groups               # 去重后的分组及各自数量
```

任务开始前先搜库——用户要的密钥往往已经存在；选择分组时先查既有分组并复用，不要发明近似重复的分组。

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

在共享终端里，优先让用户运行交互式 `modelswap vault set <KEY>` 提示，而不是回显值。分组选择沿用「查看与搜索」一节的规则：先查既有分组并复用。

## 目标系统需要明文时（如 Agent 配置文件）

边界原则：**明文可以进入用户机器上的目标系统，不能进入对话、记录或命令行参数。** 分两类场景：

**1. ModelSwap 管理的 Agent（Claude Code、Codex、OpenCode 等）**

不要手工把 key 写进它们的配置文件（如 `~/.claude/settings.json`）——这由 `modelswap provider use` 的适配器负责写入与后续同步（key 轮换后引用会被自动 reconcile）。手工写入会与路由系统漂移，且写入过程容易把明文带进命令行。正确路径见 `modelswap-agent-routing` 技能。

**2. 非 ModelSwap 管理的目标（任意需要明文的配置文件）**

用 `vault run` 把值经环境变量交给一个写文件的子进程，明文不出现在命令行，也不回到对话：

```bash
modelswap vault run --key <KEY> --env V -- node -e '
  require("fs").writeFileSync("/path/to/app.env",
    `API_KEY=${process.env.V}\n`);
'
```

要点：写文件的子进程从 `process.env` 取值（不要用 `sh -c 'echo $V > file'`——展开后值会出现在 echo 的参数里）；文件属主可见明文是目标系统的要求，符合边界。

**3. 临时 shell 会话需要**

`modelswap vault inject --keys <KEY>` 输出 shell export 语句，可管道给脚本执行：

```bash
modelswap vault inject --keys <KEY> | bash -c 'read -r line; ...'
```

输出含明文——不要在对话中展示、重定向到日志或复述其内容；仅在任务确实需要时使用。

以下命令属于明文披露：

- `modelswap vault get <KEY>` 把原始值写到 stdout。
- `modelswap vault inject` 把含原始值的 shell export 写到 stdout。

只在任务明确需要明文结果时使用，且不要复述或总结返回的值。`modelswap vault inject` 需要显式 `--keys` 列表或 `--group`；绝不要凭空捏造 key 名——先确认任务需要哪些 key（`vault search` / `vault groups` 可帮助定位真实存在的）。

## 重命名与删除

重命名使用 `modelswap vault mv <OLD> <NEW>`（保留分组/描述/过期时间）。注意此前通过 `vault get <OLD>` 引用旧 key 名的脚本需要同步更新——重命名不会改写它们。

删除是破坏性操作。执行 `modelswap vault delete <KEY>` 前，与用户确认没有 Provider 或 Agent 配置仍在引用该 key（查看 `modelswap provider list` 输出或控制台）。
