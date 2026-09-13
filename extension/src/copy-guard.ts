/**
 * MODELSWAP copy-guard — content script.
 *
 * Watches for copy events on ordinary web pages and forwards secret-shaped
 * text to the service worker, which matches it against pending vault
 * requests (agent-issued via `modelswap vault request`). This script must
 * stay self-contained: content scripts under this build (plain tsc, no
 * bundler) cannot be ES modules, so it declares no imports/exports.
 *
 * Privacy contract:
 *   - Copies originating from password fields are never captured.
 *   - Text that fails the cheap shape pre-filter never leaves this script.
 *   - Nothing is sent anywhere except chrome.runtime (the local extension).
 */

(function () {
  const MAX_TEXT = 4096;

  /** Cheap shape gate — the service worker does the real matching. */
  function looksCaptureWorthy(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 6 || trimmed.length > MAX_TEXT) return false;
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    if (lines.length > 1) {
      // Multi-line: only `field: value` template shapes, ≤ 8 lines.
      if (lines.length > 8) return false;
      return lines.every((l) => /^[\w.-]{1,64}\s*[:=]\s*\S{1,1024}$/.test(l));
    }
    const single = lines[0];
    if (/\s/.test(single)) return false;
    return single.length >= 12 && /^[A-Za-z0-9_\-.=+/]+$/.test(single);
  }

  /** True when the current selection lives inside a password field. */
  function selectionInPasswordField(sel: Selection): boolean {
    const node = sel.anchorNode;
    const el =
      node && node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node && node.parentElement
          ? node.parentElement
          : null;
    if (!el || typeof (el as Element).closest !== "function") return false;
    return el.closest('input[type="password"]') !== null;
  }

  document.addEventListener(
    "copy",
    () => {
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (selectionInPasswordField(sel)) return; // passwords are never captured
        const text = sel.toString();
        if (!looksCaptureWorthy(text)) return;
        const sending = chrome.runtime.sendMessage({
          type: "modelswap-copy",
          text,
          url: location.href,
          title: document.title,
          ts: Date.now(),
        });
        // MV3 returns a promise; swallow "extension context invalidated" etc.
        if (sending && typeof (sending as Promise<void>).catch === "function") {
          (sending as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Never break the page's own copy behavior.
      }
    },
    true, // capture phase — see the copy before page handlers
  );
})();
