"use strict";
/**
 * MODELSWAP clipboard hook — MAIN-world content script.
 *
 * Pages copy API keys with navigator.clipboard.writeText(), which never
 * fires a copy event the isolated-world guard could hear. Wrapping
 * writeText in the page's own world lets us observe button-driven writes
 * and relay them to the isolated content script via postMessage. The write
 * itself proceeds untouched — pages behave exactly as before.
 */
(function () {
    const w = window;
    if (w.__modelswapClipboardHook)
        return;
    w.__modelswapClipboardHook = true;
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function")
        return;
    const original = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => {
        try {
            window.postMessage({ source: "modelswap-clipboard-hook", text: String(text) }, window.location.origin);
        }
        catch {
            // never break the page's copy
        }
        return original(text);
    };
})();
