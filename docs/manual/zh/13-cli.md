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

# 多机同步
okit sync                          # 同步状态总览（--test 顺带测连接）
okit sync password                 # 设置同步密码（跨机解密的根，多台必须一致）
okit sync enable <platform>        # 配置并启用云平台（交互填凭据，可 --set KEY=VALUE）
okit sync test [platform]          # 测试连接
okit sync push / pull              # 推送 / 拉取合并
okit sync export                   # 生成一次性同步码（含平台配置，另一台机器 import 一键迁移）
okit sync pair --create            # 局域网配对：生成配对码（需 okit web 在运行）
okit sync pair --code <连接码>      # 输入对方的连接码完成配对

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
