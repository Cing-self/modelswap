# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run build          # Full: tsc + copy web/api + copy tool YAMLs + frontend build
npm run dev            # Dev mode via ts-node
npm run start          # Run compiled CLI: node dist/main.js

# Frontend only
cd src/web/frontend && npm run dev    # Dev server on :5173, proxies /api → :3780
cd src/web/frontend && npm run build  # Builds to dist/web/public/

# Testing
npm test               # vitest run
npm run test:watch     # vitest (watch mode)
npx vitest run tests/providers/store.test.ts  # single test file
```

### Web deployment sequence

After frontend changes: `cd src/web/frontend && npx vite build` then from project root: `cp src/web/server.js dist/web/server.js && rm -rf dist/web/api && cp -r src/web/api dist/web/api`. Must `rm -rf` the api dir before copying to avoid stale files.

## Architecture

OKIT is a CLI + Web Dashboard for managing AI agent infrastructure: API key vault, provider/model management.

### CLI (Commander.js)

Entry: `src/main.ts` registers all commands. Each command lives in `src/commands/`.

### Provider System

`src/providers/` manages multi-platform AI model providers:
- `types.ts` — Provider/Model interfaces
- `store.ts` — CRUD on `~/.okit/providers.json`, auto-initializes presets on first load
- `presets.ts` — 22 built-in providers (Anthropic, OpenAI, Google, 火山引擎, 智谱AI, etc.)
- `adapters/` — Per-agent config writers (Codex writes `~/.Codex/settings.json`, Codex writes `~/.codex/config.toml`, etc.)
- `registry.ts` — Maps agent names to adapter instances

### Vault

AES-256-GCM encrypted key storage in `src/vault/store.ts`. Machine-specific key derivation. Supports cloud sync.

### Web UI

- **Backend**: `src/web/server.js` (Express) + `src/web/api/*.js` — pure CommonJS, no TypeScript
- **Frontend**: `src/web/frontend/` — React + TypeScript, Vite build
  - Components organized by feature: `components/{vault,models,agents,logs,settings}/`
  - Shared sidebar layout: `.page-with-sidebar` + `.page-sidebar` classes (defined in `components.css`)
  - Design system: "Paper Cutout Collage" style using CSS variables (`--paper`, `--kraft`, `--kraft-dark`, `--ink`, `--ink-muted`), dashed borders, `1.5px solid` borders, `2px 2px 0 rgba(0,0,0,0.06)` shadows
  - All CSS files in `src/web/frontend/src/styles/` — `base.css` (variables/layout), `components.css` (shared), `providers.css`, `vault.css`, etc.

### Config & i18n

- User config: `~/.okit/user.json` (read/write via `src/config/user.ts`)
- Language: `src/config/i18n.ts` — Chinese/English, auto-detected
- All features must support macOS, Linux, and Windows

## Development Conventions

### CI & Cross-Platform Testing

CI 在 ubuntu/macos/windows 三平台矩阵跑测试；Publish 发版由 CI 全绿门禁触发（workflow_run），CI 红时不会发版。**push 到 main 后必须等 CI 三平台全绿（`gh run watch`）再合入/推送下一批并行改动**——本地 macOS 全绿不代表远端全绿。

跨平台测试规则（都是 2026-08-27 CI 三轮事故的教训，mac 上感知不到、只在 linux/windows 矩阵暴露）：

- 子进程测试（`execFileSync` 起 node/ts-node）的 env 必须同时设 `HOME` **和** `USERPROFILE`——Windows 的 `os.homedir()` 读 `USERPROFILE`，只设 HOME 子进程会写错 home
- 不要在测试里重算平台相关路径（`APPDATA`/`XDG_CONFIG_HOME`/`~/Library`）——CI runner 的这些环境变量指向真实 home，而测试 HOME 是隔离临时目录，两套推导必然错位。路径从 adapter 导出的解析函数取（如 opencode 的 `openCodeDesktopStorePaths()`），单一真源
- ts-node 子进程型测试必须显式加 timeout（`describe('...', { timeout: 30000 })`）——冷编译就可能超过 vitest 默认 5s，慢 runner 上必超
- 编译产物 `dist/providers/**` 会 require `dist/web/api/**`（store→models-dev、codex→log-writer）——CI 只跑 `npx tsc` 不跑完整构建，靠 ci.yml 里的 `npm run copy-web` 补齐；新增 src→dist 反向依赖时注意这条链

### Web Server Port

固定使用 **3780** 端口。所有场景统一：

| 场景 | 地址 |
|------|------|
| `okit web` / `npm run dev` | `http://localhost:3780` |
| 前端开发代理 (`vite dev`) | `:5173` → proxy `/api` → `:3780` |
| 开发调试时手动启动 | `node -e "require('./dist/web/server.js').startServer()"` |

启动时如果 3780 被占用，自动尝试 3781、3782... 直到可用。只有非当前程序占用时才会递增，不要随意换端口。

### Frontend Style Rules

- 使用已有 CSS 变量（`--paper`, `--kraft`, `--ink` 等），不硬编码颜色
- 新页面使用 `.page-with-sidebar` 共享布局，不要重写侧边栏样式
- 深色模式用 `[data-theme="dark"]` 选择器，紧跟在对应亮色样式后面
- CSS 按功能拆分文件，放在 `src/web/frontend/src/styles/`

### Code Style

- Backend API 文件（`src/web/api/*.js`）使用 CommonJS，不用 TypeScript
- 前端代码使用 TypeScript + React 函数组件
- 新增 Provider 或 Agent adapter 时同步更新 `src/providers/presets.ts` 和 `src/web/api/providers.js` 中的预设列表
