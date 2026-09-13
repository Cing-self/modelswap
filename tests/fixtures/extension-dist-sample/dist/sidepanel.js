/**
 * MODELSWAP side panel entry — the persistent surface. Stays open while the
 * user browses: the pending-request checklist updates live (via
 * chrome.storage events) as captures happen on other tabs.
 */
import { mountPanel } from "./panel-view.js";
mountPanel();
