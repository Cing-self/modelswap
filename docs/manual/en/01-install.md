# 1. Install & Start

## 1.1 Install

**NPM (recommended):**

```bash
npm install -g modelswap
```

**Build from source:**

```bash
git clone https://github.com/Cing-self/modelswap.git
cd modelswap
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

### Desktop app says "damaged and can't be opened"?

macOS shows this misleading message for browser-downloaded, unsigned apps — the app is NOT broken. Clear it (one time only):

```bash
xattr -dr com.apple.quarantine /Applications/ModelSwap.app
```

or System Settings → Privacy & Security → "Open Anyway" at the bottom. This is a known friction of shipping without an Apple developer signature; signing is planned.

## 1.2 Start the web console

```bash
modelswap web              # default port 3780
modelswap web -p 3800      # custom port
modelswap web -o           # open the browser after start
```

The console runs at **http://localhost:3780** by default. If 3780 is taken, ModelSwap automatically tries 3781, 3782… The actual address is printed in the startup log.

> 💡 The browser extension auto-detects ModelSwap's port (tries 3780 and upward), so you normally don't need to care about ports.

## 1.3 Upgrade & uninstall

```bash
modelswap upgrade                          # upgrade to the latest version (npm installs)
npm uninstall -g modelswap  # uninstall
```

> ModelSwap runs no daemon and never sits in the request path: it writes your config and exits — your agent talks to the model provider directly. Agent configs keep working after uninstall.

> ⚠️ **Uninstalling the CLI does not affect the desktop app** (it is fully self-contained). However, `~/.modelswap` is the **shared data directory** for both forms (vault, provider configs, snapshots) — a "full uninstall" that removes `rm -rf ~/.modelswap` also wipes the desktop app's data. To remove just the CLI, `npm uninstall -g` is enough; leave `~/.modelswap` alone.

## 1.4 Desktop updates

The desktop app checks for updates after it starts and refreshes periodically while it is running. You can also check manually from **Check for updates…** in the app menu, or **Settings → About & Diagnostics → Check for updates**.

When an update is available, a download icon appears at the upper left of the desktop window. Hover over it to read the release notes, then click it to download. Once the download is complete, ModelSwap installs the update and relaunches automatically; there is no separate Restart to install step.

> Install the desktop app at `/Applications/ModelSwap.app` when possible. Automatic updates safely replace that app copy; if an update fails, the upper-left icon remains available so you can try again.
