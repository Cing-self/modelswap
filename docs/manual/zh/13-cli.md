# 13. CLI 命令速查

```bash
okit                            # 查看帮助
okit web                        # 启动 Web 控制台（-p 端口 / -o 打开浏览器）
okit upgrade                    # 升级 OKIT
okit -V                         # 查看版本

# 密钥库
okit vault                      # 列出所有密钥（同 list）
okit vault set <key> [--stdin]  # 存密钥（--stdin 避免进入 shell 历史）
okit vault get <key>            # 获取明文
okit vault list [--json]        # 列出（--json 供脚本/Agent 解析）
okit vault delete <key>         # 删除
okit vault inject [--keys k1,k2] [--dir <dir>] [--shell zsh]   # 输出 export 语句
okit vault env [file] [--dir]   # 根据 .okitenv 生成 .env 并登记关联
okit vault where <key>          # 查看密钥被哪些项目使用
okit vault sync                 # 刷新所有关联文件
okit vault test <platform>      # 测试云同步平台连接
okit vault push                 # 推送密钥与配置到云端
okit vault pull                 # 从云端拉取合并

# Shell 钩子
okit hook install               # cd 进项目自动注入密钥
okit hook uninstall             # 移除钩子
okit hook status                # 查看状态

# Provider / 模型
okit provider list [--json]     # 列出所有 Provider
okit provider switch [agent]    # 交互式切换
okit provider use <p> [--agent <a>] [--model <m>]   # 非交互式切换
okit provider add               # 添加 Provider
okit provider delete <name>     # 删除 Provider
okit provider current [--json]  # 查看所有 Agent 当前配置
okit provider auth [--json]     # 查看认证状态

# Agent Skill（让 AI Agent 直接调用 OKIT）
okit skill path                 # 输出内置 Skill 文件路径
okit skill install [dir]        # 安装到目标项目 .agents/skills/okit-cli
```
