# 1. What is ModelSwap

ModelSwap is an open-source tool for managing AI model infrastructure. If you use multiple AI platforms (OpenAI, Anthropic, Zhipu, Volcengine …), ModelSwap centralizes your API keys and model configs in one place and lets you switch with a single click.

## 1.1 What problem does it solve

- API keys are scattered across platform consoles, `.env` files, and agent configs — hard to manage centrally
- Switching models means manually editing every agent's config, error-prone
- Want an AI agent to handle the switch for you? You'd have to hand it your keys — a security risk. ModelSwap's CLI manages keys locally; the agent never sees the real key values
- No way to sync keys and configs across machines

## 1.2 Core capabilities

| Capability | Description |
|------------|-------------|
| Vault | AES-256-GCM encrypted storage on your machine; keys masked by default |
| Model management | 41 preset providers with unified endpoints and auth |
| Agent adapters | 10 agents — switch models in one click, configs updated automatically |
| Multi-device sync | iCloud / WebDAV / Cloudflare / Supabase / Volcengine, end-to-end encrypted |
| Browser extension | Auto-creates API keys on each platform and stores them in the vault |

## 1.3 How the pieces fit together

```
┌─────────────┐    ┌─────────────┐
│   Desktop   │    │    CLI      │
│   (macOS)   │    │  (all OS)   │
└──────┬──────┘    └──────┬──────┘
       │ built-in ext     │
       ▼                  ▼
┌──────────────────────────────┐
│    Web Console (:3780)        │
│  Vault · Models · Usage       │
└──────────────────────────────┘
              │
              ▼
   ~/.modelswap (local encrypted data)
```

- **Desktop app** — the same console in a native window (macOS only for now), with the browser extension built in — **the recommended install**
- **CLI** — command-line tool that also serves the web console; works on macOS / Linux / Windows
- **Web console** — the main UI for managing keys, switching models, and viewing usage
- **Browser extension** — auto-creates API keys on each AI platform

The desktop app and the CLI share the same data directory (`~/.modelswap`) — pick one.

Got the picture? Here's where to go next:

- **Want to try it right away?** → [Quick Start](03-quickstart.md) (ten minutes to your first model switch)
- **Prefer to install first?** → [Install & Start](02-install.md) (CLI, desktop, or web)
- **Questions?** → [FAQ](15-faq.md)
