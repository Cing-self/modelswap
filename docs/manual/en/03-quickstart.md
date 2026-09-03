# 3. Ten-Minute Quick Start

From a fresh install to your first model switch in ten minutes.

![The ModelSwap console](../images/quick-start.png)

## 3.1 Install & open

**Desktop app (recommended):** download the dmg from [GitHub Releases](https://github.com/Cing-self/modelswap/releases/latest), drag it into Applications, and open it — the console window appears automatically. If macOS blocks the first launch, follow the steps in [chapter 2](02-install.md) to allow it once.

**CLI:**

```bash
npm install -g modelswap
modelswap web          # opens http://localhost:3780
```

Other install options (build from source) are in [chapter 2](02-install.md).

## 3.2 Store a key

- **Manual**: **Vault → Add** — name it (e.g. `anthropic-api`), paste the value, save
- **Automatic**: **Vault → Auto-create** — the browser extension fills the provider's console and files the key back for you (chapter 5)
- **CLI**: `modelswap vault set anthropic-api` (interactive; `--stdin` keeps secrets out of shell history)

## 3.3 Register & connect a provider

1. **Models** page → click the platform card (e.g. Anthropic)
2. Pick the vault entry as the **key**
3. Click **Connect** — ModelSwap verifies the endpoint and pulls that platform's model list

## 3.4 Switch an agent over

1. **Quick Start** page → pick the agent at the top (e.g. Claude Code)
2. Toggle the provider on
3. Click a model chip — done. ModelSwap writes the agent's config file itself (`config.toml`, `auth.json`, …)

Terminal equivalent:

```bash
modelswap provider use <provider> --agent <agent-id> --model <model-id>
```

Get agent / model ids from `modelswap provider current --json` (see chapter 9 for the full flow).

## 3.5 Verify

```bash
modelswap provider auth --json    # auth state per provider
modelswap provider current        # what each agent resolves right now
```

Then ask the agent a small prompt. If it still uses the old model, the running CLI session cached the old config — restart it (see [FAQ](15-faq.md)).

You've now walked through the core flow. From here, explore what interests you:

- **Key management**: create keys in bulk ([chapters 4–5](04-extension.md))
- **Usage monitoring**: subscription balance queries and alerts ([chapter 8](08-usage.md))
- **Multi-device sync**: end-to-end encrypted sync via iCloud / WebDAV / Cloudflare ([chapter 11](11-sync.md))
- **More agents**: all supported agents and how to switch ([chapter 9](09-agents.md))
