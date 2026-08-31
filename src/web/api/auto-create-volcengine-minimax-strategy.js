// Provider-specific browser strategies. All Chrome/runtime capabilities are injected.
function createVolcengineMinimaxStrategy(deps) {
  const { sendCommand, execJs, sleep, closeAutomationWindow, foregroundClick, detectLoginRequired, detectInteractiveVerification, waitForInteractiveVerification, detectVolcengineLoginSurface, isAssetData, extractKeyFromCaptures, describeCapturedResponses, describeCapturedSecretFields, describeMinimaxBackendResults, VOLC_URL, VOLC_AGENT_PLAN_URL, VOLC_CREATE_TEXTS, MINIMAX_URL, MINIMAX_CREATE_TEXTS } = deps;
async function createVolcengineKey({ tokenName, url = VOLC_URL, run }) {
  // Platform names must be unique. Keep the vault variable deterministic while
  // using a harmless suffix only for the console-side display name.
  const nameSuffix = Date.now().toString(36).slice(-4);
  const requestedName = `${tokenName}-${nameSuffix}`;
  const uniqueName = requestedName;
  const nav = await sendCommand('navigate', { url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const tabId = nav.data && nav.data.tabId;
  console.log('[auto-create] volcengine: navigated (tab ' + tabId + ')');

  // Ark renders a public shell with a visible “登录” action instead of
  // redirecting to /login. Detect that state before searching for the create
  // button so a signed-out account becomes a resumable login handoff rather
  // than a misleading “create button missing” failure.
  const loginState = await detectLoginRequired();
  if (loginState.loginRequired || await detectVolcengineLoginSurface()) {
    throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
  }

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] volcengine: capture armed');

  // Ark is an SPA. Poll its explicit create action rather than assuming a
  // fixed load time, so an expired session is not misreported as a click bug.
  let opened = false;
  for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
    const currentLoginState = await detectLoginRequired();
    if (currentLoginState.loginRequired || await detectVolcengineLoginSurface()) {
      throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
    }
    if (await detectInteractiveVerification('volcengine')) {
      await waitForInteractiveVerification({ run, platform: { id: 'volcengine', label: '火山引擎' }, stage: 'before-create' });
    }
    const result = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => ${JSON.stringify(VOLC_CREATE_TEXTS)}.includes((el.textContent || '').trim().replace(/\s+/g, ' ')));
      if (!button) return JSON.stringify({ error: 'create-not-found' });
      button.click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{}');
    try { opened = Boolean(JSON.parse(result || '{}').ok); } catch {}
    if (!opened) await sleep(1000);
  }
  if (!opened) {
    if (await detectVolcengineLoginSurface()) {
      throw new Error(`需要登录火山引擎${url === VOLC_AGENT_PLAN_URL ? ' Agent Plan' : ''}`);
    }
    if (url === VOLC_AGENT_PLAN_URL) {
      const currentUrl = await execJs('location.href').catch(() => '');
      if (/\/subscription\/agent-plan(?:[/?#]|$)/.test(currentUrl)) {
        throw new Error('当前账号被火山方舟重定向到 Agent Plan 套餐页，说明 Agent Plan 尚未开通、已失效或权益尚未生效。请先开通或续费 Agent Plan，待套餐生效后再自动创建专属 API Key。');
      }
    }
    throw new Error('未找到火山方舟“创建 API Key”按钮');
  }

  if (await detectInteractiveVerification('volcengine')) {
    await waitForInteractiveVerification({ run, platform: { id: 'volcengine', label: '火山引擎' }, stage: 'create-action' });
  }
  await sleep(500);
  const formResult = await execJs(`(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    // The Ark modal contains several nested elements whose generated class
    // names include "dialog". Selecting the last such element can scope us
    // below the input. Locate the visible form control globally, but require
    // the provider's visible label/default name so the global page search box
    // is never chosen.
    const inputs = [...document.querySelectorAll('input')]
      .filter(el => visible(el) && !el.disabled);
    const input = inputs.find(el => /名称|name/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')))
      || inputs.find(el => /^api-key-/i.test(el.value || ''));
    if (!input) return JSON.stringify({ error: 'name-input-not-found' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(uniqueName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const create = [...document.querySelectorAll('button, [role="button"]')].find(el => {
      const text = (el.textContent || '').trim().replace(/\s+/g, '');
      return visible(el) && text === '创建' && !el.disabled;
    });
    if (!create) return JSON.stringify({ error: 'confirm-not-found' });
    create.click();
    return JSON.stringify({ ok: true });
  })()`).catch(() => '{}');
  let formState = {};
  try { formState = JSON.parse(formResult || '{}'); } catch {}
  if (formState.error) throw new Error(`火山方舟创建对话框异常：${formState.error}`);

  await sleep(800);
  // The create mutation returns an internal 32-character API-key ID, not the
  // model API credential. Ark exposes the actual key only after the eye icon
  // in its newly-created table row is clicked. Scope every action to our
  // unique display name so we never reveal or copy a different key.
  let key = '';
  for (let attempt = 0; attempt < 8 && !key; attempt += 1) {
    const revealResult = await execJs(`(() => {
      const rows = [...document.querySelectorAll('tr')];
      const row = rows.find(el => (el.innerText || '').includes(${JSON.stringify(uniqueName)}));
      if (!row) return JSON.stringify({ error: 'created-row-not-found' });
      const eye = row.querySelector('svg[class*="eye"]');
      if (!eye) return JSON.stringify({ error: 'reveal-control-not-found' });
      const clickable = eye.parentElement || eye;
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      clickable.click?.();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{}');
    let revealState = {};
    try { revealState = JSON.parse(revealResult || '{}'); } catch {}
    if (revealState.error && revealState.error !== 'created-row-not-found') {
      throw new Error(`火山方舟创建成功，但无法展开该 Key：${revealState.error}`);
    }
    await sleep(350);
    const revealed = await execJs(`(() => {
      const row = [...document.querySelectorAll('tr')]
        .find(el => (el.innerText || '').includes(${JSON.stringify(uniqueName)}));
      if (!row) return '';
      // Ark keys are opaque 46-character tokens. Resource IDs are shorter
      // apikey-prefixed resource IDs are intentionally excluded here.
      const match = (row.innerText || '').match(/\\b[A-Za-z0-9_-]{40,}\\b/);
      return match ? match[0] : '';
    })()`).catch(() => '');
    if (revealed && !isAssetData(revealed)) key = revealed;
    if (!key) await sleep(500);
  }
  if (key) {
    await closeAutomationWindow();
    return { value: key, name: uniqueName };
  }

  const entries = [];
  const entryIdentity = entry => [entry?.url || '', entry?.method || '', entry?.timestamp || ''].join('|');
  let capturedCandidate = '';
  for (let attempt = 0; attempt < 5 && !capturedCandidate; attempt += 1) {
    await sleep(700);
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || 'network-capture-read failed');
    for (const entry of (read.data || [])) {
      const identity = entryIdentity(entry);
      const previous = entries.find(candidate => entryIdentity(candidate) === identity);
      if (!previous) entries.push(entry);
      else if (!previous.responsePreview && entry.responsePreview) Object.assign(previous, entry);
    }
    const candidate = extractKeyFromCaptures(entries, 'volcengine');
    // Do not mistake Ark's 32-character internal ID for a usable credential.
    if (/^[A-Za-z0-9_-]{40,}$/.test(candidate || '')) capturedCandidate = candidate;
  }
  console.log('[auto-create] volcengine: captured ' + entries.length + ' requests');
  // Response bodies can contain a one-time credential. Keep diagnostics to
  // field paths, lengths and shapes so an Ark UI/API change is observable
  // without writing any key material to logs.
  const volcSecretFields = describeCapturedSecretFields(entries);
  if (volcSecretFields.length) {
    console.log('[auto-create] volcengine: safe key-field diagnostics ' + JSON.stringify(volcSecretFields));
  }

  key = capturedCandidate;

  if (!key) {
    const domKey = await execJs(`(() => {
      const text = document.body.innerText || '';
      // Ark keys are UUID-like; never fall back to the IAM AKLT pattern.
      const arkMatch = text.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/i);
      if (arkMatch) return arkMatch[0];
      const tokens = text.match(/[a-zA-Z0-9_-]{40,}/g) || [];
      for (const t of tokens) {
        if (t.length > 500 || /css|chunk|font|webpack|preview/i.test(t)) continue;
        if (/^[0-9]+$/.test(t)) continue;
        return t;
      }
      return '';
    })()`).catch(() => '');
    if (domKey && !isAssetData(domKey)) key = domKey;
  }

  if (!key) {
    const apiUrls = entries
      .filter(e => /ark|key|token|secret/i.test(e.url))
      .map(e => e.method + ' ' + e.responseStatus + ' ' + e.url.slice(0, 100))
      .join('\n  ');
    throw new Error('volcengine 未捕获到 key (抓包 ' + entries.length + ' 条。API 相关:\n  ' + (apiUrls || '(无)') + ')');
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

// ─── MiniMax — atomic-capability orchestration ──────────────────────
// Flow: navigate → arm capture → dismiss M3 promo modal → click "创建" →
//       fill name in ant-modal → confirm via ant-modal-Footer primary btn →
//       read → extract. Known gotcha: a "MiniMax M3" promotional modal
//       covers the create button and must be dismissed first.
async function createMinimaxKey({ tokenName, run }) {
  // Append timestamp suffix to avoid name collisions on the platform
  const uniqueName = tokenName + '-' + Date.now().toString(36).slice(-4);

  const nav = await sendCommand('navigate', { url: MINIMAX_URL, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const tabId = nav.data && nav.data.tabId;

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] minimax: capture armed');

  await sleep(3000);
  if (await detectInteractiveVerification('minimax')) {
    await waitForInteractiveVerification({ run, platform: { id: 'minimax', label: 'MiniMax' }, stage: 'before-create' });
  }

  // CRITICAL: dismiss the "MiniMax M3" promotional modal first — it covers
  // the create button and intercepts clicks.
  await execJs(`(() => {
    for (let i = 0; i < 8; i++) {
      // Close buttons: 我知道了 / 关闭 / 取消 + generic modal close
      const closeTexts = ['我知道了', '关闭', '取消', 'Close', 'Got it'];
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const close = btns.find(b => closeTexts.some(t => (b.textContent || '').trim() === t || (b.textContent || '').includes(t)));
      if (close) { close.click(); }
      const x = document.querySelector('.ant-modal-close, [aria-label="Close"]');
      if (x) { x.click(); }
      const mask = document.querySelector('.ant-modal-mask');
      if (mask) { mask.click(); }
    }
    return 'promo-dismissed';
  })()`).catch(() => 'promo-skipped');
  console.log('[auto-create] minimax: promo dismissed');
  await sleep(500);

  // Click create button
  await execJs(`(() => {
    const texts = ${JSON.stringify(MINIMAX_CREATE_TEXTS)};
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const visible = els.filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.disabled;
    });
    const btn = visible.find(e => texts.some(t => (e.textContent || '').includes(t)));
    if (!btn) throw new Error('未找到创建按钮');
    btn.click();
    return 'clicked';
  })()`);
  console.log('[auto-create] minimax: create clicked');
  if (await detectInteractiveVerification('minimax')) {
    await waitForInteractiveVerification({ run, platform: { id: 'minimax', label: 'MiniMax' }, stage: 'create-action' });
  }

  // Wait for the ant-modal to appear
  await sleep(2500);

  // Fill name — minimax uses ant-modal inputs
  await execJs(`(() => {
    // Try multiple selectors within the modal
    const selectors = ['.ant-modal input', '.ant-modal-content input', 'input.ant-input', 'input[type="text"]:not([disabled])'];
    for (const sel of selectors) {
      const inp = document.querySelector(sel);
      if (inp && inp.getBoundingClientRect().width > 0) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(uniqueName)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'filled:' + sel;
      }
    }
    throw new Error('未找到 modal 输入框');
  })()`);

  // Confirm via ant-modal-Footer primary button
  await sleep(500);
  await execJs(`(() => {
    const selectors = [
      '.ant-modal-footer button.ant-btn-primary',
      '.ant-modal-Footer button.ant-btn-primary',
      '.ant-modal-footer button:not([disabled])',
      '.ant-modal button[type="submit"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.getBoundingClientRect().width > 0 && !btn.disabled) {
        btn.click();
        return 'confirmed:' + sel;
      }
    }
    // Fallback: any primary-looking button in modal
    const modal = document.querySelector('.ant-modal-content');
    if (modal) {
      const btns = [...modal.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0 && !b.disabled);
      const primary = btns.find(b => /确定|确认|创建|Create|Confirm/i.test(b.textContent));
      if (primary) { primary.click(); return 'fallback-confirmed'; }
    }
    throw new Error('未找到确认按钮');
  })()`);

  await sleep(3000);
  const entries = [];
  const entryIdentity = entry => [entry?.url || '', entry?.method || '', entry?.timestamp || ''].join('|');
  const collectCapture = async () => {
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) throw new Error(read.error || 'network-capture-read failed');
    for (const entry of (read.data || [])) {
      const identity = entryIdentity(entry);
      const previous = entries.find(candidate => entryIdentity(candidate) === identity);
      if (!previous) entries.push(entry);
      else if (!previous.responsePreview && entry.responsePreview) Object.assign(previous, entry);
    }
  };

  let key = null;
  // The create mutation can finish after the UI has closed its dialog. Keep a
  // short bounded read window so delayed response bodies are not mistaken for
  // a failed creation. The extension now waits for already-scheduled CDP body
  // reads before draining, while this loop covers providers that render late.
  for (let attempt = 0; attempt < 6 && !key; attempt += 1) {
    if (attempt > 0) await sleep(700);
    await collectCapture();
    key = extractKeyFromCaptures(entries, 'minimax');

    // DOM fallback — MiniMax keys are usually sk-api-... but some accounts
    // receive the ordinary sk- form. Read one-time result fields as well as
    // visible text because the modal may use an input or copy attribute.
    if (!key) {
      const domKey = await execJs(`(() => {
        const sources = [document.body?.innerText || ''];
        for (const el of document.querySelectorAll('input, textarea, code, pre, [data-clipboard-text], [data-copy], [data-key]')) {
          sources.push(el.value || el.textContent || el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') || el.getAttribute('data-key') || '');
        }
        for (const source of sources) {
          const m = String(source).match(/(sk-api-[a-zA-Z0-9\\-_]{20,})/) || String(source).match(/(sk-[a-zA-Z0-9\\-_]{30,})/);
          if (m) return m[1];
        }
        return '';
      })()`).catch(() => '');
      if (domKey && !isAssetData(domKey)) key = domKey;
    }
  }
  console.log(`[auto-create] minimax: captured ${entries.length} requests`);

  // MiniMax documents that the newly-created secret is shown once and must be
  // copied immediately. Some console builds return only a success envelope
  // from /backend/token and place the secret exclusively behind the result
  // dialog's Copy control. Use that control only when it is uniquely scoped
  // to an API-key dialog; never click an ambiguous page-wide copy button.
  if (!key) {
    await execJs(`(() => {
      window.__okitMinimaxCopiedKey = '';
      const capture = value => {
        const text = String(value || '');
        const match = text.match(/sk-(?:api-)?[A-Za-z0-9_-]{20,}/);
        if (match) window.__okitMinimaxCopiedKey = match[0];
      };
      try {
        const clipboard = navigator.clipboard;
        const original = clipboard?.writeText?.bind(clipboard);
        if (original) {
          const wrapped = text => { capture(text); return original(text); };
          try { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
          try { Object.defineProperty(Object.getPrototypeOf(clipboard), 'writeText', { configurable: true, value: wrapped }); } catch {}
        }
      } catch {}
      document.addEventListener('copy', event => {
        capture(event.clipboardData?.getData('text/plain') || window.getSelection()?.toString() || '');
      }, true);
      return 'minimax-copy-capture-ready';
    })()`).catch(() => 'minimax-copy-capture-failed');
    const copyStateRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el?.getBoundingClientRect?.();
        const style = el ? getComputedStyle(el) : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
      };
      const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]';
      const dialogs = [...document.querySelectorAll(dialogSelectors)].filter(visible).filter(dialog => {
        const text = String(dialog.innerText || '');
        return /API\\s*Key|密钥|secret|sk-/i.test(text);
      });
      const candidates = dialog => [...dialog.querySelectorAll('button, a, [role="button"]')].filter(visible).filter(el => {
        const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.className]
          .filter(value => typeof value === 'string').join(' ');
        return /复制|copy/i.test(label);
      });
      const matches = dialogs.flatMap(dialog => candidates(dialog).map(control => ({ dialog, control })));
      if (matches.length !== 1) return JSON.stringify({ ok: false, dialogs: dialogs.length, copies: matches.length });
      const rect = matches[0].control.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    let copyState = {};
    try { copyState = JSON.parse(copyStateRaw || '{}'); } catch {}
    if (copyState.ok) {
      const clicked = await foregroundClick({ x: copyState.x, y: copyState.y, tabId });
      if (clicked) {
        await sleep(500);
        const pageCopied = await execJs('window.__okitMinimaxCopiedKey || ""').catch(() => '');
        if (pageCopied && !isAssetData(pageCopied)) key = pageCopied;
        if (!key) {
          const clipboardRead = await sendCommand('clipboard-read', {
            workspace: 'okit',
            clipboardPattern: 'sk-(?:api-)?[A-Za-z0-9_-]{20,}',
          }, 5000).catch(() => ({ ok: false, data: {} }));
          const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
          if (clipboardValue && !isAssetData(clipboardValue)) key = clipboardValue;
        }
      }
    }

  }

  if (!key) {
    const apiUrls = entries
      .filter(e => /key|token|interface|api/i.test(e.url))
      .map(e => `${e.method} ${e.responseStatus} ${e.url.slice(0, 120)}`)
      .join('\n  ');
    const responseDiagnostics = describeCapturedResponses(entries)
      .filter(entry => /backend\/token|key|token|interface|api/i.test(entry.path));
    const secretFieldDiagnostics = describeCapturedSecretFields(entries)
      .filter(entry => /backend\/token|key|token|interface|api/i.test(entry.path));
    const backendResults = describeMinimaxBackendResults(entries);
    console.log('[auto-create] minimax: safe response diagnostics', JSON.stringify(responseDiagnostics));
    if (backendResults.length) {
      console.log('[auto-create] minimax: backend result diagnostics', JSON.stringify(backendResults));
    }
    if (secretFieldDiagnostics.length) {
      console.log('[auto-create] minimax: safe secret-field diagnostics', JSON.stringify(secretFieldDiagnostics));
    }
    const backendSummary = backendResults.length ? `,后端结果:${JSON.stringify(backendResults)}` : '';
    throw new Error(`minimax 未捕获到 key (抓包 ${entries.length} 条,API 相关:\n  ${apiUrls || '(无)'},响应体诊断:${JSON.stringify(responseDiagnostics)}${backendSummary})`);
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

  return { createVolcengineKey, createMinimaxKey };
}
module.exports = { createVolcengineMinimaxStrategy };
