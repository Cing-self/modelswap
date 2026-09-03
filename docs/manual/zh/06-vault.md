# 6. 密钥库日常使用

![密钥管理页](../images/vault.png)

## 6.1 添加与查看

- **手动添加**：密钥管理 → 添加，填名称（建议环境变量风格，如 `CF_API_TOKEN`）、分组（可选新建）、用途描述与密钥值
- **自动创建**：添加弹窗切到「自动创建」标签，由浏览器扩展代填官方表单（见第 5 章）
- **查看**：密钥按分组展示，可搜索、按组折叠；默认脱敏（前 3 位 *** 后 3 位），AES-256-GCM 加密存储在本机 `~/.modelswap`
- **复制明文**：行内复制图标把完整值写入剪贴板
- **编辑 / 删除**：行尾 **⋯** 菜单；删除需确认且不可撤销

## 6.2 导入 / 导出

工具栏 **⋯** 菜单：导出生成 JSON 文件（**含全部明文**，注意妥善保管）；导入按条去重，完成后报告新增/跳过数量。

## 6.3 命令行操作

```bash
modelswap vault list                  # 列出所有密钥（脱敏）
modelswap vault set <key>             # 交互式存密钥（推荐）
printf '%s' "$SECRET" | modelswap vault set <key> --stdin   # 自动化场景，避免密钥进入命令历史
modelswap vault get <key>             # 获取明文
modelswap vault delete <key>          # 删除
modelswap vault inject [--shell zsh]  # 输出 export 语句（配合 eval 使用）
```
