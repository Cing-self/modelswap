import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";
import path from "path";

type StartServer = (port?: number, onStarted?: (actualPort: number) => void) => unknown;

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

function createApplicationMenu() {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
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
    minWidth: 1040,
    minHeight: 720,
    title: "OKIT",
    icon: path.join(__dirname, "..", "web", "public", "okit-icon.png"),
    backgroundColor: "#07100b",
    show: false,
    webPreferences: {
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

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
