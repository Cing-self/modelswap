# 7. 模型平台（Provider）配置

![模型管控页](../images/models.png)

- **模型管控**页内置 40 个 Provider 预设（官方 API、聚合平台、国内平台），点卡片即可配置
- 每个平台配置三样东西：**端点**（如官方 API 或兼容端点）、**认证方式**（API Key / OAuth 等，互斥单选）、**密钥**（从密钥库选择或粘贴）
- 卡片右上角三点菜单：
  - **连接**：测试连通性 + 拉取该平台的模型列表
  - **接入文档**：跳转官方文档
- Provider 配置支持**导入/导出**，方便跨设备迁移
- 命令行方式：

```bash
okit provider list              # 列出所有 Provider（--json 供脚本解析）
okit provider add               # 添加
okit provider delete <name>     # 删除
okit provider auth              # 查看所有 Provider 认证状态
```
