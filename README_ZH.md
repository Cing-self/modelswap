<div align="center">

# ModelSwap

### AI Agent 的密钥与模型管控台 — Claude Code / Codex / OpenCode / ZCode / Kimi / Grok 等 10 个 Agent

[![Version](https://img.shields.io/github/v/release/Cing-self/modelswap?color=blue&label=version)](https://github.com/Cing-self/modelswap/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Cing-self/modelswap/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

English · [官网](https://modelswap.app) · [文档](https://docs.modelswap.app) · [CHANGELOG](CHANGELOG.md)

</div>

密钥与模型，一处掌控。ModelSwap 是一个本地优先的开源工具，管好 AI 编程 CLI 的密钥生命周期：**创建 → 保管 → 切换 → 验证 → 同步**。全部数据留在本机，不注册、不订阅。

## 截图

| 首页 · Agent 配置 | 模型平台 |
|---|---|
| ![快速启动页](docs/manual/images/quick-start.png) | ![模型平台](docs/manual/images/models.png) |

| 密钥库 | 一键创建 Key |
|---|---|
| ![密钥库](docs/manual/images/vault.png) | ![一键创建](docs/manual/images/auto-create.png) |

## 为什么是 ModelSwap

- **切换永不丢配置** — 外科手术式写入：只改 ModelSwap 自己拥有的字段，你的 hooks、statusLine、tui、MCP 配置原样保留。每次切换前自动快照，设置页一键对比与回滚。
- **41 个平台开箱即用** — Anthropic / OpenAI / Google / 火山引擎 / 智谱 / DeepSeek / Kimi…官方、聚合与国内平台预置就绪，选平台、贴密钥、点切换，不用查文档拼 baseUrl。
- **切模型不离开终端** — 为每个 Agent 生成原生模型目录，在 CLI 里 `/model` 直接切换，不用回到 ModelSwap。
- **多设备同步，数据自己做主** — 局域网点对点配对同步（配对码），或接入你自己的云存储（Cloudflare / Supabase / WebDAV / iCloud 等 9 种后端）；也可用一次性同步码在机器间迁移。密文传输，服务器看不到明文。
- **零常驻、零侵入** — 没有后台进程、不在请求路径上：ModelSwap 写完配置就退出，你的 Agent 直连模型平台。卸载不留痕，配置照常工作。
- **密钥保险库** — AES-256-GCM 本地加密存储，密钥派生绑定本机，支持与项目绑定自动注入 `.env`。

## 与同类工具对比

> 依据 2026-09 两项目官方 README（[cc-switch](https://github.com/farion1231/cc-switch) · [codex-router](https://github.com/duolahypercho/codex-router)），各有侧重，按需选择。

| 能力 | ModelSwap | cc-switch | codex-router |
|------|------|-----------|--------------|
| 定位 | 密钥与模型管控台（写完即退） | 供应商切换 GUI（托盘 + 可选本地代理） | 本地模型路由（后台服务 + 控制中心） |
| 配置写入 | 字段级合并 + 切换前自动快照、一键回滚 | 原子写入 + 自动备份（保留 10 份）+ 通用配置片段 | 托管块（managed block）注入 |
| 请求路径 | 不经过 ModelSwap | 直连，或经可选代理（热切换/故障转移） | 经本地路由服务转发 |
| 支持 Agent | 10 个 | 8 个 | Codex 为主（Harness/Gemini CLI 等桥接实验性） |
| 密钥存储 | AES-256-GCM 加密 vault + 项目绑定 | SQLite 本地库（README 未提及加密） | 本机保存（README 未提及加密） |
| 自动创建 API Key | 33 个平台（浏览器扩展 + gcloud CLI） | — | — |
| 用量查询 | 37 个订阅/余额来源直查 | 用量仪表盘（支出/请求/Token） | — |
| 多设备同步 | LAN 点对点 + 9 种自托管云后端 + 同步码 | — | — |
| 平台 | macOS / Linux / Windows | macOS / Linux / Windows | macOS / Linux / Windows |

## 快速开始

```bash
# npm 安装
npm install -g modelswap

# 启动 Web 管理台
modelswap web          # 打开 http://localhost:3780

# 或从源码
git clone https://github.com/Cing-self/modelswap.git
cd modelswap
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

常用命令：

```bash
modelswap web                              # Web 管理台（:3780）
modelswap vault set <key>                  # 交互式存密钥（AES-256-GCM 加密）
printf '%s' "$SECRET" | modelswap vault set <key> --stdin  # 自动化时避免密钥进入命令参数
modelswap vault inject                     # 输出 export 语句（配合 eval）
modelswap provider list                    # 列出 41 个预置模型平台
modelswap provider switch                  # 交互式切换 Agent 的 Provider/模型
modelswap provider use <provider>          # 非交互式切换（脚本/Agent 友好）
modelswap sync pair --create               # 局域网配对，或 sync push/pull 走自托管云
```

> **Shell 配置安全边界**：ModelSwap 永远不会修改你的 Shell 配置（`~/.zshrc` / `~/.bashrc` 等）——没有任何功能会写它。

### 给 AI Agent 使用

安装包随附 [`modelswap` Agent Skill](skills/modelswap/SKILL.md)。运行 `modelswap skill install /path/to/project` 会将它安装到目标项目的 `.agents/skills/modelswap/`；`modelswap skill path` 可输出内置原文件位置。Skill 说明了可解析的只读命令、非交互式模型切换，以及密钥明文与云同步的安全边界。

也可以通过 [skills.sh](https://skills.sh/) 直接从公开仓库安装：

```bash
npx skills add Cing-self/modelswap --skill modelswap
```

### 从源码构建与开发

```bash
npm ci                      # 按锁文件安装依赖
npm run build               # tsc + 预设生成 + web 拷贝 + 前端构建
npx vitest run              # 测试（500+ 用例）
cd src/web/frontend && npm run dev   # 前端开发服务器（:5173 → 代理 :3780）
```

要求 Node.js 20+。前端 React + TypeScript + Vite；后端 Node（web 层 CommonJS）；测试 vitest。提交规范与发版流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 功能总览

### 密钥库
AES-256-GCM 加密存储、脱敏展示、与项目绑定（自动注入 `.env`）。首次启动向导自动扫描 Agent 配置文件，把散落的明文密钥一键安全入库。

### 多设备同步
- **局域网**：配对码点对点同步，不经过任何第三方服务器
- **自托管云**：Cloudflare（KV/D1/R2）、Supabase、WebDAV、iCloud、火山 TOS 等 9 种后端，密文同步
- **一次性同步码**：两台机器之间迁移全部配置与密钥

### Provider / 模型管控
41 个平台预置（官方 / 聚合 / 国内），10 个 Agent 适配器，多端点协议（anthropic / openai 兼容 / responses），认证状态检测，订阅 / API / 第三方三模式凭证管理。添加站点默认空模型列表，你勾选什么写什么。

### 一键创建 Key
浏览器扩展在官方控制台内自动填表创建并回填（32 个平台）；Google AI Studio 走 gcloud CLI 一键创建（无需浏览器，共 33 个平台）。

### 用量查询
37 个订阅 / 余额来源直查，阈值告警（本地通知）。

### 快照与回滚
每次切换 Agent 配置前自动快照，设置页并排对比任意两份快照、一键回滚。

## FAQ

**ModelSwap 会在我的请求路径上吗？**
不会。零常驻、零侵入：ModelSwap 写完配置就退出，你的 Agent 直连模型平台，没有任何代理或转发层。

**切换配置会破坏我已有的设置吗？**
不会。外科手术式写入：只改 ModelSwap 拥有的字段，hooks / statusLine / MCP 配置原样保留，切换前自动快照可回滚。

**密钥存在哪里？安全吗？**
AES-256-GCM 本地加密，密钥派生绑定本机。绝不以明文落盘（导入向导扫描到的配置文件密钥也只以掩码展示）。卸载即全部清除。

**同步功能会把密钥传到哪？**
局域网模式点对点直传；云同步走你自己创建的存储（Cloudflare / Supabase / WebDAV 等），传输的是密文，服务商看不到明文。不需要同步功能可以完全不开。

**支持哪些 Agent？**
10 个适配器：Claude Code、Codex、OpenCode、ZCode、Kimi Code、Grok、Hermes、OpenClaw、Mimo Code、WorkBuddy。

**怎么卸载？**
`npm uninstall -g modelswap` 后删除 `~/.modelswap` 即可。已写入的 Agent 配置不受影响，继续正常工作。

## 文档

- [docs.modelswap.app](https://docs.modelswap.app) — 用户手册（[GitHub 源](docs/manual/zh/)）
- [贡献指南](CONTRIBUTING.md)

## License

ModelSwap 以 [MIT License](LICENSE) 发布。版权归属 Cing-self / ModelSwap contributors（2026）。
