/** Submit the already-open generic browser form. */
function createGenericFormStrategy(deps) {
  const { execJs, sendCommand, sleep, foregroundClick, waitForInteractiveVerification } = deps;
  return async function submitGenericBrowserCreate(state) {
    const { platform, run, uniqueName, tabId } = state;
  const nameFillResult = await execJs(`(() => {
    const selectors = ${JSON.stringify(platform.nameSelectors || [
      'input[placeholder*="名称"]',
      'input[placeholder*="Name"]',
      'input[placeholder*="描述"]',
      'input[name*="name" i]',
      'input[id*="name" i]',
    ])};
    const scopes = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]'), document];
    for (const scope of scopes) {
      let input = selectors.map(selector => scope.querySelector(selector)).find(Boolean);
      if (!input && ${Boolean(platform.allowDialogTextInputFallback)}) {
        input = [...scope.querySelectorAll('input, textarea')].find(candidate => {
          const type = (candidate.getAttribute('type') || 'text').toLowerCase();
          const role = (candidate.getAttribute('role') || '').toLowerCase();
          const rect = candidate.getBoundingClientRect();
          return !candidate.disabled && !candidate.readOnly && role !== 'combobox'
            && ['text', ''].includes(type) && rect.width > 0 && rect.height > 0;
        });
      }
      if (!input || input.disabled || input.getBoundingClientRect().width === 0) continue;
      const prototype = input instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(uniqueName)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(uniqueName)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return JSON.stringify({ filled: input.value === ${JSON.stringify(uniqueName)} });
    }
    return JSON.stringify({ filled: false, error: 'no-name-input' });
  })()`).catch(() => '{"filled":false,"error":"fill-failed"}');
  let nameFillState = {};
  try { nameFillState = JSON.parse(nameFillResult || '{}'); } catch {}
  if (platform.nameFillViaInput) {
    const focusName = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.nameSelectors || [])};
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled; };
      const input = selectors.map(selector => document.querySelector(selector)).find(visible);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      if (setter) setter.call(input, ''); else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.select?.();
      return true;
    })()`).catch(() => false);
    if (focusName !== true && focusName !== 'true') throw new Error(`${platform.label || platform.id} 名称输入框无法聚焦`);
    const inserted = await sendCommand('insert-text', { text: uniqueName, workspace: 'okit', ...(tabId ? { tabId } : {}) }, 5000).catch(() => ({ ok: false }));
    if (!inserted.ok) throw new Error(`${platform.label || platform.id} 名称无法通过真实输入提交`);
    await sleep(250);
  }
  if (platform.requireNameInput && !nameFillState.filled) {
    throw new Error(`${platform.label || platform.id} 创建框的密钥名称输入框未识别，尚未提交创建`);
  }

  // Do not misreport a disabled platform prerequisite as a failed click or a
  // possibly-created key. These are explicitly verified, non-secret messages
  // rendered inside the provider's own create form.
  if (platform.formBlockers?.length) {
    const formBlocker = await execJs(`(() => {
      const visibleText = document.body?.innerText || '';
      const blockers = ${JSON.stringify(platform.formBlockers)};
      return JSON.stringify(blockers.find(blocker => visibleText.includes(blocker.text)) || null);
    })()`).catch(() => 'null');
    let blocker;
    try { blocker = JSON.parse(formBlocker || 'null'); } catch {}
    if (blocker?.message) throw new Error(blocker.message);
  }

  // Anthropic 及类似平台有一个 expiration 下拉框需要选一个值才能确认。
  // 选第一个选项(通常是 "No expiration" 或 "1 year")。
  if (platform.preConfirmSelectDefaults?.length) {
    for (const selectConfig of platform.preConfirmSelectDefaults) {
      const openSelectResult = await execJs(`(() => {
        const triggerTexts = ${JSON.stringify(selectConfig.triggerTexts || [selectConfig.triggerText || ''])}.filter(Boolean);
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // Find the currently selected expiration trigger. Anthropic's current
        // Console renders the default preset itself (for example "3 hours")
        // instead of the former "Select an expiration" placeholder.
        const triggers = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]')]
          .filter(visible).concat([document]);
        let trigger = null;
        for (const scope of triggers) {
          const candidates = [...scope.querySelectorAll('button, [role="combobox"], [role="button"], select')]
            .filter(visible)
            .filter(el => triggerTexts.some(text => (el.textContent || '').includes(text) || el.getAttribute('aria-label')?.includes(text)));
          if (candidates.length) { trigger = candidates[0]; break; }
        }
        if (!trigger) return JSON.stringify({ error: 'select-trigger-not-found', triggerTexts });
        // 打开下拉
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"select-open-failed"}');
      let openSelectState = {};
      try { openSelectState = JSON.parse(openSelectResult || '{}'); } catch {}
      if (openSelectState.error && !selectConfig.optional) {
        throw new Error('未找到密钥过期时间选择框');
      }
      if (openSelectState.error) continue;
      await sleep(400);
      const chooseOptionResult = await execJs(`(() => {
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const optionTexts = ${JSON.stringify(selectConfig.optionTexts || [selectConfig.optionText || ''])}.filter(Boolean);
        let option = null;
        if (optionTexts.length) {
          option = [...document.querySelectorAll('[role="option"], li[role="option"], [role="menuitem"]')]
            .filter(visible)
            .find(el => optionTexts.some(text => (el.textContent || '').trim().toLowerCase().includes(text.toLowerCase())));
        }
        if (!option && !optionTexts.length) {
          option = [...document.querySelectorAll('[role="option"], li[role="option"], [role="menuitem"]')]
            .filter(visible)[0];
        }
        if (!option) return JSON.stringify({ error: 'option-not-found' });
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        option.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"option-select-failed"}');
      let chooseOptionState = {};
      try { chooseOptionState = JSON.parse(chooseOptionResult || '{}'); } catch {}
      if (chooseOptionState.error && !selectConfig.optional) {
        throw new Error('未找到期望的密钥过期时间选项');
      }
      await sleep(300);
    }
  }

  // xAI management keys expose one combobox per named endpoint. Select only
  // the configured endpoint and access level; a document-wide "No access"
  // click could silently grant the wrong scope.
  if (platform.rowPermissionDefaults?.length) {
    for (const permission of platform.rowPermissionDefaults) {
      const openPermission = await execJs(`(() => {
        const rowTexts = ${JSON.stringify(permission.rowTexts || [])};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const rows = [...document.querySelectorAll('[role="row"], tr')].filter(row => visible(row) && rowTexts.some(text => (row.innerText || '').includes(text)));
        if (rows.length !== 1) return JSON.stringify({ error: 'permission-row-not-found', rows: rows.length });
        const controls = [...rows[0].querySelectorAll('[role="combobox"], button')].filter(visible);
        const trigger = controls.find(control => control.matches('[role="combobox"]')) || controls[0];
        if (!trigger) return JSON.stringify({ error: 'permission-trigger-not-found' });
        trigger.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"permission-open-failed"}');
      let openPermissionState = {};
      try { openPermissionState = JSON.parse(openPermission || '{}'); } catch {}
      if (openPermissionState.error) throw new Error(`未找到 xAI ${permission.rowTexts?.join('、') || '权限'} 选择框`);
      await sleep(300);
      const choosePermission = await execJs(`(() => {
        const options = ${JSON.stringify(permission.optionTexts || [])};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const candidates = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, [data-radix-collection-item]')]
          .filter(visible)
          .filter(el => options.some(text => (el.innerText || '').trim().toLowerCase().includes(String(text).toLowerCase())));
        if (candidates.length !== 1) return JSON.stringify({ error: 'permission-option-not-found', candidates: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"error":"permission-select-failed"}');
      let choosePermissionState = {};
      try { choosePermissionState = JSON.parse(choosePermission || '{}'); } catch {}
      if (choosePermissionState.error) throw new Error(`未找到 xAI ${permission.optionTexts?.join('、') || '权限级别'} 选项`);
      await sleep(300);
    }
  }

  // Kimi's form requires an explicit project. Choosing a different project
  // would change the scope of the created credential, so only the provider's
  // visible `default` project is eligible for automatic selection.
  if (platform.defaultProjectLabel) {
    const openProject = await execJs(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .find(el => el.getBoundingClientRect().width > 0) || document;
      const input = dialog.querySelector('input[role="combobox"]');
      if (!input) return JSON.stringify({ error: 'project-select-not-found' });
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.click();
      return JSON.stringify({ ok: true });
    })()`);
    let projectOpenState = {};
    try { projectOpenState = JSON.parse(openProject || '{}'); } catch {}
    if (projectOpenState.error) throw new Error('未找到 Kimi 项目选择框');

    await sleep(300);
    const selectProject = await execJs(`(() => {
      const label = ${JSON.stringify(platform.defaultProjectLabel)}.toLowerCase();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const options = [...document.querySelectorAll('[role="option"], .ant-select-item-option')]
        .filter(visible);
      const option = options.find(el => {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return text === label || text.startsWith(label + ' ');
      });
      if (!option) return JSON.stringify({ error: 'default-project-not-found', options: options.map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60)) });
      const rect = option.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`);
    let projectSelectState = {};
    try { projectSelectState = JSON.parse(selectProject || '{}'); } catch {}
    if (projectSelectState.error) {
      throw new Error(`未找到 Kimi 默认项目：${(projectSelectState.options || []).join('、') || platform.defaultProjectLabel}`);
    }
    // React's Ant Design select ignores synthetic element.click() in this
    // console. Dispatch a real CDP mouse gesture at the verified option.
    if (!Number.isFinite(projectSelectState.x) || !Number.isFinite(projectSelectState.y)) {
      throw new Error('无法定位 Kimi 默认项目的位置');
    }
    const projectMouseParams = {
      x: projectSelectState.x,
      y: projectSelectState.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    };
    const projectClicked = await foregroundClick({
      x: projectMouseParams.x,
      y: projectMouseParams.y,
      tabId,
    });
    if (!projectClicked) {
      throw new Error('无法选择 Kimi 默认项目');
    }
    await sleep(300);
    const projectAlreadyConfirmed = await execJs(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
        || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
      const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
        .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
      return Boolean(button && !button.disabled);
    })()`).catch(() => false);
    if (projectAlreadyConfirmed === true || projectAlreadyConfirmed === 'true') {
      await sleep(150);
    } else {
    // The option list can remain visually open after the mouse gesture, or
    // close without updating the controlled value. Re-focus the same
    // combobox, verify that it still exposes exactly the configured `default`
    // option, then commit it with real keyboard events and verify that the
    // provider enabled the final OK button.
    const focusProjectRaw = await execJs(`(() => {
      const input = document.querySelector('input[role="combobox"]');
      if (!input) return JSON.stringify({ ok: false });
      input.focus();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const listOpen = [...document.querySelectorAll('[role="listbox"]')].some(visible);
      const rect = input.getBoundingClientRect();
      return JSON.stringify({ ok: true, listOpen, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let focusProject = {};
    try { focusProject = JSON.parse(focusProjectRaw || '{}'); } catch {}
    if (!focusProject.ok) throw new Error('无法重新聚焦 Kimi 默认项目选择框');
    if (!focusProject.listOpen && Number.isFinite(focusProject.x) && Number.isFinite(focusProject.y)) {
      const projectOpenMouse = { x: focusProject.x, y: focusProject.y, button: 'left', buttons: 1, clickCount: 1 };
      const openPressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...projectOpenMouse, type: 'mousePressed' },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000);
      const openReleased = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...projectOpenMouse, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000);
      if (!openPressed.ok || !openReleased.ok) throw new Error('无法打开 Kimi 默认项目选择框');
    }
    await sleep(700);
    let projectOptionCount = 0;
    let projectOptionCoords = null;
    for (let optionAttempt = 0; optionAttempt < 2 && projectOptionCount !== 1; optionAttempt += 1) {
      const projectOptionRaw = await execJs(`(() => {
      const label = ${JSON.stringify(platform.defaultProjectLabel)}.toLowerCase();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const matches = [...document.querySelectorAll('[role="option"], .ant-select-item-option')]
        .filter(visible)
        .filter(el => {
          const text = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
          return text === label || text.startsWith(label + ' ');
        });
      if (matches.length !== 1) return JSON.stringify({ count: matches.length });
      const rect = matches[0].getBoundingClientRect();
      return JSON.stringify({ count: 1, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      })()`).catch(() => '{"count":0}');
      let projectOptionState = {};
      try { projectOptionState = JSON.parse(projectOptionRaw || '{}'); } catch {}
      projectOptionCount = Number(projectOptionState.count) || 0;
      projectOptionCoords = Number.isFinite(projectOptionState.x) && Number.isFinite(projectOptionState.y)
        ? { x: projectOptionState.x, y: projectOptionState.y }
        : null;
      if (projectOptionCount === 1) break;
      if (Number.isFinite(focusProject.x) && Number.isFinite(focusProject.y)) {
        const retryOpenMouse = { x: focusProject.x, y: focusProject.y, button: 'left', buttons: 1, clickCount: 1 };
        await sendCommand('cdp', {
          cdpMethod: 'Input.dispatchMouseEvent',
          cdpParams: { ...retryOpenMouse, type: 'mousePressed' },
          workspace: 'okit',
          ...(tabId ? { tabId } : {}),
        }, 5000);
        await sendCommand('cdp', {
          cdpMethod: 'Input.dispatchMouseEvent',
          cdpParams: { ...retryOpenMouse, type: 'mouseReleased', buttons: 0 },
          workspace: 'okit',
          ...(tabId ? { tabId } : {}),
        }, 5000);
        await sleep(700);
      }
    }
    // The earlier live scan already verified exactly one `default` option. A
    // provider rerender may unmount that option after the mouse gesture; in
    // that case still use the focused keyboard commit and rely on the final
    // enabled-OK check below. Abort only if a second project becomes visible.
    if (Number(projectOptionCount) > 1) throw new Error(`Kimi 默认项目选择项发生变化（找到 ${Number(projectOptionCount)} 个），未创建 API Key`);
    let projectCommittedByMouse = false;
    if (projectOptionCoords) {
      projectCommittedByMouse = await foregroundClick({ ...projectOptionCoords, tabId });
      if (projectCommittedByMouse) {
        await sleep(350);
        projectCommittedByMouse = await execJs(`(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
            || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
          const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
            .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
          return Boolean(button && !button.disabled);
        })()`).catch(() => false);
      }
    }
    if (!projectCommittedByMouse) {
    await sendCommand('focus-window', { workspace: 'okit' }, 5000).catch(() => ({ ok: false }));
    await sleep(150);
    const keyParams = { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 };
    const keyDown = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: keyParams,
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const keyUp = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: { ...keyParams, type: 'keyUp' },
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    const enterDown = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: enterParams,
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    const enterUp = await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchKeyEvent',
      cdpParams: { ...enterParams, type: 'keyUp' },
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 5000);
    if (!keyDown.ok || !keyUp.ok || !enterDown.ok || !enterUp.ok) {
      throw new Error('无法提交 Kimi 默认项目选择');
    }
    await sleep(300);
    const projectConfirmed = await execJs(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const dialog = dialogs.find(el => el.querySelector('input[role="combobox"], input[placeholder*="Maximum 32"]'))
        || dialogs.find(el => [...el.querySelectorAll('button, [role="button"]')].some(button => String(button.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase()));
      const button = [...(dialog || document).querySelectorAll('button, [role="button"]')]
        .find(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase());
      return Boolean(button && !button.disabled);
    })()`).catch(() => false);
    if (projectConfirmed !== true && projectConfirmed !== 'true') {
      const projectDebug = await execJs(`(() => JSON.stringify({
        comboboxes: [...document.querySelectorAll('input[role="combobox"]')].map(input => ({
          value: input.value || '',
          ariaExpanded: input.getAttribute('aria-expanded') || '',
          selected: input.parentElement?.parentElement?.innerText || '',
        })).slice(0, 3),
        selectedItems: [...document.querySelectorAll('.ant-select-selection-item, [class*="select-selection-item"]')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => (el.textContent || '').trim()).slice(0, 6),
        okButtons: [...document.querySelectorAll('button, [role="button"]')]
          .filter(el => String(el.textContent || '').replace(/[\\s\\u3000]+/g, '').toLowerCase() === String(${JSON.stringify((platform.confirmTexts || ['OK'])[0])}).replace(/[\\s\\u3000]+/g, '').toLowerCase())
          .map(el => ({ disabled: Boolean(el.disabled), ariaDisabled: el.getAttribute('aria-disabled') || '', className: el.className || '' })),
      }))()`).catch(() => '{}');
      console.log(`[auto-create] moonshot: project commit diagnostics ${JSON.stringify({ projectConfirmed, projectDebug })}`);
      throw new Error(`Kimi 默认项目未提交，未创建 API Key（诊断 ${projectDebug}）`);
    }
    }
    }
  }

  // Some management-key consoles expose a permission-policy selector during
  // AccessKey creation. When a platform explicitly requests a preset, select
  // it before the final confirmation and fail closed if the selector or policy
  // cannot be located. This is intentionally opt-in; ordinary API keys never
  // receive guessed permissions.
  if (platform.permissionDefaults) {
    const permissionConfig = platform.permissionDefaults;
    const permissionOpenRaw = await execJs(`(() => {
      const triggerTexts = ${JSON.stringify(permissionConfig.triggerTexts || [])};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const controls = [...document.querySelectorAll('button, [role="button"], [role="combobox"], input')].filter(visible);
      const target = controls.find(el => {
        const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' '));
        return triggerTexts.some(text => label === normalize(text) || label.includes(normalize(text)));
      });
      if (!target) return JSON.stringify({ error: 'permission-trigger-not-found' });
      target.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"error":"permission-trigger-failed"}');
    let permissionOpenState = {};
    try { permissionOpenState = JSON.parse(permissionOpenRaw || '{}'); } catch {}
    if (permissionOpenState.error) throw new Error('未找到火山引擎权限策略选择框，未创建 AK/SK');
    await sleep(350);
    const permissionSelectRaw = await execJs(`(() => {
      const optionTexts = ${JSON.stringify(permissionConfig.optionTexts || [])};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const options = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, label, button')].filter(visible);
      const target = options.find(el => {
        const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
        return optionTexts.some(text => label === normalize(text) || label.includes(normalize(text)));
      });
      if (!target) return JSON.stringify({ error: 'permission-option-not-found' });
      target.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"error":"permission-option-failed"}');
    let permissionSelectState = {};
    try { permissionSelectState = JSON.parse(permissionSelectRaw || '{}'); } catch {}
    if (permissionSelectState.error) throw new Error('未找到火山引擎 AdministratorAccess 权限策略，未创建 AK/SK');
    await sleep(350);
  }

	  await sleep(500);
	  if (platform.captureBeforeConfirm) {
	    await execJs(`(() => {
	      if (window.__okitPreConfirmCapture?.armed) return 'already-armed';
	      const state = window.__okitPreConfirmCapture = { armed: true, clipboard: '', dom: [], responses: [] };
	      const rememberDom = value => {
	        const text = String(value || '');
	        if (text && !state.dom.includes(text)) state.dom.push(text.slice(0, 20000));
	        if (state.dom.length > 30) state.dom.shift();
	      };
	      const scan = () => {
	        const root = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="modal"]')]
	          .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
	        if (!root) return;
	        for (const el of root.querySelectorAll('input, textarea, code, [data-clipboard-text], [data-key]')) {
	          rememberDom(el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || el.textContent || '');
	        }
	        rememberDom(root.innerText || '');
	      };
	      state.timer = setInterval(scan, 40);
	      setTimeout(() => clearInterval(state.timer), 15000);
	      try {
	        if (navigator.clipboard?.writeText) {
	          const original = navigator.clipboard.writeText.bind(navigator.clipboard);
	          const wrapped = text => { state.clipboard = String(text || ''); return original(text); };
	          try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
	        }
	      } catch {}
	      try {
	        const originalFetch = window.fetch.bind(window);
	        window.fetch = async (...args) => {
	          const response = await originalFetch(...args);
	          const request = args[0];
	          const url = typeof request === 'string' ? request : (request?.url || '');
	          const method = String(args[1]?.method || request?.method || 'GET').toUpperCase();
	          response.clone().text().then(body => {
	            state.responses.push({ url, method, status: response.status, body: body.slice(0, 250000) });
	          }).catch(() => {});
	          return response;
	        };
	      } catch {}
	      try {
	        const originalOpen = XMLHttpRequest.prototype.open;
	        const originalSend = XMLHttpRequest.prototype.send;
	        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
	          this.__okitMethod = String(method || 'GET').toUpperCase();
	          this.__okitUrl = String(url || '');
	          return originalOpen.call(this, method, url, ...rest);
	        };
	        XMLHttpRequest.prototype.send = function(...args) {
	          this.addEventListener('load', () => {
	            let body = '';
	            try { body = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''; } catch {}
	            state.responses.push({ url: this.__okitUrl || '', method: this.__okitMethod || 'GET', status: this.status, body: body.slice(0, 250000) });
	          }, { once: true });
	          return originalSend.apply(this, args);
	        };
	      } catch {}
	      scan();
	      return 'armed';
	    })()`).catch(() => 'capture-arm-failed');
	  }
	  if (!platform.creationActionOnly) {
    const confirmOptions = {
          phrases: platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'],
          allowGenericInsideScope: true,
          belowNameInputBonus: Boolean(platform.confirmAfterNameInput),
        };
        confirmCollection: for (;;) {
        const confirmCollectRaw = await execJs(`(() => {
          const confirmSelectors = ${JSON.stringify(platform.confirmSelectors || [])};
          const nameSelectors = ${JSON.stringify(platform.nameSelectors || [])};
          const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="sheet"]';
          const visible = el => {
            const r = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
          };
          const visibleEnabled = el => {
            if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            const className = typeof el.className === 'string' ? el.className : '';
            return !/(^|\s)(?:[^\s]*button[^\s]*disabled|disabled)(?:\s|$)/i.test(className);
          };
          const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();

          const nameInput = nameSelectors.map(selector => document.querySelector(selector)).find(visible);
          const nameRect = nameInput ? nameInput.getBoundingClientRect() : null;
          const actionPhrases = ${JSON.stringify(platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'])};
          const actionMatches = el => {
            const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
            return actionPhrases.some(phrase => {
              const expected = normalize(phrase);
              return expected && (label === expected || label.startsWith(expected));
            });
          };

          const securityDialog = [...document.querySelectorAll(dialogSelectors)]
            .filter(visible)
            .find(dialog => /身份验证|安全验证|短信验证码|微信扫码验证|MFA|使用其他校验方式/i.test(dialog.innerText || ''));
          if (securityDialog) {
            return JSON.stringify({ securityVerification: true, securityText: (securityDialog.innerText || '').trim().slice(0, 240) });
          }

          // Verified scope: the form around the name input, else the dialog holding
          // it, else a visible dialog. The whole document is only acceptable when
          // the platform ships explicit confirm selectors to pin the target down.
          let scope = null;
          if (nameInput) {
            scope = nameInput.closest(dialogSelectors) || nameInput.closest('form');
            let scopeControls = scope ? [...scope.querySelectorAll('button, [role="button"]')].filter(visibleEnabled) : [];
            const scopeHasAction = controls => controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
              try { return control.matches(selector); } catch { return false; }
            }));
            if (!scopeHasAction(scopeControls) && ${Boolean(platform.inlineFormScope)}) {
              for (let ancestor = nameInput.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                const ancestorControls = [...ancestor.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
                if (!scopeHasAction(ancestorControls)) continue;
                scope = ancestor;
                scopeControls = ancestorControls;
                break;
              }
            }
            if (!scopeHasAction(scopeControls)) scope = null;
          }
          if (!scope) {
            const dialogCandidates = [...document.querySelectorAll(dialogSelectors)].filter(visible);
            scope = dialogCandidates.find(dialog => {
              const controls = [...dialog.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
              return controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
                try { return control.matches(selector); } catch { return false; }
              }));
            }) || dialogCandidates[0] || null;
          }
          if (!scope && confirmSelectors.length) scope = document;
          const hasScope = Boolean(scope);

          const matchSelectors = [...confirmSelectors, 'button[type="submit"]'];
          const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
          const descriptors = controls.map((el, index) => {
            const rect = el.getBoundingClientRect();
            const inScope = hasScope && (scope === document || scope === el || scope.contains(el));
            let selectorMatch = false;
            for (const selector of matchSelectors) {
              try { if (el.matches(selector)) { selectorMatch = true; break; } } catch { /* unselectable selector */ }
            }
            selectorMatch = selectorMatch && inScope;
            return {
              index,
              text: (el.textContent || '').trim().slice(0, 120),
              ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
              title: (el.title || '').trim().slice(0, 120),
              inVerifiedScope: inScope,
              selectorMatch,
              belowNameInput: Boolean(nameRect && rect.top >= nameRect.bottom - 4),
            };
          });
          return JSON.stringify({
            hasScope,
            nameFound: Boolean(nameInput),
            descriptors,
            buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16),
          });
        })()`);
        let confirmCollect = {};
        try { confirmCollect = JSON.parse(confirmCollectRaw || '{}'); } catch { confirmCollect = {}; }

        if (confirmCollect.securityVerification) {
          if (!run) throw new Error(`${platform.label || platform.id} 创建密钥需要完成控制台安全验证，自动化已停止，未创建或保存密钥`);
          await waitForInteractiveVerification({ run, platform, stage: 'confirm-action' });
          continue confirmCollection;
        }

        // Fail closed unless a verified scope exists. Without a scope the browser
        // never guessed at a confirm target, so nothing may be clicked.
        if (!confirmCollect.hasScope) {
          throw new Error('创建对话框需要补充项目、计费或权限设置后再确认：没有定位到表单或弹窗作用域');
        }
        const scopedCandidates = (confirmCollect.descriptors || []).filter(d => d.inVerifiedScope);
        const confirmSelected = resolveActionCandidate(scopedCandidates, confirmOptions);
        if (!confirmSelected) {
          const diagnostics = scopedCandidates
            .map(c => ({ raw: (c.text || '').slice(0, 40), aria: (c.ariaLabel || '').slice(0, 40), selector: Boolean(c.selectorMatch), belowName: Boolean(c.belowNameInput), score: scoreActionCandidate(c, confirmOptions) }))
            .slice(-12);
          throw new Error(`创建对话框需要补充项目、计费或权限设置后再确认：${(confirmCollect.buttons || []).join('、') || '未找到可确认的目标'}（候选诊断 ${JSON.stringify(diagnostics)}）`);
        }

        // Re-find the same control within the verified scope by index only after
        // its normalized text/aria/title fingerprint is unchanged. The scope is
        // recomputed and must still exist and contain the target — document-wide
        // scope is acceptable only because explicit confirmSelectors exist. When
        // the Node-selected descriptor relied on selector evidence, the live
        // element must still match a configured confirm selector or
        // button[type=submit]. Any drift aborts without clicking.
        const confirmFingerprint = descriptorFingerprint(confirmSelected);
        const expectConfirmSelector = Boolean(confirmSelected.selectorMatch);
        const confirmClickRaw = await execJs(`(() => {
          const confirmSelectors = ${JSON.stringify(platform.confirmSelectors || [])};
          const nameSelectors = ${JSON.stringify(platform.nameSelectors || [])};
          const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="sheet"]';
          const visible = el => {
            const r = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
          };
          const visibleEnabled = el => {
            if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            const className = typeof el.className === 'string' ? el.className : '';
            return !/(^|\s)(?:[^\s]*button[^\s]*disabled|disabled)(?:\s|$)/i.test(className);
          };
          const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const slice = value => String(value == null ? '' : value).trim().slice(0, 120);
          const nameInput = nameSelectors.map(selector => document.querySelector(selector)).find(visible);
          const actionPhrases = ${JSON.stringify(platform.confirmTexts || ['确定', '确认', '创建', '保存', 'Create', 'Confirm', 'Save', 'Generate'])};
          const actionMatches = el => {
            const label = normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
            return actionPhrases.some(phrase => {
              const expected = normalize(phrase);
              return expected && (label === expected || label.startsWith(expected));
            });
          };
          let scope = null;
          if (nameInput) {
            scope = nameInput.closest(dialogSelectors) || nameInput.closest('form');
            let scopeControls = scope ? [...scope.querySelectorAll('button, [role="button"]')].filter(visibleEnabled) : [];
            const scopeHasAction = controls => controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
              try { return control.matches(selector); } catch { return false; }
            }));
            if (!scopeHasAction(scopeControls) && ${Boolean(platform.inlineFormScope)}) {
              for (let ancestor = nameInput.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
                const ancestorControls = [...ancestor.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
                if (!scopeHasAction(ancestorControls)) continue;
                scope = ancestor;
                scopeControls = ancestorControls;
                break;
              }
            }
            if (!scopeHasAction(scopeControls)) scope = null;
          }
          if (!scope) {
            const dialogCandidates = [...document.querySelectorAll(dialogSelectors)].filter(visible);
            scope = dialogCandidates.find(dialog => {
              const controls = [...dialog.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
              return controls.some(control => actionMatches(control) || confirmSelectors.some(selector => {
                try { return control.matches(selector); } catch { return false; }
              }));
            }) || dialogCandidates[0] || null;
          }
          if (!scope && confirmSelectors.length) scope = document;
          // Abort unless a scope exists. document scope is only ever assigned
          // above when explicit confirmSelectors exist, which is the only case
          // where a document-wide click is acceptable.
          if (!scope) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-gone' });

          // Some controlled Ant buttons are rendered through more than one
          // portal while the project selector commits. In that state a global
          // button index can point at a stale portal even though the visible
          // form is ready. Platforms may opt into an exact, current-scope
          // lookup so the verified visible action itself receives the click.
          if (${Boolean(platform.confirmByExactText)}) {
            const currentScopes = [...document.querySelectorAll(dialogSelectors)]
              .filter(visible)
              .filter(candidate => {
                const hasName = nameSelectors.length === 0 || nameSelectors.some(selector => {
                  try { return [...candidate.querySelectorAll(selector)].some(visible); } catch { return false; }
                });
                const hasAction = [...candidate.querySelectorAll('button, [role="button"]')]
                  .some(control => visibleEnabled(control) && actionMatches(control));
                return hasName && hasAction;
              });
            // React may keep earlier portal nodes mounted while the newest
            // dialog is being committed. The last visible matching portal is
            // the one the user-facing UI exposes.
            const currentScope = currentScopes.at(-1) || scope;
            const container = currentScope === document ? document : currentScope;
            const compact = value => normalize(value).replace(/[\s\u3000]+/g, '');
            const exactCandidates = [...container.querySelectorAll('button, [role="button"]')]
              .filter(visibleEnabled)
              .filter(control => {
                const label = [control.textContent, control.getAttribute('aria-label'), control.getAttribute('title')]
                  .filter(Boolean).join(' ');
                return actionPhrases.some(phrase => {
                  const expected = compact(phrase);
                  const actual = compact(label);
                  return expected && (actual === expected || actual.startsWith(expected));
                });
              });
            if (exactCandidates.length !== 1) {
              return JSON.stringify({ error: 'confirm-mismatch', reason: 'exact-target-count', count: exactCandidates.length });
            }
            const target = exactCandidates[0];
            if (${Boolean(platform.confirmNeedsForeground)}) {
              const rect = target.getBoundingClientRect();
              return JSON.stringify({ ok: true, foreground: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }
            target.click();
            return JSON.stringify({ ok: true, foreground: false, exact: true });
          }

          const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
          const targetIndex = ${confirmSelected.index};
          const expected = ${JSON.stringify(confirmFingerprint)};
          const target = controls[targetIndex];
          if (!target) return JSON.stringify({ error: 'confirm-mismatch', reason: 'index-gone' });
          // The recomputed scope must still contain the approved target.
          if (scope !== document && !scope.contains(target)) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-changed' });
          const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
            .map(normalize).join('|');
          if (actual !== expected) return JSON.stringify({ error: 'confirm-mismatch', reason: 'fingerprint-changed' });
          // Selector evidence must still hold when it chose the target.
          if (${expectConfirmSelector}) {
            let stillMatches = false;
            for (const selector of [...confirmSelectors, 'button[type="submit"]']) {
              try { if (target.matches(selector)) { stillMatches = true; break; } } catch { /* unselectable selector */ }
            }
            if (!stillMatches) return JSON.stringify({ error: 'confirm-mismatch', reason: 'selector-gone' });
          }
          if (${Boolean(platform.confirmNeedsForeground)}) {
            const rect = target.getBoundingClientRect();
            return JSON.stringify({ ok: true, foreground: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }
          target.click();
          return JSON.stringify({ ok: true, foreground: false });
        })()`);
        let confirmState = {};
        try { confirmState = JSON.parse(confirmClickRaw || '{}'); } catch { confirmState = {}; }
        if (confirmState.error) throw new Error('创建对话框需要补充项目、计费或权限设置后再确认：确认按钮在点击前发生变化');
        if (confirmState.foreground) {
          const clicked = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
          if (!clicked) throw new Error('无法点击创建对话框中的确认按钮');
        }
        if (platform.confirmKeyboardFallback) {
          // Kimi's controlled Ant button can ignore a trusted mouse gesture
          // while its project field is committing. Only send Enter when the
          // same create form is still visibly open and no one-time result
          // field exists, which avoids submitting twice after a successful
          // click.
          await sleep(900);
          const formStillOpen = await execJs(`(() => {
            const confirmLabels = ${JSON.stringify(platform.confirmTexts || ['OK'])};
            const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
            const isConfirm = button => confirmLabels.some(label => normalize(button.textContent) === normalize(label));
            const result = [...document.querySelectorAll('input, textarea')]
              .some(input => /^sk-[A-Za-z0-9_-]{40,}$/.test(input.value || ''));
            const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
              .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (${Boolean(platform.confirmForceKeyboardFallback)} || el.querySelector('input[role="combobox"]')); })
              .at(-1);
            const ok = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
              .find(button => isConfirm(button) && !button.disabled);
            return Boolean(!result && ok);
          })()`).catch(() => false);
          if (formStillOpen === true || formStillOpen === 'true') {
            const focusButton = await execJs(`(() => {
              const dialog = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (${Boolean(platform.confirmForceKeyboardFallback)} || el.querySelector('input[role="combobox"]')); })
                .at(-1);
              const confirmLabels = ${JSON.stringify(platform.confirmTexts || ['OK'])};
              const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
              const button = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
                .find(candidate => confirmLabels.some(label => normalize(candidate.textContent) === normalize(label)) && !candidate.disabled);
              if (!button) return JSON.stringify({ ok: false });
              button.focus();
              return JSON.stringify({ ok: true });
            })()`).catch(() => '{"ok":false}');
            let focusButtonState = {};
            try { focusButtonState = JSON.parse(focusButton || '{}'); } catch {}
            if (focusButtonState.ok) {
              const enterParams = { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
              await sendCommand('cdp', {
                cdpMethod: 'Input.dispatchKeyEvent',
                cdpParams: enterParams,
                workspace: 'okit',
                ...(tabId ? { tabId } : {}),
              }, 5000);
              await sendCommand('cdp', {
                cdpMethod: 'Input.dispatchKeyEvent',
                cdpParams: { ...enterParams, type: 'keyUp' },
                workspace: 'okit',
                ...(tabId ? { tabId } : {}),
              }, 5000);
            }
          }
        }
        break confirmCollection;
        }
  }
    return state;
  };
}

module.exports = { createGenericFormStrategy };
