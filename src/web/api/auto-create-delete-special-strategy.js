// Fail-closed provider-specific deletion strategies.
function createSpecialDeleteStrategies(deps) {
  const { execJs, sleep, closeAutomationWindow, foregroundClick, sendCommand } = deps;
async function deleteAnthropicBrowserKey({ createdName, tabId }) {
  const dispatchClick = (el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  let opened = false;
  for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
    const raw = await execJs(`(() => {
      const targetName = ${JSON.stringify(createdName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const rows = [...document.querySelectorAll('tr, [role="row"]')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
      const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(button => /more actions|更多操作|更多/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].filter(Boolean).join(' ')));
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      (${dispatchClick.toString()})(buttons[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    opened = Boolean(state.ok);
    if (!opened) await sleep(500);
  }
  if (!opened) throw new Error(`Anthropic 测试密钥菜单未打开：${createdName}`);

  let deleteItemClicked = false;
  for (let attempt = 0; attempt < 12 && !deleteItemClicked; attempt += 1) {
    const raw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, a')]
        .filter(visible)
        .filter(el => /delete api key|删除 API key|删除密钥/i.test(label(el)));
      if (items.length !== 1) return JSON.stringify({ ok: false, items: items.length });
      (${dispatchClick.toString()})(items[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    deleteItemClicked = Boolean(state.ok);
    if (!deleteItemClicked) await sleep(350);
  }
  if (!deleteItemClicked) throw new Error(`Anthropic 测试密钥删除菜单项未找到：${createdName}`);

  let confirmed = false;
  for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
    const raw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const dialogs = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].filter(visible);
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const controls = dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
        .filter(visible)
        .filter(el => /delete|删除/i.test(label(el)) && !/cancel|取消/i.test(label(el)));
      if (controls.length !== 1) return JSON.stringify({ ok: false, controls: controls.length });
      (${dispatchClick.toString()})(controls[0]);
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let state = {};
    try { state = JSON.parse(raw || '{}'); } catch {}
    confirmed = Boolean(state.ok);
    if (!confirmed) await sleep(350);
  }
  if (!confirmed) throw new Error(`Anthropic 测试密钥删除确认未找到：${createdName}`);

  let remaining = true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const targetName = ${JSON.stringify(createdName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('tr, [role="row"], body *')]
        .some(el => visible(el) && (el.innerText || '').trim() === targetName);
    })()`).catch(() => true);
    if (!remaining) break;
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`Anthropic 删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'anthropic', name: createdName };
}

async function deleteZhipuBrowserKey({ createdName, tabId }) {
  await sleep(2500);
  const rowStateRaw = await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
    if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
    const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .filter(button => String(button.innerText || button.getAttribute('aria-label') || '').trim() === '删除');
    if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
    const rect = buttons[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`).catch(() => '{"ok":false}');
  let rowState = {};
  try { rowState = JSON.parse(rowStateRaw || '{}'); } catch {}
  if (!rowState.ok) throw new Error(`智谱测试密钥删除行不唯一：${createdName}（${rowState.rows ?? rowState.buttons ?? 0}）`);
  let clicked = (await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      const row = [...document.querySelectorAll('tr, [role="row"]')].find(el => (el.innerText || '').includes(target));
      const button = row && [...row.querySelectorAll('button, [role="button"]')].find(el => String(el.innerText || el.getAttribute('aria-label') || '').trim() === '删除');
      if (!button) return false;
      button.click();
      return true;
    })()`).catch(() => false)) === true;
  if (!clicked) clicked = await foregroundClick({ x: rowState.x, y: rowState.y, tabId });
  if (!clicked) throw new Error(`智谱测试密钥删除按钮无法点击：${createdName}`);
  await sleep(500);

  let confirmed = false;
  for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
    const confirmRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], .el-message-box__wrapper')].filter(visible);
      const dialog = dialogs.find(el => (el.innerText || '').includes('此操作将永久删除该行数据')) || dialogs[0];
      if (!dialog) return JSON.stringify({ ok: false, dialogs: 0 });
      const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => String(button.innerText || button.getAttribute('aria-label') || '').trim() === '确定');
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      const rect = buttons[0].getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let confirmState = {};
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch {}
    if (confirmState.ok) {
      confirmed = (await execJs(`(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"], .el-message-box__wrapper')].find(el => (el.innerText || '').includes('此操作将永久删除该行数据'));
          const button = dialog && [...dialog.querySelectorAll('button, [role="button"]')].find(el => String(el.innerText || el.getAttribute('aria-label') || '').trim() === '确定');
          if (!button) return false;
          button.click();
          return true;
        })()`).catch(() => false)) === true;
      if (!confirmed) confirmed = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
    } else if (attempt < 11) {
      await sleep(400);
    }
  }
  if (!confirmed) throw new Error(`智谱测试密钥删除确认未找到：${createdName}`);
  let remaining = true;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      return [...document.querySelectorAll('tr, [role="row"], body *')].some(el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && String(el.innerText || '').trim() === target);
      });
    })()`).catch(() => true);
    if (!remaining) break;
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`智谱删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'zhipu', name: createdName };
}

async function deleteMoonshotBrowserKey({ createdName, tabId }) {
  let rowState = {};
  for (let attempt = 0; attempt < 12 && !rowState.ok; attempt += 1) {
    const rowRaw = await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
    if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
    const buttons = [...rows[0].querySelectorAll('button, [role="button"]')]
      .filter(button => visible(button) && (button.textContent || '').trim() === 'Delete');
    if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
    const rect = buttons[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { rowState = JSON.parse(rowRaw || '{}'); } catch { rowState = {}; }
    if (!rowState.ok) await sleep(500);
  }
  if (!rowState.ok) throw new Error(`Kimi 测试密钥删除行不唯一：${createdName}（${rowState.rows ?? rowState.buttons ?? 0}）`);
  let opened = (await execJs(`(() => {
    const target = ${JSON.stringify(createdName)};
    const visible = el => {
      const rect = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
    };
    const row = [...document.querySelectorAll('tr, [role="row"]')].find(el => visible(el) && (el.innerText || '').includes(target));
    const button = row && [...row.querySelectorAll('button, [role="button"]')]
      .find(el => visible(el) && (el.textContent || '').trim() === 'Delete');
    if (!button) return false;
    button.click();
    return true;
  })()`).catch(() => false)) === true;
  if (!opened) opened = await foregroundClick({ x: rowState.x, y: rowState.y, tabId });
  if (!opened) throw new Error(`Kimi 测试密钥删除按钮无法点击：${createdName}`);
  await sleep(500);

  let confirmState = {};
  for (let attempt = 0; attempt < 15 && !confirmState.ok; attempt += 1) {
    const confirmRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(button => visible(button) && (button.textContent || '').trim() === 'Confirm');
      if (buttons.length !== 1) return JSON.stringify({ ok: false, buttons: buttons.length });
      const rect = buttons[0].getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch { confirmState = {}; }
    if (!confirmState.ok) await sleep(350);
  }
  if (!confirmState.ok) throw new Error(`Kimi 删除确认按钮未找到：${createdName}（候选 ${Number(confirmState.buttons) || 0} 个）`);

  let confirmed = (await execJs(`(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(button => { const r = button.getBoundingClientRect(); const s = getComputedStyle(button); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !button.disabled && (button.textContent || '').trim() === 'Confirm'; });
    if (buttons.length !== 1) return false;
    buttons[0].click();
    return true;
  })()`).catch(() => false)) === true;
  if (!confirmed) confirmed = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
  await sleep(800);

  let remaining = true;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    remaining = await execJs(`(() => {
      const target = ${JSON.stringify(createdName)};
      return [...document.querySelectorAll('tr, [role="row"]')].some(row => {
        const r = row.getBoundingClientRect(); const s = getComputedStyle(row);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && (row.innerText || '').includes(target);
      });
    })()`).catch(() => true);
    if (!remaining) break;
    await sleep(500);
  }
  // The provider can acknowledge the click without dispatching its controlled
  // form action. Retry only while the exact row remains, using the same unique
  // Confirm control and then Enter on that focused control.
  if (remaining) {
    const retryFocus = await execJs(`(() => {
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled && (el.textContent || '').trim() === 'Confirm'; });
      if (!button) return false;
      button.focus();
      return true;
    })()`).catch(() => false);
    if (retryFocus === true || retryFocus === 'true') {
      const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await sendCommand('cdp', { cdpMethod: 'Input.dispatchKeyEvent', cdpParams: enterParams, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => {});
      await sendCommand('cdp', { cdpMethod: 'Input.dispatchKeyEvent', cdpParams: { ...enterParams, type: 'keyUp' }, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => {});
      await sleep(800);
      remaining = await execJs(`(() => {
        const target = ${JSON.stringify(createdName)};
        return [...document.querySelectorAll('tr, [role="row"]')].some(row => (row.innerText || '').includes(target));
      })()`).catch(() => true);
    }
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`Kimi 删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: 'moonshot', name: createdName };
}

  return { deleteAnthropicBrowserKey, deleteZhipuBrowserKey, deleteMoonshotBrowserKey };
}
module.exports = { createSpecialDeleteStrategies };
