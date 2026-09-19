/**
 * MODELSWAP side panel entry — the persistent surface. Stays open while the
 * user browses: the pending-request checklist updates live (via
 * chrome.storage events) as captures happen on other tabs.
 */

import { mountPanel } from "./panel-view.js";
import { applyOpenMode } from "./open-mode.js";

mountPanel();

// 记住上次使用形态的另一半：在侧边栏点「切换到弹窗」后，下次点工具栏
// 图标回到弹窗。Chrome 没有程序化关闭侧边栏的 API，当前面板由用户点 X 收起。
const popupBtn = document.getElementById("open-popup");
if (popupBtn) {
  popupBtn.addEventListener("click", () => {
    void applyOpenMode("popup");
  });
}
