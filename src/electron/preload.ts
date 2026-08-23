import { contextBridge, ipcRenderer } from "electron";

/**
 * Bridge between the sandboxed renderer and desktop-only capabilities.
 * `window.okitDesktop` only exists inside the Electron app — the web console
 * served to a browser has no such object, which is how the UI gates
 * desktop-only affordances (e.g. revealing the bundled extension folder).
 */
contextBridge.exposeInMainWorld("okitDesktop", {
  revealExtension: (): Promise<string> => ipcRenderer.invoke("okit:reveal-extension"),
});
