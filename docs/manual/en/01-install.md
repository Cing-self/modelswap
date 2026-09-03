# 1. Install & Start

ModelSwap comes in two forms — the **CLI** (macOS / Linux / Windows, also serves the web console) and the **desktop app** (the same console in a native window, with the browser extension built in). Pick one; both share the same data directory.

## 1.1 Install the CLI

Two ways to get the CLI:

- **npm (recommended):**

  ```bash
  npm install -g modelswap
  modelswap web        # sanity check: opens http://localhost:3780
  ```

- **Build from source:**

  ```bash
  git clone https://github.com/Cing-self/modelswap.git
  cd modelswap
  npm ci --ignore-scripts
  npm run build
  node dist/main.js web
  ```

The CLI includes the web console and the agent skill, and works on all three platforms.

## 1.2 Install the desktop app (macOS only, so far)

The desktop app currently supports **macOS only** (Apple Silicon + Intel). On Windows / Linux, install the CLI instead — see 1.1.

Download the dmg for your Mac from the GitHub release, drag ModelSwap into Applications, and open it:

| Version | Download | SHA-256 |
|---------|----------|---------|
| Apple Silicon (M1/M2/M3/M4+) | [ModelSwap-1.0.57-arm64.dmg](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-arm64.dmg) | [sha256](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-arm64.dmg.sha256) |
| Intel | [ModelSwap-1.0.57-x64.dmg](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-x64.dmg) | [sha256](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-x64.dmg.sha256) |

Newer versions: [all releases](https://github.com/Cing-self/modelswap/releases). Once installed, the desktop app updates itself (see 1.4), so the dmg mostly matters for the first install.

**macOS blocks the first launch?**

If you get a "can't be opened" warning (wording varies — "App is damaged", "unidentified developer") — the app is fine, macOS just hasn't verified it yet. Allow it once:

1. Open **System Settings → Privacy & Security**
2. Click **Open Anyway** at the bottom

On launch the app is ready to use: it starts its own server (http://127.0.0.1:3780) and shows the console window; the browser extension lives inside it too (**Settings → Browser Plugins → Open extension folder**).

## 1.3 Start the web console

One console, two ways to open it: start it with the CLI, or just launch the desktop app.

```bash
modelswap web              # default port 3780
modelswap web -p 3800      # custom port
modelswap web -o           # open the browser after start
```

The console runs at **http://localhost:3780** by default. If 3780 is taken, ModelSwap automatically tries 3781, 3782… The actual address is printed in the startup log.

> 💡 The browser extension auto-detects ModelSwap's port (tries 3780 and upward), so you normally don't need to care about ports.

## 1.4 Update: CLI vs desktop

**CLI (npm installs):**

```bash
modelswap upgrade          # upgrade to the latest version
```

**Desktop app:** updates are checked on start and refreshed periodically while it runs. When a new version is available, a download icon appears at the upper left of the window — hover it for release notes, click to download, and the app installs and relaunches automatically (no separate "restart to install" step). Manual checks: app menu → **Check for updates…**, or **Settings → About & Diagnostics → Check for updates**.

> Install the desktop app at `/Applications/ModelSwap.app`; automatic updates safely replace that copy. If an update fails, the upper-left icon stays so you can retry.

## 1.5 Uninstall

**CLI only:** `npm uninstall -g modelswap`. **Desktop only:** drag `/Applications/ModelSwap.app` to the Trash.

> ⚠️ The CLI and the desktop app **share** `~/.modelswap` (vault, provider configs, snapshots) — deleting it also wipes the desktop app's data. Removing just one form: leave `~/.modelswap` alone.
>
> ModelSwap runs no daemon and never sits in the request path: it writes your config and exits — your agent talks to the model provider directly. Agent configs keep working after uninstall.
