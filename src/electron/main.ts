import { app, BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions, shell } from "electron";
import { spawn } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";

type StartServer = (port?: number, onStarted?: (actualPort: number) => void) => unknown;

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

/**
 * The browser extension ships INSIDE the desktop app (asarUnpack keeps it on
 * the real filesystem — Chrome cannot load an unpacked extension from inside
 * an asar archive). Revealing copies it to ~/.okit/extension so the path is
 * stable across app updates and matches what `okit extension path` prints on
 * CLI installs; the copy is refreshed on every reveal.
 */
function bundledExtensionDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "extension")
    : path.join(__dirname, "..", "..", "extension");
}

async function revealExtensionInFinder(): Promise<string> {
  const src = bundledExtensionDir();
  if (!(await fs.pathExists(src))) {
    throw new Error(`桌面应用未内置扩展目录: ${src}`);
  }
  const dest = path.join(os.homedir(), ".okit", "extension");
  await fs.remove(dest);
  await fs.copy(src, dest);
  shell.showItemInFolder(path.join(dest, "manifest.json"));
  return dest;
}

/**
 * Install a downloaded update and relaunch. macOS apps keep their code mapped
 * while running, so the swap must happen after this process exits: write a
 * small installer script, run it detached (it waits for the app to quit),
 * then quit. The copy is staged (OKIT.app.new → rename) so a mid-copy failure
 * can never leave /Applications without an app bundle.
 */
async function installUpdateAndRelaunch(dmgPath?: string): Promise<void> {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  // Prefer the newest OKIT dmg in ~/Downloads when the renderer did not pass
  // the exact path (e.g. the user cleared state mid-flow).
  let dmg = dmgPath && path.isAbsolute(dmgPath) ? dmgPath : null;
  if (!dmg || !(await fs.pathExists(dmg))) {
    const candidates = (await fs.readdir(downloadsDir).catch(() => [] as string[]))
      .filter((f) => /^OKIT-[\d.]+-.*\.dmg$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    dmg = candidates[0] ? path.join(downloadsDir, candidates[0].f) : null;
  }
  if (!dmg || !dmg.endsWith(".dmg") || !path.dirname(dmg).startsWith(downloadsDir) || !(await fs.pathExists(dmg))) {
    throw new Error(`未找到下载好的安装包 (在 ${downloadsDir} 中查找 OKIT-*.dmg)`);
  }

  const mountPoint = path.join(os.tmpdir(), "okit-update-mount");
  const scriptPath = path.join(os.tmpdir(), `okit-update-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
# Wait for the running app to release the old bundle before swapping it.
sleep 1
hdiutil attach "${dmg}" -nobrowse -readonly -mountpoint "${mountPoint}" >/dev/null
rm -rf "/Applications/OKIT.app.new"
cp -R "${mountPoint}/OKIT.app" "/Applications/OKIT.app.new"
hdiutil detach "${mountPoint}" >/dev/null || true
rm -rf "/Applications/OKIT.app"
mv "/Applications/OKIT.app.new" "/Applications/OKIT.app"
open -a "/Applications/OKIT.app"
rm -f "${scriptPath}"
`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  // Give the detached script a moment to start before quitting; it sleeps on
  // its own, so quitting immediately is safe too — this just avoids a race
  // where the OS reaps the detached process during teardown.
  setTimeout(() => app.quit(), 150);
  setTimeout(() => app.exit(0), 3000);
}

function createApplicationMenu() {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              // The renderer owns the update flow (check + download UI); the
              // menu item just pokes it so results surface in one place.
              label: "检查更新…",
              click: () => mainWindow?.webContents.send("okit:check-update"),
            },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const fileMenu: MenuItemConstructorOptions[] = isMac
    ? []
    : [
        {
          label: "文件",
          submenu: [{ role: "quit" }],
        },
      ];

  const editMenu: MenuItemConstructorOptions = {
    label: "编辑",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "显示",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "窗口",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  };

  return Menu.buildFromTemplate([...appMenu, ...fileMenu, editMenu, viewMenu, windowMenu]);
}

function startOkitServer(): Promise<number> {
  if (serverPort) return Promise.resolve(serverPort);

  const serverPath = path.join(__dirname, "..", "web", "server.js");
  // The web server is CommonJS and copied into dist/web during the regular build.
  const { startServer } = require(serverPath) as { startServer: StartServer };

  return new Promise((resolve) => {
    startServer(3780, (actualPort) => {
      serverPort = actualPort;
      resolve(actualPort);
    });
  });
}

async function createWindow() {
  const port = await startOkitServer();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    title: "OKIT",
    icon: path.join(__dirname, "..", "web", "public", "okit-icon.png"),
    // On macOS the renderer owns a compact, draggable title surface. Use the
    // same base colour as the sidebar so the window frame never cuts across
    // the content canvas with a different material while it boots.
    backgroundColor: "#fbfaf5",
    ...(process.platform === "darwin" ? {
      // Let the renderer draw the title surface while keeping the familiar
      // macOS close/minimise/zoom controls accessible in that same strip.
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 16, y: 13 },
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${port}`) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.setName("OKIT");
Menu.setApplicationMenu(createApplicationMenu());
ipcMain.handle("okit:reveal-extension", revealExtensionInFinder);
ipcMain.handle("okit:install-update", async (_event, dmgPath?: string) => {
  await installUpdateAndRelaunch(dmgPath);
});

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
