# 14. CLI 命令速查

```bash
modelswap                            # 查看帮助
modelswap web                        # 启动 Web 控制台（-p 端口 / -o 打开浏览器）
modelswap upgrade                    # 升级 ModelSwap
modelswap -V                         # 查看版本

# 密钥库
modelswap vault                      # 列出所有密钥（同 list）
modelswap vault set <key> [--stdin]  # 存密钥（--stdin 避免进入 shell 历史）
modelswap vault get <key>            # 获取明文
modelswap vault list [--json]        # 列出（--json 供脚本/Agent 解析）
modelswap vault delete <key>         # 删除
modelswap vault inject [--keys k1,k2] [--dir <dir>] [--shell zsh]   # 输出 export 语句
modelswap vault test <platform>      # 测试云同步平台连接
modelswap vault push                 # 推送密钥与配置到云端
modelswap vault pull                 # 从云端拉取合并

# 多机同步
modelswap sync                          # 同步状态总览（--test 顺带测连接）
modelswap sync password                 # 设置同步密码（跨机解密的根，多台必须一致）
modelswap sync enable <platform>        # 配置并启用云平台（交互填凭据，可 --set KEY=VALUE）
modelswap sync test [platform]          # 测试连接
modelswap sync push / pull              # 推送 / 拉取合并
modelswap sync export                   # 生成一次性同步码（含平台配置，另一台机器 import 一键迁移）
modelswap sync pair --create            # 局域网配对：生成配对码（需 modelswap web 在运行）
modelswap sync pair --code <连接码>      # 输入对方的连接码完成配对

# Provider / 模型
modelswap provider list [--json]     # 列出所有 Provider
modelswap provider switch [agent]    # 交互式切换
modelswap provider use <p> [--agent <a>] [--model <m>]   # 非交互式切换
modelswap provider add               # 添加 Provider
modelswap provider delete <name>     # 删除 Provider
modelswap provider current [--json]  # 查看所有 Agent 当前配置
modelswap provider auth [--json]     # 查看认证状态

# Agent Skill（让 AI Agent 直接调用 ModelSwap）
modelswap skill path                 # 输出内置 Skill 文件路径
modelswap skill install [dir]        # 安装到目标项目 .agents/skills/modelswap
```
