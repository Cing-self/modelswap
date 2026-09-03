# 5. 密钥库日常使用

![密钥管理页](../images/vault.png)

## 5.1 添加与查看

- **手动添加**：密钥管理 → 添加，填名称与 Key，可选填用途说明
- **查看**：密钥默认脱敏展示，需要时可查看完整值；密钥以 AES-256-GCM 加密存储在本机 `~/.modelswap`
- **命令行操作**：

```bash
modelswap vault list                  # 列出所有密钥（脱敏）
modelswap vault set <key>             # 交互式存密钥（推荐）
printf '%s' "$SECRET" | modelswap vault set <key> --stdin   # 自动化场景，避免密钥进入命令历史
modelswap vault get <key>             # 获取明文
modelswap vault delete <key>          # 删除
```

## 5.2 注入到终端

把指定密钥以环境变量形式注入当前终端（配合 `eval` 使用）：

```bash
eval "$(modelswap vault inject --keys OPENAI_API_KEY,OPENROUTER_KEY)"
modelswap vault inject --keys GEMINI_API_KEY --shell zsh   # 指定 shell 格式（bash/zsh/powershell）
```

## 5.3 cd 自动注入（已移除）

`modelswap hook` 命令已在 v1.0.3 移除，当前版本没有 cd 钩子功能。如需进入项目自动注入密钥，用 `modelswap vault inject` 配合你的 shell 工具（direnv 等）自行组合；ModelSwap 本身**永远不会**修改你的 Shell 配置（`~/.zshrc` / `~/.bashrc` 等）。旧版本装过 hook 的清理办法见第 14 章 FAQ。
