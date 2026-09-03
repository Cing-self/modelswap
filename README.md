<div align="center">

# ModelSwap

### The Key & Model Console for AI Coding Agents — Claude Code / Codex / OpenCode / ZCode / Kimi / Grok & 10 agents total

[![Version](https://img.shields.io/github/v/release/Cing-self/modelswap?color=blue&label=version)](https://github.com/Cing-self/modelswap/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Cing-self/modelswap/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

[中文](README_ZH.md) · [Website](https://modelswap.app) · [Docs](https://docs.modelswap.app) · [Changelog](CHANGELOG.md)

</div>

Keys and models, one console. ModelSwap is a local-first open-source tool that manages the full key lifecycle for AI coding CLIs: **create → store → switch → verify → sync**. All data stays on your machine — no account, no subscription.

## Screenshots

| Home · Agent config | Model platforms |
|---|---|
| ![Quick start](docs/manual/images/quick-start.png) | ![Models](docs/manual/images/models.png) |

| Key vault | Auto-create keys |
|---|---|
| ![Vault](docs/manual/images/vault.png) | ![Auto-create](docs/manual/images/auto-create.png) |

## Why ModelSwap

- **Switching never loses your config** — Surgical writes: only fields ModelSwap owns are touched; your hooks, statusLine, tui and MCP config stay intact. Every switch is snapshotted first — one-click diff and rollback in Settings.
- **41 platforms out of the box** — Anthropic / OpenAI / Google / Volcengine / Zhipu / DeepSeek / Kimi… official, aggregator and China-based presets ready to go: pick a platform, paste a key, switch. No doc-diving for base URLs.
- **Switch models without leaving the terminal** — ModelSwap generates each agent's native model catalog; switch with `/model` right inside the CLI, no round-trip to ModelSwap.
- **Multi-device sync, you own the data** — LAN peer-to-peer sync with pairing codes, or plug in your own cloud storage (Cloudflare / Supabase / WebDAV / iCloud and more, 9 backends); one-time sync codes migrate between machines. Payloads are encrypted — the server never sees plaintext.
- **Zero daemons, zero interception** — No background process, nothing on your request path: ModelSwap writes config and exits; your agents talk to model platforms directly. Uninstall leaves nothing behind — configs keep working.
- **Key vault** — AES-256-GCM encrypted local storage with machine-bound key derivation; inject keys into your terminal on demand with `modelswap vault inject --keys …`.

## Supported agents

Ten built-in adapters, each writing that agent's native config files (e.g. `config.toml` + `auth.json` for Codex, `settings.json` for Claude Code):

**Claude Code · ChatGPT Codex · OpenCode · OpenClaw · WorkBuddy · ZCode · Hermes · Kimi Code · Grok · MiMo Code**

## Comparison

> Based on both projects' official READMEs as of 2026-09 ([cc-switch](https://github.com/farion1231/cc-switch) · [codex-router](https://github.com/duolahypercho/codex-router)). Different tools, different trade-offs — pick what fits.

| Capability | ModelSwap | cc-switch | codex-router |
|------|------|-----------|--------------|
| Positioning | Key & model console (write & exit) | Provider-switch GUI (tray + optional local proxy) | Local model router (background service + control center) |
| Config writing | Field-level merge + pre-switch snapshots, one-click rollback | Atomic writes + auto backups (last 10) + shared snippets | Managed-block injection |
| Request path | Never through ModelSwap | Direct, or via optional proxy (hot-switch/failover) | Routed through the local router service |
| Agents supported | 10 | 8 | Codex-first (Harness/Gemini CLI bridges experimental) |
| Key storage | AES-256-GCM encrypted vault | Local SQLite store (README does not mention encryption) | Stored locally (README does not mention encryption) |
| Auto-create API keys | 31 platforms (browser extension) | — | — |
| Usage queries | 37 subscription/balance sources, direct | Usage dashboard (spend/requests/tokens) | — |
| Multi-device sync | LAN peer-to-peer + 9 self-hosted cloud backends + sync codes | — | — |
| Platforms | macOS / Linux / Windows | macOS / Linux / Windows | macOS / Linux / Windows |

## Quick Start

```bash
# via npm
npm install -g modelswap

# launch the web console
modelswap web          # opens http://localhost:3780

# or from source
git clone https://github.com/Cing-self/modelswap.git
cd modelswap
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

Everyday commands:

```bash
modelswap web                              # web console (:3780)
modelswap vault set <key>                  # store a secret interactively (AES-256-GCM)
printf '%s' "$SECRET" | modelswap vault set <key> --stdin  # keep secrets out of argv in automation
modelswap vault inject                     # print export statements (pair with eval)
modelswap provider list                    # list 41 preset model platforms
modelswap provider switch                  # interactive provider/model switch per agent
modelswap provider use <provider>          # non-interactive switch (script/agent friendly)
modelswap sync pair --create               # LAN pairing, or sync push/pull via self-hosted cloud
```

> **Shell config boundary**: ModelSwap never touches your shell config (`~/.zshrc` / `~/.bashrc`) — no feature writes to it.

### For AI agents

The package ships a [`modelswap` agent skill](skills/modelswap/SKILL.md). `modelswap skill install /path/to/project` installs it into the project's `.agents/skills/modelswap/`; `modelswap skill path` prints the built-in source location. The skill documents the parseable read-only commands, non-interactive model switching, and the security boundaries around plaintext keys and cloud sync.

Or install it straight from the public repo via [skills.sh](https://skills.sh/):

```bash
npx skills add Cing-self/modelswap --skill modelswap
```

### Building & developing

```bash
npm ci                      # install from the lockfile
npm run build               # tsc + preset generation + web copy + frontend build
npx vitest run              # tests (500+ cases)
cd src/web/frontend && npm run dev   # frontend dev server (:5173 → proxies :3780)
```

Node.js 20+. Frontend: React + TypeScript + Vite; backend: Node (web layer in CommonJS); tests: vitest. See [CONTRIBUTING.md](CONTRIBUTING.md) for commit and release conventions.

## Feature Overview

### Key vault
AES-256-GCM encrypted storage, masked display, on-demand terminal injection (`vault inject --keys`). The first-run wizard scans agent config files and safely imports stray plaintext keys in one click.

### Multi-device sync
- **LAN**: pairing-code peer-to-peer sync — no third-party server involved
- **Self-hosted cloud**: Cloudflare (KV/D1/R2), Supabase, WebDAV, iCloud, Volcengine TOS and more — 9 backends, encrypted payloads
- **One-time sync codes**: migrate all config and keys between two machines

### Provider / model management
41 platform presets (official / aggregator / China-based), 10 agent adapters, multi-endpoint protocols (anthropic / OpenAI-compatible / responses), auth-state checks, and three credential modes (subscription / API / third-party). Adding a site starts from an empty model list — you write exactly what you choose.

### Auto-create keys
The browser extension fills and submits key-creation forms inside official consoles (31 platforms). Google AI Studio and Cloudflare channels are temporarily not offered; keys for them can still be added manually.

### Usage queries
37 subscription/balance sources queried directly, with threshold alerts (local notifications).

### Snapshots & rollback
Every agent-config switch is snapshotted automatically; Settings diffs any two snapshots side by side and rolls back in one click.

## FAQ

**Does ModelSwap sit on my request path?**
No. Zero daemons, zero interception: ModelSwap writes config and exits. Your agents talk to model platforms directly — no proxy, no forwarding.

**Will switching break my existing settings?**
No. Surgical writes touch only ModelSwap-owned fields; hooks / statusLine / MCP config stay intact, and every switch is snapshotted for rollback.

**Where are my keys stored? Are they safe?**
AES-256-GCM encrypted locally, with machine-bound key derivation. Nothing ever lands on disk in plaintext (keys found by the import wizard are masked, too). Uninstalling wipes everything.

**Where does sync send my keys?**
LAN mode is peer-to-peer. Cloud sync goes to storage you create yourself (Cloudflare / Supabase / WebDAV…) and payloads are encrypted — the provider never sees plaintext. You can leave sync entirely off.

**Which agents are supported?**
10 adapters: Claude Code, Codex, OpenCode, ZCode, Kimi Code, Grok, Hermes, OpenClaw, Mimo Code, WorkBuddy.

**How do I uninstall?**
`npm uninstall -g modelswap`, then remove `~/.modelswap`. Agent configs already written keep working unchanged.

## Docs

- [docs.modelswap.app](https://docs.modelswap.app) — user manual ([GitHub source](docs/manual/en/))
- [llms.txt](https://modelswap.app/llms.txt) / [llms-full.txt](https://modelswap.app/llms-full.txt) — machine-readable product reference for AI assistants
- [Contributing](CONTRIBUTING.md)

## License

ModelSwap is released under the [MIT License](LICENSE). © Cing-self / ModelSwap contributors (2026).
