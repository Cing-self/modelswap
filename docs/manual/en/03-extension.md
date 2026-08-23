# 3. Browser Extension Setup (prerequisite for auto-create)

The **OKIT** extension (MV3) reuses your logged-in Chrome sessions: it fills forms in the provider's own console, creates the key, copies it, and files it back into the encrypted vault — everything happens only between your browser and your machine.

## 3.1 Get the extension

**npm / script installs**: no need to build it yourself. Run the command below to get the extension directory (binary installs automatically materialize it to `~/.okit/extension`), then load that directory as described in 3.2:

```bash
okit extension path    # prints a loadable extension directory
```

**Building from source**: the extension source lives in `extension/`; build the `dist/` directory first:

```bash
cd extension
npm install
npm run build        # tsc compile → extension/dist/
```

## 3.2 Load into Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the extension ROOT directory that contains `manifest.json` — npm / script installs pick the path printed by `okit extension path`, source users pick the repo's `extension/` directory (after building `dist/`). Not the `dist` subdirectory itself.

The extension list should now show "OKIT".

## 3.3 Verify the connection

1. Start OKIT (`okit web`)
2. The extension probes ports 3780–3785 in order, locks onto the first OKIT server that answers, and connects over WebSocket (authenticated with a one-time token) — it keeps working when OKIT falls back to 3781+
3. A line like `[WS] Extension hello: v2.x.x protocol=...` in the OKIT log means connected
4. You can also check the extension status under **Vault → Auto-create**

## 3.4 Permissions (important)

The extension requests `debugger`, `tabs`, `cookies` and related permissions, so Chrome shows a **"OKIT started debugging this browser"** banner — **this is expected**: the debugger channel is how the extension reads pages and performs clicks. Debugging happens only between your local OKIT and your browser; nothing is sent to any external server.

## 3.5 Updating the extension

- After extension code changes: run `npm run build` again, then click 🔄 on the extension card in `chrome://extensions/`
- If `manifest.json` `permissions` changed: you must **remove the extension → load unpacked again**; a plain reload is not enough
