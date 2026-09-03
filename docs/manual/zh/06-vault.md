# 6. 密钥库日常使用

![密钥管理页](../images/vault.png)

- **手动添加**：密钥管理 → 添加，填名称与 Key，可选填用途说明
- **查看**：密钥默认脱敏展示，需要时可查看完整值；密钥以 AES-256-GCM 加密存储在本机 `~/.modelswap`
- **命令行操作**：

```bash
modelswap vault list                  # 列出所有密钥（脱敏）
modelswap vault set <key>             # 交互式存密钥（推荐）
printf '%s' "$SECRET" | modelswap vault set <key> --stdin   # 自动化场景，避免密钥进入命令历史
modelswap vault get <key>             # 获取明文
modelswap vault delete <key>          # 删除
modelswap vault inject [--shell zsh]  # 输出 export 语句（配合 eval 使用）
```
