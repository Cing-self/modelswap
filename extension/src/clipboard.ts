/**
 * A short-lived, focused extension page used only to read a value that was
 * just copied by the current provider flow. It has no tab, cookie, or WebSocket
 * access. The service worker validates the complete value before returning it.
 */
const requestId = new URLSearchParams(location.search).get('requestId');
let sent = false;

function finish(message: Record<string, unknown>): void {
  if (sent || !requestId) return;
  sent = true;
  void chrome.runtime.sendMessage({ type: 'okit-clipboard-read-result', requestId, ...message });
}

async function readWhenFocused(): Promise<void> {
  if (sent || !requestId) return;
  if (!document.hasFocus()) {
    window.setTimeout(() => { void readWhenFocused(); }, 50);
    return;
  }
  try {
    finish({ text: await navigator.clipboard.readText() });
  } catch (error) {
    finish({ error: error instanceof Error ? error.message : String(error) });
  }
}

window.addEventListener('focus', () => { void readWhenFocused(); });
window.setTimeout(() => { void readWhenFocused(); }, 100);
