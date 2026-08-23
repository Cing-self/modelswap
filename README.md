<div align="center">

# OKIT

### The Key & Model Console for AI Coding Agents — Claude Code / Codex / OpenCode / ZCode / Kimi / Grok & 10 agents total

[![Version](https://img.shields.io/github/v/release/Cing-self/okit?color=blue&label=version)](https://github.com/Cing-self/okit/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Cing-self/okit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

[中文](README_ZH.md) · [Website](https://landing.auto.code) · [Docs](docs/manual/en/) · [Changelog](CHANGELOG.md)

</div>

Keys and models, one console. OKIT is a local-first open-source tool that manages the full key lifecycle for AI coding CLIs: **create → store → switch → verify → monitor**. Local features are free forever.

## Screenshots

| Home · Agent config | Model platforms |
|---|---|
| ![Quick start](docs/manual/images/quick-start.png) | ![Models](docs/manual/images/models.png) |

| Key vault | Auto-create keys |
|---|---|
| ![Vault](docs/manual/images/vault.png) | ![Auto-create](docs/manual/images/auto-create.png) |

## Why OKIT

- **Switching never loses your config** — Surgical writes: only fields OKIT owns are touched; your hooks, statusLine, tui and MCP config stay intact. Every switch is snapshotted first — one-click diff and rollback in Settings.
- **Switch models without leaving Codex** — OKIT auto-generates Codex's native model catalog (model-catalogs); switch with `/model` right inside the Codex CLI, no round-trip to OKIT.
- **Zero daemons, zero interception** — No background process, nothing on your request path: OKIT writes config and exits; your agents talk to model platforms directly. Uninstall leaves nothing behind — configs keep working.
- **Key vault** — AES-256-GCM encrypted local storage, cloud sync and LAN peer-to-peer sync (pairing-code pairing).

## Comparison

| Capability | OKIT | cc-switch | codex-router |
|------|------|-----------|--------------|
| Config writing | Field-level merge + pre-switch snapshot/rollback | Full overwrite + config snippets | Managed block |
| Resident process | None | Tray (optional proxy) | Local gateway (required) |
| Agents supported | 10 | 8 | Codex family |
| Key management | Encrypted vault + project binding | Plaintext local config | Credential isolation |
| Auto-create API keys | 31 platforms (browser extension) | — | — |
| Usage queries | 30+ subscription/balance sources, direct | Proxy-layer stats | — |
| Platforms | macOS / Linux / Windows | macOS / Linux / Windows | macOS / Linux / Windows |

## Quick Start

```bash
# via npm
npm install -g @cing-self/okit-cli

# or from source
git clone https://github.com/Cing-self/okit.git
cd okit
npm ci --ignore-scripts
npm run build
node dist/main.js web
# open http://localhost:3780
```

Common commands:

```bash
okit web                              # launch the web console (:3780)
okit vault set <key>                  # store a key interactively (AES-256-GCM)
printf '%s' "$SECRET" | okit vault set <key> --stdin  # keep secrets out of argv in automation
okit vault inject                     # print export statements (pipe to eval)
okit provider list                    # list 40 preset model platforms
okit provider switch                  # interactive provider/model switch
okit provider use <provider>          # non-interactive switch (script/agent friendly)
okit hook install                     # auto-inject keys into your shell on cd
```

> **Shell config boundary**: installing `okit` never touches your shell config (`~/.zshrc` / `~/.bashrc` etc.). The cd hook is only written when you explicitly run `okit hook install`; `okit hook uninstall` removes it at any time.

### For AI agents

The package ships an [`okit-cli` Agent Skill](skills/okit-cli/SKILL.md). Run `okit skill install /path/to/project` to install it into the target project's `.agents/skills/okit-cli/`; `okit skill path` prints the bundled original location. The skill documents resolvable read-only commands, non-interactive model switching, and the security boundaries around plaintext keys, shell hooks and cloud sync.

Or install straight from the public repo via [skills.sh](https://skills.sh/):

```bash
npx skills add Cing-self/okit --skill okit-cli
```

## Features

### Key vault
AES-256-GCM encrypted storage, masked display, shell hook auto-injection, cloud sync + LAN sync. The first-run wizard scans agent config files and imports stray plaintext keys into the vault in one click.

### Provider / model management
40 preset platforms (official / aggregator / CN), 10 agent adapters, multi-endpoint protocols (Anthropic / OpenAI compatible), auth-state detection, and subscription / API-key / third-party credential modes. Adding a site starts with an empty model list — you check what you want, exactly that gets written. Model parameters (context window / output limit / tool call / reasoning / multimodal) are auto-filled from the [models.dev](https://models.dev) catalog — no more guessing.

### Auto-create keys
A browser extension fills and submits the key-creation form inside each platform's official console and captures the result (31 platforms, incl. Volcengine, Zhipu, Baidu Qianfan).

### Usage
Direct queries against 30+ subscription / balance sources, with threshold alerts (local notifications).

### Model catalog
Official pricing and capability data across platforms (input / output / cache pricing, context windows), peak/off-peak rates included.

## FAQ

**Does OKIT sit on my request path?**
No. Zero daemons, zero interception: OKIT writes config and exits — your agents connect to model platforms directly, with no proxy or forwarding layer.

**Will switching break my existing settings?**
No. Surgical writes touch only OKIT-owned fields; hooks / statusLine / MCP config are preserved, and every switch is snapshotted for rollback.

**Where are keys stored? How safe?**
AES-256-GCM encrypted locally, with machine-bound key derivation. Nothing ever lands on disk in plaintext (keys found by the import wizard are shown masked only). Uninstalling wipes everything.


## Development

```bash
npm ci                      # install per lockfile
npm run build               # tsc + preset codegen + web copy + frontend build
npx vitest run              # tests (500+ cases)
cd src/web/frontend && npm run dev   # frontend dev server (:5173 → proxies :3780)
```

Requires Node.js 20+. Frontend: React + TypeScript + Vite; backend: Node (web layer in CommonJS); tests: vitest.

## Documentation

- [User manual](docs/manual/en/)（[中文](docs/manual/zh/)，with product screenshots）
- [Contributing](CONTRIBUTING.md)

## License

OKIT is released under the [MIT License](LICENSE). Copyright Cing-self / OKIT contributors (2026).
