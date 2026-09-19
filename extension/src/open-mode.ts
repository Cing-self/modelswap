/**
 * Open-mode memory — which surface the toolbar icon opens: the popup or the
 * side panel. The mode is persisted in chrome.storage.local and re-applied on
 * every service-worker wake (setPanelBehavior / setPopup are per-session
 * browser state).
 *
 * Manifest-declared default_popup outranks setPanelBehavior: the popup must
 * be cleared via chrome.action.setPopup for the icon click to reach the side
 * panel at all.
 */

export type OpenMode = "popup" | "side";
export const OPEN_MODE_KEY = "openMode";

export async function applyOpenMode(mode: OpenMode): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode === "side" });
  await chrome.action.setPopup({ popup: mode === "side" ? "" : "popup.html" });
  await chrome.storage.local.set({ openMode: mode });
}

export async function applyStoredOpenMode(): Promise<void> {
  try {
    const { openMode } = await chrome.storage.local.get(OPEN_MODE_KEY);
    await applyOpenMode(openMode === "side" ? "side" : "popup");
  } catch (error) {
    console.warn("[MODELSWAP] applyStoredOpenMode failed:", error);
  }
}
