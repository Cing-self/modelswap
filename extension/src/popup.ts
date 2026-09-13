/**
 * MODELSWAP popup entry — thin wrapper around the shared panel view.
 * The popup is the quick-access surface: grab the clipboard, save, go.
 */

import { mountPanel } from "./panel-view.js";

mountPanel();

// One-click handoff to the side panel — the persistent surface that stays
// open while the user navigates to the provider console. Requires Chrome
// 116+ for sidePanel.open; hide the launcher on older browsers.
void (async () => {
  const btn = document.getElementById("open-sidepanel");
  if (!btn) return;
  const api = (chrome as unknown as { sidePanel?: { open: (opts: { windowId: number }) => Promise<void> } }).sidePanel;
  if (!api || typeof api.open !== "function") {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", () => {
    void chrome.windows.getCurrent().then((win) => {
      if (win.id !== undefined) void api.open({ windowId: win.id });
    });
  });
})();
