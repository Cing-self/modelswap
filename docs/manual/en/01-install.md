# 1. Install & Start

## 1.1 Install

**NPM (recommended):**

```bash
npm install -g @cing-self/okit-cli
```

**Script install:**

```bash
curl -fsSL https://raw.githubusercontent.com/Cing-self/okit/refs/heads/main/install.sh | bash
```

**Build from source:**

```bash
git clone https://github.com/Cing-self/okit.git
cd okit
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

## 1.2 Start the web console

```bash
okit web              # default port 3780
okit web -p 3800      # custom port
okit web -o           # open the browser after start
```

The console runs at **http://localhost:3780** by default. If 3780 is taken, OKIT automatically tries 3781, 3782… The actual address is printed in the startup log.

> 💡 The browser extension auto-detects OKIT's port (tries 3780 and upward), so you normally don't need to care about ports.

## 1.3 Upgrade & uninstall

```bash
okit upgrade                          # upgrade to the latest version (npm installs)
npm uninstall -g @cing-self/okit-cli  # uninstall
```

> OKIT runs no daemon and never sits in the request path: it writes your config and exits — your agent talks to the model provider directly. Agent configs keep working after uninstall.
