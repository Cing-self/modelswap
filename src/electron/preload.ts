import { contextBridge, ipcRenderer } from "electron";

/**
 * Bridge between the sandboxed renderer and desktop-only capabilities.
 * `window.modelswapDesktop` only exists inside the Electron app — the web console
 * served to a browser has no such object, which is how the UI gates
 * desktop-only affordances (update install, revealing the bundled extension
 * folder).
 */
contextBridge.exposeInMainWorld("modelswapDesktop", {
  revealExtension: (): Promise<string> => ipcRenderer.invoke("modelswap:reveal-extension"),
  // Runs the DMG swap script in the main process; the app quits itself, so
  // the promise normally never resolves (the renderer goes down with it).
  installUpdate: (dmgPath?: string): Promise<void> => ipcRenderer.invoke("modelswap:install-update", dmgPath),
  // App-menu "检查更新" — re-dispatched as a window event so the shared
  // useAppUpdate hook (titlebar + settings) can run its check + toasts.
  onCheckUpdate: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("modelswap:check-update", listener);
    return () => ipcRenderer.removeListener("modelswap:check-update", listener);
  },
});
