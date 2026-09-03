# 10. 让 AI Agent 驱动 ModelSwap（Skill）

ModelSwap 随安装包附带一个纯 Markdown 的 **Agent Skill**：教会 Claude Code、Codex、OpenCode 等 AI 编程 Agent 使用 CLI——用机器可读输出检查状态、非交互式切换模型，并严格遵守密钥相关的安全边界。

## 10.1 定位并安装

```bash
modelswap skill path                      # 输出内置 Skill 文件位置
modelswap skill install /path/to/project  # 写入 .agents/skills/modelswap/SKILL.md
```

也可以直接从公开仓库获取：

```bash
npx skills add Cing-self/modelswap --skill modelswap
```

## 10.2 它能做什么

- **检查状态**：`modelswap provider current --json`、`provider list --json`、`provider auth --json`、`vault list --json`——均为脱敏输出，可安全读取
- **免交互切换**：`modelswap provider use <provider> --agent <agent> --model <model>`——Skill 会要求 Agent 始终显式给出 agent 与 model ID，而不是依赖默认值
- **知道边界在哪**：密钥绝不进入命令行参数或日志（用 `--stdin`）；`vault get` / `vault inject` 视为明文泄露，仅当任务确实需要时使用；`vault push` / `pull` 仅在明确要求时执行；`vault delete` 之前必须先看 `vault where`

原始命令清单见第 14 章。Skill 是给 Agent 用的——人还是直接用 Web 控制台或 CLI 更方便。
