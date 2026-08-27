/** Read and recover the one-time secret after a generic browser create. */
function createGenericResultStrategy(deps) {
  const { execJs, sendCommand, sleep, keyFromText, extractKeyFromCaptures, closeAutomationWindow, describeCapturedSecretFields, capturesContainMaskedSecret } = deps;
  return async function readGenericBrowserCreateResult(state) {
    const { platform, uniqueName, tabId } = state;
	  if (platform.captureBeforeConfirm) {
	    await sleep(300);
	    const preCaptureRaw = await execJs(`(() => JSON.stringify(window.__okitPreConfirmCapture || {}))()`).catch(() => '{}');
	    let preCapture = {};
	    try { preCapture = JSON.parse(preCaptureRaw || '{}'); } catch {}
	    const clipboardKey = keyFromText(preCapture.clipboard || '', platform);
	    const domKey = keyFromText((preCapture.dom || []).join('\n'), platform);
	    const responseEntries = (preCapture.responses || []).map(item => ({
	      url: item.url,
	      method: item.method,
	      responseStatus: item.status,
	      responsePreview: item.body,
	    }));
	    const responseKey = keyFromText(extractKeyFromCaptures(responseEntries, platform.id), platform);
	    const capturedKey = clipboardKey || responseKey || domKey;
	    if (capturedKey) {
	      await closeAutomationWindow();
	      return { value: capturedKey, name: uniqueName };
	    }
	  }

	  // Some consoles (including Mistral) put the one-time secret directly into
  // an input in their success dialog. Read that short-lived field before the
  // potentially slow full network-capture read; otherwise the dialog can be
  // gone before we inspect its value.
  const readDomKey = async () => {
    const domText = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.postCreateKeySelectors || [])};
      const fields = selectors.length
        ? [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
        : [...document.querySelectorAll('input, textarea, [data-clipboard-text], [data-key]')];
      // Read values from input/textarea elements
      const values = fields
        .map(el => el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || '');
      // Also read textContent from selector-matched elements (some platforms
      // put the key in a span/code rather than an input)
      const textContents = selectors.length
        ? fields.map(el => (el.textContent || '').trim()).filter(Boolean)
        : [];
      // Always include the dialog/body innerText as fallback — some platforms
      // show the key in a success toast or notification, not in a form field.
      const dialogText = (document.querySelector('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="toast"], [class*="notification"]')?.innerText) || '';
      return [values.join('\\n'), textContents.join('\\n'), dialogText, selectors.length ? '' : (document.body.innerText || '')].join('\\n');
    })()`).catch(() => '');
    return keyFromText(domText, platform);
  };

  const domReadAttempts = Math.max(1, Number(platform.postCreateDomReadAttempts) || 1);
  let immediateDomKey = null;
  for (let attempt = 0; attempt < domReadAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 500 : 350);
    immediateDomKey = await readDomKey();
    if (immediateDomKey) break;
  }
  // A few consoles reveal the secret only after the user clicks Copy. Install
  // a capture hook before invoking only the explicitly verified post-create
  // Copy action below. The value is returned only to the vault flow and is
  // never logged.
  const hasPostCreateCopy = Boolean(platform.postCreateCopyTexts?.length || platform.postCreateRowCopySelector || platform.postCreateCopyByMaskedKeyPrefix);
  if (hasPostCreateCopy) {
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      window.__okitCopyCaptureInfo = { source: '', length: 0, clipboardHooked: false, clipboardWriteHooked: false, execHooked: false };
      const capture = (value, source) => {
        const text = String(value || '');
        if (!text) return;
        window.__okitCapturedKey = text;
        window.__okitCopyCaptureInfo.source = source;
        window.__okitCopyCaptureInfo.length = text.length;
      };
      const captureSelectedControl = (control, source) => {
        if (!control || typeof control.value !== 'string') return;
        const start = Number.isFinite(control.selectionStart) ? control.selectionStart : 0;
        const end = Number.isFinite(control.selectionEnd) ? control.selectionEnd : control.value.length;
        capture(control.value.slice(start, end) || control.value, source);
      };
      try {
        if (navigator.clipboard?.writeText) {
          const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
          const wrappedWriteText = function(text) {
            capture(text, 'clipboard.writeText');
            return originalWriteText(text);
          };
          // Most Chromium builds accept the instance override. Some expose a
          // non-writable instance slot, so fall back to the Clipboard
          // prototype without ever querying the system clipboard.
          try { navigator.clipboard.writeText = wrappedWriteText; } catch {}
          if (navigator.clipboard.writeText !== wrappedWriteText) {
            try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
          if (navigator.clipboard.writeText !== wrappedWriteText) {
            try { Object.defineProperty(Object.getPrototypeOf(navigator.clipboard), 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
          window.__okitCopyCaptureInfo.clipboardHooked = navigator.clipboard.writeText === wrappedWriteText;
        }
      } catch {}
      try {
        if (navigator.clipboard?.write) {
          const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
          const wrappedWrite = function(items) {
            // Clipboard.write may receive a ClipboardItem instead of a plain
            // string. Inspect only the text item supplied by this page action;
            // do not call Clipboard.read or Clipboard.readText.
            for (const item of (items || [])) {
              if (!item?.types?.includes?.('text/plain')) continue;
              item.getType('text/plain').then(blob => blob.text()).then(text => capture(text, 'clipboard.write')).catch(() => {});
            }
            return originalWrite(items);
          };
          try { navigator.clipboard.write = wrappedWrite; } catch {}
          if (navigator.clipboard.write !== wrappedWrite) {
            try { Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: wrappedWrite }); } catch {}
          }
          if (navigator.clipboard.write !== wrappedWrite) {
            try { Object.defineProperty(Object.getPrototypeOf(navigator.clipboard), 'write', { configurable: true, value: wrappedWrite }); } catch {}
          }
          window.__okitCopyCaptureInfo.clipboardWriteHooked = navigator.clipboard.write === wrappedWrite;
        }
      } catch {}
      try {
        const originalExecCommand = document.execCommand.bind(document);
        document.execCommand = function(command) {
          if (String(command).toLowerCase() === 'copy') {
            // Libraries that implement Copy with a temporary <input> or
            // <textarea> do not populate window.getSelection(). Read only the
            // selection that this page has just made, never the system
            // clipboard. This keeps the capture scoped to the provider action.
            const active = document.activeElement;
            const selected = window.getSelection()?.toString() || '';
            capture(selected, 'document-selection');
            if (!selected) captureSelectedControl(active, 'active-control');
          }
          return originalExecCommand(command);
        };
        window.__okitCopyCaptureInfo.execHooked = document.execCommand !== originalExecCommand;
      } catch {}
      // Copy-helper libraries commonly select a short-lived input
      // and invoke the browser's native copy routine. Record that value when
      // it is selected, rather than reading any external clipboard state.
      for (const Prototype of [window.HTMLInputElement?.prototype, window.HTMLTextAreaElement?.prototype]) {
        if (!Prototype?.select || Prototype.__okitCopyHooked) continue;
        try {
          const originalSelect = Prototype.select;
          Prototype.select = function(...args) {
            captureSelectedControl(this, 'control-select');
            return originalSelect.apply(this, args);
          };
          Object.defineProperty(Prototype, '__okitCopyHooked', { value: true });
        } catch {}
      }
      document.addEventListener('copy', () => {
        const selected = window.getSelection()?.toString() || '';
        capture(selected, 'copy-event-selection');
        if (!selected) captureSelectedControl(document.activeElement, 'copy-event-control');
      }, true);
      // Some UI libraries populate event.clipboardData in their own Copy
      // handler. Capture it during bubbling, after that handler has run. This
      // observes only the provider's current copy event and never reads the
      // system clipboard.
      document.addEventListener('copy', (event) => {
        capture(event.clipboardData?.getData('text/plain') || '', 'copy-event-data');
      });
      return 'capture-ready';
    })()`).catch(() => {});
  }

  const requiresCopyCapture = Boolean(platform.requirePostCreateCopy);
  if (immediateDomKey && !requiresCopyCapture) {
    await closeAutomationWindow();
    return { value: immediateDomKey, name: uniqueName };
  }

  const copyAttempts = Math.max(0, Number(platform.postCreateCopyAttempts) || 0);
  for (let attempt = 0; attempt < copyAttempts; attempt += 1) {
    const retryDelay = Math.max(100, Number(platform.postCreateCopyRetryMs) || 500);
    await sleep(attempt === 0 ? 350 : retryDelay);
    const copyResult = await execJs(`(() => {
      const texts = ${JSON.stringify(platform.postCreateCopyTexts || [])};
      const rowCopySelector = ${JSON.stringify(platform.postCreateRowCopySelector || '')};
      const maskedKeyPrefix = ${JSON.stringify(platform.postCreateCopyByMaskedKeyPrefix || '')};
      const createdName = ${JSON.stringify(uniqueName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      let copyAction = null;
      if (rowCopySelector) {
        // Z.AI masks the API key cell but exposes a verified SVG copy icon in
        // that same row. Scope the click to the name we just created so an
        // unrelated existing credential can never be copied or saved.
        const createdRow = [...document.querySelectorAll('tr')]
          .find(row => (row.innerText || '').includes(createdName));
        const copyIcon = createdRow?.querySelector(rowCopySelector);
        // Z.AI binds its handler directly to the SVG. Clicking its decorative
        // wrapping span produces a pointer event but does not invoke the
        // provider's copy action, leaving the old clipboard value in place.
        copyAction = copyIcon?.closest('button, a, [role="button"]') || copyIcon || null;
      } else if (maskedKeyPrefix) {
        // Xiaomi's Token Plan list shows the newly-created key in a masked
        // paragraph and exposes two icon-only buttons in the same row. Only
        // the row's classified Copy icon may be clicked; the Reset button must
        // never be clicked automatically, and an ambiguous or iconless row is
        // left untouched.
        // The configured prefix is a literal provider marker (currently
        // tp-), so it is intentionally not treated as a regular expression.
        const escapedPrefix = maskedKeyPrefix;
        const maskedPattern = new RegExp('^' + escapedPrefix + '[A-Za-z0-9_-]{2,}\\\\*{3,}[A-Za-z0-9_-]*$');
        const createdRow = [...document.querySelectorAll('tr, [role="row"]')]
          .find(row => (row.innerText || '').includes(createdName));
        const searchRoot = createdRow || document;
        const keyNode = [...searchRoot.querySelectorAll('p, span, div, td')]
          .filter(visible)
          .map(el => ({ el, text: (el.textContent || '').trim() }))
          .filter(item => maskedPattern.test(item.text))
          .sort((a, b) => a.text.length - b.text.length)[0]?.el;
        const classifyIcon = ${XIAOMI_ICON_CLASSIFY_JS};
        let row = keyNode;
        for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
          const buttons = [...row.querySelectorAll('button, a, [role="button"]')].filter(visible);
          if (!buttons.length) continue;
          const copyButtons = buttons.filter(btn => {
            const label = [btn.textContent, btn.getAttribute('aria-label'), btn.getAttribute('title')]
              .filter(Boolean).join(' ').trim().toLowerCase();
            const textCopy = ${JSON.stringify(platform.postCreateCopyTexts || [])}
              .some(text => label === String(text).toLowerCase() || label.includes(String(text).toLowerCase()));
            return textCopy || classifyIcon(btn) === 'copy';
          });
          if (copyButtons.length === 1) {
            copyAction = copyButtons[0];
            break;
          }
          if (copyButtons.length > 1) break;
        }
      } else {
        copyAction = [...document.querySelectorAll('button, a, [role="button"]')]
          .filter(visible)
          .sort((a, b) => Number(Boolean(b.closest('[role="dialog"], [role="alertdialog"]'))) - Number(Boolean(a.closest('[role="dialog"], [role="alertdialog"]'))))
          .find(el => {
            const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
              .filter(Boolean).join(' ').trim().toLowerCase();
            return texts.some(text => label === text.toLowerCase() || label.includes(text.toLowerCase()));
          });
      }
      if (!copyAction || !visible(copyAction)) {
        return JSON.stringify({ clicked: false, rowFound: Boolean(rowCopySelector && [...document.querySelectorAll('tr')].some(row => (row.innerText || '').includes(createdName))) });
      }
      if (rowCopySelector) {
        const rect = copyAction.getBoundingClientRect();
        // Z.AI's React handler is attached to the clickable wrapper around
        // the SVG. Invoke that verified same-row action once before the
        // foregrounded CDP pointer event below; the latter remains the
        // trusted-input fallback for builds that ignore synthetic clicks.
        const clickTarget = copyAction.parentElement || copyAction;
        try {
          clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          clickTarget.click?.();
        } catch {}
        return JSON.stringify({
          clicked: Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0,
          rowFound: true,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        });
      }
      const rect = copyAction.getBoundingClientRect();
      copyAction.click();
      return JSON.stringify({
        clicked: rect.width > 0 && rect.height > 0,
        rowFound: true,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    })()`).catch(() => '{}');
    let copyState = {};
    try { copyState = JSON.parse(copyResult || '{}'); } catch {}
    if (!copyState.clicked) {
      console.log(`[auto-create] ${platform.id}: created-row copy action not ready (row found: ${Boolean(copyState.rowFound)})`);
      continue;
    }
    if (platform.postCreateRowCopySelector) {
      // The Z.AI list copy icon handles only trusted user input. Dispatch real
      // DevTools mouse events instead of Element.click(), using coordinates
      // calculated from the exact row created by this attempt.
      const pointer = { x: Number(copyState.x), y: Number(copyState.y), button: 'left', buttons: 1, clickCount: 1 };
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
        console.log(`[auto-create] ${platform.id}: created-row copy control had no usable coordinates`);
        continue;
      }
      // Clipboard writes triggered by a real pointer event are permitted only
      // when the provider page's window is foregrounded. The automation window
      // deliberately stays in the background for normal navigation, so bring
      // it forward only for this exact verified Copy action.
      const focused = await sendCommand('focus-window', {
        workspace: 'okit',
      }, 5000).catch(() => ({ ok: false }));
      if (!focused.ok) {
        console.log(`[auto-create] ${platform.id}: could not foreground copy window`);
        continue;
      }
      await sleep(150);
      const pressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mousePressed' },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      const released = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit',
        ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      if (!pressed.ok || !released.ok) {
        console.log(`[auto-create] ${platform.id}: created-row copy pointer dispatch failed`);
        continue;
      }
    } else if (platform.postCreateCopyNeedsForeground) {
      const pointer = { x: Number(copyState.x), y: Number(copyState.y), button: 'left', buttons: 1, clickCount: 1 };
      if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) continue;
      const focused = await sendCommand('focus-window', { workspace: 'okit' }, 5000).catch(() => ({ ok: false }));
      if (!focused.ok) continue;
      await sleep(150);
      const pressed = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mousePressed' },
        workspace: 'okit', ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      const released = await sendCommand('cdp', {
        cdpMethod: 'Input.dispatchMouseEvent',
        cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
        workspace: 'okit', ...(tabId ? { tabId } : {}),
      }, 5000).catch(() => ({ ok: false }));
      if (!pressed.ok || !released.ok) continue;
    }
    if (platform.allowExtensionClipboardRead) {
      // The copy UI may use Chrome's native clipboard path, which cannot be
      // observed from page JavaScript. The extension only returns the value
      // if the entire clipboard text matches this platform's key format.
      await sleep(500);
      const clipboardRead = await sendCommand('clipboard-read', {
        workspace: 'okit',
        clipboardPattern: platform.keyPatterns?.[0] || '',
        clipboardAllowSurrounding: platform.id === 'zai-global',
      }, 5000).catch((error) => ({ ok: false, data: {}, error: error?.message || String(error) }));
      const clipboardDiag = clipboardRead.ok
        ? { matched: Boolean(clipboardRead.data?.matched), length: Number(clipboardRead.data?.length) || 0 }
        : { matched: false, length: 0, error: String(clipboardRead.error || 'read-failed').slice(0, 120) };
      console.log(`[auto-create] ${platform.id}: extension clipboard ${JSON.stringify(clipboardDiag)}`);
      const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched
        ? clipboardRead.data.value
        : '';
      const clipboardKey = keyFromText(clipboardValue, platform);
      if (clipboardKey) {
        await closeAutomationWindow();
        return { value: clipboardKey, name: uniqueName };
      }
    }
    // Clipboard APIs are asynchronous in some consoles. The interceptor above
    // records only the text supplied by this explicit provider Copy action; it
    // never reads the user's system clipboard.
    await sleep(250);
    const copiedText = await execJs('window.__okitCapturedKey || ""').catch(() => '');
    const captureInfo = await execJs(`(() => JSON.stringify({
      source: window.__okitCopyCaptureInfo?.source || '',
      length: Number(window.__okitCopyCaptureInfo?.length) || 0,
      clipboardHooked: Boolean(window.__okitCopyCaptureInfo?.clipboardHooked),
      clipboardWriteHooked: Boolean(window.__okitCopyCaptureInfo?.clipboardWriteHooked),
      execHooked: Boolean(window.__okitCopyCaptureInfo?.execHooked),
    }))()`).catch(() => '{}');
    console.log(`[auto-create] ${platform.id}: created-row copy capture ${captureInfo}`);
    const copiedKey = keyFromText(copiedText, platform);
    if (copiedKey) {
      await closeAutomationWindow();
      return { value: copiedKey, name: uniqueName };
    }
    // A provider may mount the one-time result dialog only after its Copy
    // action has resolved. Re-read the exact configured result selectors here
    // instead of assuming the DOM was ready before the first copy click.
    const copiedDomKey = await readDomKey();
    if (copiedDomKey) {
      await closeAutomationWindow();
      return { value: copiedDomKey, name: uniqueName };
    }
    // A few copy controls request the secret from the provider and copy it
    // without using a patchable Clipboard API. The capture is armed before
    // creation, so inspect only the responses produced by this creation/copy
    // flow as a fallback. Validation still rejects masked values.
    const copyNetwork = await sendCommand('network-capture-read', {
      workspace: 'okit',
      ...(tabId ? { tabId } : {}),
    }, 10000).catch(() => ({ ok: false, data: [] }));
    const copyEntries = copyNetwork.ok ? (copyNetwork.data || []) : [];
    const networkKey = keyFromText(extractKeyFromCaptures(copyEntries, platform.id), platform);
    if (networkKey) {
      await closeAutomationWindow();
      return { value: networkKey, name: uniqueName };
    }
    if (copyEntries.length) {
      console.log(`[auto-create] ${platform.id}: created-row copy network responses ${copyEntries.length}`);
    }
  }
  if (requiresCopyCapture) {
    throw new Error(platform.postCreateCopyFailureMessage || '创建成功页未能通过 Copy 按钮读取一次性明文；为避免保存非密钥内容，已停止保存。');
  }

  // Some consoles create the credential first and render its one-time secret
  // a few seconds later. Keep reading the same creation attempt rather than
  // submitting again, which would create duplicate keys.
  // A provider config that omits an explicit retry budget must still tolerate
  // the shared CDP response-body race. Keep at least three reads for every
  // generic flow; a successful key returns immediately and no second create
  // action is ever submitted.
  const readAttempts = Math.max(3, Number(platform.postCreateReadAttempts) || 0);
  const entries = [];
  for (let attempt = 0; attempt < readAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 2500 : 1500);
    const read = await sendCommand('network-capture-read', { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || '无法读取创建结果');
    entries.push(...(read.data || []));

    const captured = extractKeyFromCaptures(entries, platform.id);
    const capturedKey = keyFromText(captured, platform);
    if (captured && !capturedKey) {
      // Do not log the candidate. Its length and validation result are enough
      // to diagnose a provider format change without leaking a credential.
      console.log(`[auto-create] ${platform.id}: captured key-shaped value rejected by platform pattern (length ${captured.length})`);
      if (platform.id === 'moonshot') {
        console.log(`[auto-create] moonshot: rejected candidate shape ${JSON.stringify({
          length: captured.length,
          startsWithSk: captured.startsWith('sk-'),
          hasSpace: /\s/.test(captured),
          hasMask: /[*…]|\.{3}/.test(captured),
          asciiOnly: /^[\x00-\x7F]+$/.test(captured),
        })}`);
        console.log(`[auto-create] moonshot: captured credential fields ${JSON.stringify(describeCapturedSecretFields(entries))}`);
      }
    }
    if (capturedKey) {
      await closeAutomationWindow();
      return { value: capturedKey, name: uniqueName };
    }

    const domKey = await readDomKey();
    if (domKey) {
      await closeAutomationWindow();
      return { value: domKey, name: uniqueName };
    }
  }

  const secretDiagnostics = describeCapturedSecretFields(entries);
  if (platform.maskedSecretMessage && capturesContainMaskedSecret(entries)) {
    throw new Error(platform.maskedSecretMessage);
  }
  if (secretDiagnostics.length) {
    console.log('[auto-create] safe secret-field diagnostics', JSON.stringify(secretDiagnostics));
  }
  // DOM 诊断:把当前页面的按钮、弹窗、URL 信息输出到错误信息里
  const diag = await execJs(`(() => {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const keyPatterns = ${JSON.stringify(platform.keyPatterns || [])};
    const redact = value => {
      let text = String(value || '');
      for (const source of keyPatterns) {
        try { text = text.replace(new RegExp(source, 'g'), '[REDACTED]'); } catch {}
      }
      return text;
    };
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible).map(el => (el.textContent || '').trim().slice(0, 50)).filter(Boolean).slice(0, 20);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]')].filter(visible).map(el => redact((el.textContent || '').trim()).slice(0, 200));
    const inputs = [...document.querySelectorAll('input')].filter(visible).map(el => ({ type: el.type, placeholder: el.placeholder, value: el.value ? '(has value)' : '(empty)' })).slice(0, 10);
    return JSON.stringify({ url: location.href.slice(-80), title: document.title.slice(0, 60), buttons, dialogs, inputs });
  })()`).catch(() => '{}');
  throw new Error(`密钥可能已创建，但未能读取一次性明文（已抓取 ${entries.length} 条请求）。页面诊断: ${diag}。请在自动化窗口复制密钥后手动保存。`);
  };
}

module.exports = { createGenericResultStrategy };
