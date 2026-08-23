<div align="center">

# OKIT

### AI Agent 的密钥与模型管控台 — Claude Code / Codex / OpenCode / ZCode / Kimi / Grok 等 10 个 Agent

[![Version](https://img.shields.io/github/v/release/Cing-self/okit?color=blue&label=version)](https://github.com/Cing-self/okit/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Cing-self/okit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

English · [官网](https://landing.auto.code) · [用户手册](docs/manual/zh/) · [CHANGELOG](CHANGELOG.md)

</div>

密钥与模型，一处掌控。OKIT 是一个本地优先的开源工具，管好 AI 编程 CLI 的密钥生命周期：**创建 → 保管 → 切换 → 验证 → 监控**。本地功能永久免费。

## 截图

| 首页 · Agent 配置 | 模型平台 |
|---|---|
| ![快速启动页](docs/manual/images/quick-start.png) | ![模型平台](docs/manual/images/models.png) |

| 密钥库 | 一键创建 Key |
|---|---|
| ![密钥库](docs/manual/images/vault.png) | ![一键创建](docs/manual/images/auto-create.png) |

## 为什么是 OKIT

- **切换永不丢配置** — 外科手术式写入：只改 OKIT 自己拥有的字段，你的 hooks、statusLine、tui、MCP 配置原样保留。每次切换前自动快照，设置页一键对比与回滚。
- **切模型不离开 Codex** — 自动生成 Codex 原生模型目录（model-catalogs），在 Codex CLI 里 `/model` 直接切换，不用回到 OKIT。
- **零常驻、零侵入** — 没有后台进程、不在请求路径上：OKIT 写完配置就退出，你的 Agent 直连模型平台。卸载不留痕，配置照常工作。
- **密钥保险库** — AES-256-GCM 本地加密存储，支持云端同步与局域网点对点同步（配对码配对）。

## 与同类工具对比

| 能力 | OKIT | cc-switch | codex-router |
|------|------|-----------|--------------|
| 配置写入 | 字段级合并 + 切换前快照/回滚 | 全量覆盖 + 通用配置片段 | managed block |
| 常驻进程 | 无 | 托盘（代理可选） | 本地网关（必须） |
| 支持 Agent | 10 个 | 8 个 | Codex 系 |
| 密钥管理 | 加密 vault + 项目绑定 | 本地明文配置 | 凭证隔离 |
| 自动创建 API Key | 31 个平台（浏览器扩展） | — | — |
| 用量查询 | 30+ 个订阅/余额来源直查 | 代理层统计 | — |
| 平台 | macOS / Linux / Windows | macOS / Linux / Windows | macOS / Linux / Windows |

## 快速开始

```bash
# npm 安装
npm install -g @cing-self/okit-cli

# 或从源码
git clone https://github.com/Cing-self/okit.git
cd okit
npm ci --ignore-scripts
npm run build
node dist/main.js web
# 打开 http://localhost:3780
```

常用命令：

```bash
okit web                              # 启动 Web 管理台（:3780）
okit vault set <key>                  # 交互式存密钥（AES-256-GCM 加密）
printf '%s' "$SECRET" | okit vault set <key> --stdin  # 自动化时避免密钥进入命令参数
okit vault inject                     # 输出 export 语句（配合 eval）
okit provider list                    # 列出 40 个预置模型平台
okit provider switch                  # 交互式切换 Agent 的 Provider/模型
okit provider use <provider>          # 非交互式切换（脚本/Agent 友好）
okit hook install                     # cd 进项目自动注入密钥到 shell
```

> **Shell 配置安全边界**：安装 `okit` 不会自动修改你的 Shell 配置（`~/.zshrc` / `~/.bashrc` 等）。只有你主动运行 `okit hook install` 时才会写入 cd 钩子；`okit hook uninstall` 可随时移除。

### 给 AI Agent 使用

安装包随附 [`okit-cli` Agent Skill](skills/okit-cli/SKILL.md)。运行 `okit skill install /path/to/project` 会将它安装到目标项目的 `.agents/skills/okit-cli/`；`okit skill path` 可输出内置原文件位置。Skill 说明了可解析的只读命令、非交互式模型切换，以及密钥明文、Shell Hook 和云同步的安全边界。

也可以通过 [skills.sh](https://skills.sh/) 直接从公开仓库安装：

```bash
npx skills add Cing-self/okit --skill okit-cli
```

## 功能总览

### 密钥库
加密存储（AES-256-GCM）、脱敏展示、shell 钩子自动注入、云同步 + 局域网同步。首次启动向导自动扫描 Agent 配置文件，把散落的明文密钥一键安全入库。

### Provider / 模型管控
40 个平台预置（官方 / 聚合 / 国内），10 个 Agent 适配器，多端点协议（anthropic / openai 兼容），认证状态检测，订阅 / API / 第三方三模式凭证管理。添加站点默认空模型列表，你勾选什么写什么；模型参数（上下文窗口 / 输出上限 / 工具调用 / 推理 / 多模态）自动从 [models.dev](https://models.dev) 目录补全，不再靠猜。

### 一键创建 Key
浏览器扩展在官方控制台内自动填表创建并回填（31 个平台，含火山引擎、智谱、百度千帆等）。

### 用量查询
30+ 个订阅 / 余额来源直查，阈值告警（本地通知）。

### 模型目录
全平台官方定价与能力数据（输入 / 输出 / 缓存价、上下文窗口），峰谷价直呈。

## FAQ

**OKIT 会在我的请求路径上吗？**
不会。零常驻、零侵入：OKIT 写完配置就退出，你的 Agent 直连模型平台，没有任何代理或转发层。

**切换配置会破坏我已有的设置吗？**
不会。外科手术式写入：只改 OKIT 拥有的字段，hooks / statusLine / MCP 配置原样保留，切换前自动快照可回滚。

**密钥存在哪里？安全吗？**
AES-256-GCM 本地加密，密钥派生绑定本机。绝不以明文落盘（导入向导扫描到的配置文件密钥也只以掩码展示）。卸载即全部清除。


## 开发

```bash
npm ci                      # 按锁文件安装依赖
npm run build               # tsc + 预设生成 + web 拷贝 + 前端构建
npx vitest run              # 测试（500+ 用例）
cd src/web/frontend && npm run dev   # 前端开发服务器（:5173 → 代理 :3780）
```

要求 Node.js 20+。前端 React + TypeScript + Vite；后端 Node（web 层 CommonJS）；测试 vitest。

## 文档

- [用户手册](docs/manual/zh/)（[English](docs/manual/en/)，含产品截图）
- [贡献指南](CONTRIBUTING.md)

## License

OKIT 以 [MIT License](LICENSE) 发布。版权归属 Cing-self / OKIT contributors（2026）。
