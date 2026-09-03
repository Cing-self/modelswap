# 3. 十分钟上手

从零安装到完成第一次模型切换，十分钟搞定。

## 3.1 安装并启动

**桌面版（推荐）：** 从 [GitHub Release](https://github.com/Cing-self/modelswap/releases/latest) 下载 dmg，拖入「应用程序」并打开——控制台窗口会自动出现。首次打开如被 macOS 拦截，按[第 2 章](02-install)的步骤放行一次。

**CLI：**

```bash
npm install -g modelswap
modelswap web          # 打开 http://localhost:3780
```

更多安装方式（源码构建等）见[第 2 章](02-install)。

## 3.2 存入一个密钥

- **手动**：**密钥管理 → 添加**——起个名字（如 `anthropic-api`）、粘贴 Key、保存
- **自动**：**密钥管理 → 自动创建**——浏览器扩展会替你填官方控制台的表单并把 Key 回填到密钥库（第 5 章）
- **命令行**：`modelswap vault set anthropic-api`（交互式；`--stdin` 可避免密钥进入 shell 历史）

## 3.3 注册并连通一个平台

1. **模型管控**页 → 点击平台卡片（如 Anthropic）
2. **密钥**选择刚才存入的密钥库条目
3. 点击**连接**——ModelSwap 验证端点并拉取该平台的模型列表

## 3.4 把 Agent 切换过去

1. **快速启动**页 → 顶部选择 Agent（如 Claude Code）
2. 打开该 Provider 的启用开关
3. 点击模型 chip 即完成。配置文件（`config.toml`、`auth.json` 等）由 ModelSwap 自动写对

命令行等价操作：

```bash
modelswap provider use <provider> --agent <agent-id> --model <model-id>
```

Agent / 模型 ID 可从 `modelswap provider current --json` 获取（完整流程见第 9 章）。

## 3.5 验证

```bash
modelswap provider auth --json    # 各平台认证状态
modelswap provider current        # 各 Agent 当前解析到哪个模型
```

然后找 Agent 问个小问题。如果它还在用旧模型，说明正在运行的 CLI 会话缓存了旧配置——重启该 Agent（见 [常见问题](15-faq)）。

到这里你已经跑通了核心流程。接下来可以按需深入：

- **密钥管理**：批量创建密钥（[第 4–5 章](04-extension)）
- **用量监控**：订阅余额查询与告警（[第 8 章](08-usage)）
- **多设备同步**：iCloud / WebDAV / Cloudflare 等端到端加密同步（[第 11 章](11-sync)）
- **更多 Agent**：查看全部支持的 Agent 与切换方式（[第 9 章](09-agents)）
