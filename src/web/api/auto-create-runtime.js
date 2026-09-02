// Browser/extension runtime adapter. Platform strategies receive these atoms
// explicitly instead of owning Chrome or timing globals themselves.
function createAutoCreateRuntime(deps) {
  const { sendCommand, isExtensionConnected, now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = deps;
  async function sleep(ms) {
    const deadline = now() + ms;
    while (now() < deadline) {
      await wait(Math.min(deadline - now(), 5000));
      if (now() < deadline && isExtensionConnected()) {
        try { await sendCommand('exec', { code: '1', workspace: 'modelswap' }, 3000); } catch {}
      }
    }
  }
  async function execJs(code, timeoutMs = 15000) {
    const result = await sendCommand('exec', { code, workspace: 'modelswap' }, timeoutMs);
    if (!result.ok) throw new Error(result.error || 'Browser automation command failed');
    return result.data;
  }
  async function closeAutomationWindow() {
    try { await sendCommand('close-window', { workspace: 'modelswap' }, 5000); } catch {}
  }
  async function focusAutomationWindow() {
    try { return Boolean((await sendCommand('focus-window', { workspace: 'modelswap', hold: true }, 5000)).ok); } catch { return false; }
  }
  async function foregroundClick({ x, y, tabId }) {
    const pointer = { x: Number(x), y: Number(y), button: 'left', buttons: 1, clickCount: 1 };
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
    const focused = await sendCommand('focus-window', { workspace: 'modelswap' }, 5000).catch(() => ({ ok: false }));
    if (!focused.ok) return false;
    await sleep(150);
    const send = (type, params) => sendCommand('cdp', { cdpMethod: 'Input.dispatchMouseEvent', cdpParams: params,
      workspace: 'modelswap', ...(tabId ? { tabId } : {}) }, 5000).catch(() => ({ ok: false }));
    await send('move', { x: pointer.x, y: pointer.y, type: 'mouseMoved', buttons: 0 });
    const pressed = await send('press', { ...pointer, type: 'mousePressed' });
    const released = await send('release', { ...pointer, type: 'mouseReleased', buttons: 0 });
    return Boolean(pressed.ok && released.ok);
  }
  return { sleep, execJs, closeAutomationWindow, focusAutomationWindow, foregroundClick };
}
module.exports = { createAutoCreateRuntime };
