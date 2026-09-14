---
name: modelswap-agent-routing
description: 为 AI 编码 Agent 配置 Provider 与模型——从判定目标 Agent、确认平台与认证、补齐密钥（自动创建或凭证捕获）、验证连接、选择模型到切换生效的完整流程。当用户要求为某个 Agent 换模型、换 Provider、接入新 Agent，或排查模型不可用时使用。
---

# Agent 模型路由

把「给某 Agent 配上可用的模型」当作一条流水线，逐步推进。每一步先查再动，失败有明确的兜底路径。

## 第 1 步 · 判定目标 Agent

用户说的「帮 Codex 换个模型」「给 OpenCode 接 MiMo」里，先确定 agentId：

```bash
modelswap provider current --json
```

输出即当前可管理的 Agent 清单（`agentId` / `agentName` / `configured` / `providerId` / `modelId`）。对照：`claude`=Claude Code、`codex`=ChatGPT (Codex)、`opencode`=OpenCode、`workbuddy`=WorkBuddy、`zcode`=ZCode、`grok`=Grok Build、`openclaw`=OpenClaw、`kimi-code`=Kimi Code、`mimo-code`=MiMo Code、`hermes`=Hermes。用户没点名 Agent 时，先用此输出问清楚要给谁配——省略 `--agent` 的切换会波及所有兼容 Agent。

## 第 2 步 · 确认平台是否可用

确定目标平台（Provider）后，检查它是否已在配置中、认证是否就绪：

```bash
modelswap provider list --json    # 平台是否已配置（41 个内置预设 + 自定义）
modelswap provider auth --json    # 认证状态：hasApiKey / oauthLoggedIn
```

- 平台在列表且 `hasApiKey: true` 或 `oauthLoggedIn: true` → 进第 4 步。
- 平台在列表但 `hasApiKey: false` → 进第 3 步补密钥。
- 平台不在列表 → 见「自定义平台」。

## 第 3 步 · 补齐密钥（没有 key 时）

按平台能力选路，优先级从上到下：

1. **支持自动创建**（浏览器扩展复用已登录会话，自动建 key 直接入库）：内置 30+ 平台变体——OpenAI、Anthropic、智谱、DeepSeek、Moonshot/Kimi、MiniMax（国内/国际）、Z.AI、阿里云百炼、硅基流动、百度千帆、火山方舟、腾讯云、小米 MiMo、阶跃星辰、xAI、Mistral、OpenRouter 及各 Coding/Token Plan 变体。调用 Web API `POST /api/vault/auto-create`（服务端编排，平台清单以 `GET /api/vault/auto-create/platforms` 为准）。
2. **不在自动创建列表**（如飞书、Supabase、企业内部网关）：走 `modelswap vault request` 凭证捕获——用户去控制台创建并复制，浏览器扩展自动接住入库。用法与安全规范见 `modelswap-vault-secrets` 技能。

拿到 key 后回到第 2 步复查 `provider auth --json`。

## 第 4 步 · 验证连接

密钥就位后、切换前，验证平台真的能连通（`provider auth --json` 的认证探测会对真实端点发起最小推理请求）：

- 探测通过 → 进第 5 步。
- 探测失败 → 看返回的错误类型分诊：key 无效/额度不足（引导用户到平台控制台核实，或重走第 3 步轮换）、网络不通（确认 baseUrl 与代理环境）、模型权限不足（换平台提供的其他模型）。

## 第 5 步 · 选模型并切换

用户通常说**模糊意图**（「换成 glm-5」「用最新的智谱」），不会报精确型号。判定规则：

```bash
modelswap provider search glm-5
# 每条命中带 match 标识：[精确]=id 完全一致  [系列]=同系列变体（glm-5-turbo 等）  [模糊]=子串顺带命中
# 排序：精确 > 系列 > 已认证 > 其余；头部统计会写明有无精确命中
```

- **有 `[精确]` 命中**：确认一句就切；同一 modelId 出现在多个平台时，把平台候选（含认证状态、国内/国际差异）列给用户选，不替用户挑。
- **只有 `[系列]` 命中**（用户说的 `glm-5` 实际是系列名，存在 `glm-5-turbo` / `glm-5-flash` / `glm-5-air` 等变体）：把变体连同定位差异呈现给用户——通常 `-turbo`/`-flash` 为快速轻量档、`-air` 为轻量档、无后缀为标准档、`-thinking` 为推理档——**不要替用户推断具体档位**。
- **仅 `[模糊]` 命中**：说明没有用户说的那个模型，先向用户澄清要的是不是列表中的某个，再继续。
- **用户说「最新」「最好」**：不要自行挑版本。按搜索结果列出该系列全部版本（含日期后缀的通常是快照版），让用户指定。
- **零命中**：提醒换关键词，或走「自定义平台」接入。

确认平台提供用户要的模型后，执行切换：

```bash
modelswap provider list --json          # models[] 里有每个模型的 id 与元数据
modelswap provider use <provider-id> --agent <agent-id> --model <model-id>
modelswap provider current --json       # 验证路由已变更
```

- Provider 按 **id 或 name 匹配**（区分大小写）；模型用 list 输出里的真实 modelId，不要凭记忆猜。
- 省略 `--model` 会用该平台的第一个模型——仅在用户明确接受默认时使用。
- 变更写入 Agent 的原生配置文件（Claude → `~/.claude`，Codex → `~/.codex`，OpenCode → `~/.config/opencode/opencode.json`），尽可能先建切换前快照。
- 路由已变但行为未变时：检查目标 Agent 是否需要重启加载配置，回到 `provider auth --json` 复查认证。

## 自定义平台

用户想接入清单之外的平台（自建网关、私有部署、兼容 OpenAI 协议的中转）：

```bash
modelswap provider add
```

交互式向导：选「自定义」→ 填协议类型（OpenAI 兼容 / Anthropic 等）、baseUrl、绑定 key（key 会存入 Vault）。添加完成后该平台与内置平台无异：出现在 `provider list`，可被 `provider use` 路由，可走同样的连接验证。向导适合让用户亲自跑；agent 需要非交互添加时，引导用户完成或使用预设。

## 常见任务速查

- 只换模型：`provider use <当前 provider-id> --agent <agent> --model <新 model-id>`
- 整体换平台：从第 2 步走完整流程（换平台 = 新认证 + 新 key 的完整链路）
- 接入新装的 Agent：`provider current --json` 确认已识别（`configured: false` 即未配置）→ 从第 2 步走起
- 交互式操作留给用户：`provider switch [agent]` 是人工向导，agent 自动化一律用 `use`
