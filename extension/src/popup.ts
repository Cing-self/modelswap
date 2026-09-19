/**
 * MODELSWAP popup entry — thin wrapper around the shared panel view.
 * The popup is the quick-access surface: grab the clipboard, save, go.
 */

import { mountPanel } from "./panel-view.js";
import { applyOpenMode } from "./open-mode.js";

mountPanel();

// One-click handoff to the side panel — the persistent surface that stays
// open while the user navigates to the provider console. sidePanel.open()
// MUST run inside the click's synchronous gesture: awaiting
// windows.getCurrent() first consumes the gesture and the call silently
// fails. So cache the windowId at mount and open synchronously on click.
// Requires Chrome 116+; hide the launcher on older browsers.
void (async () => {
  const btn = document.getElementById("open-sidepanel");
  if (!btn) return;
  const api = (chrome as unknown as { sidePanel?: { open: (opts: { windowId: number }) => Promise<void> } }).sidePanel;
  if (!api || typeof api.open !== "function") {
    btn.hidden = true;
    return;
  }
  let cachedWindowId: number | undefined;
  try {
    const win = await chrome.windows.getCurrent();
    cachedWindowId = win.id;
  } catch {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", () => {
    if (cachedWindowId === undefined) return;
    api.open({ windowId: cachedWindowId })
      .then(async () => {
        // 记住上次使用形态：清掉 default_popup 后，下次点工具栏图标直接开
        // 侧边栏。必须等写入完成再关弹窗——弹窗销毁会掐断在途异步调用。
        await applyOpenMode("side");
        window.close();
      })
      .catch((e) => {
        console.warn("[MODELSWAP] sidePanel.open failed:", e);
      });
  });
})();
