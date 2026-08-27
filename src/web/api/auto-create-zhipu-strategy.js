// Zhipu browser strategy; all browser and safety operations arrive explicitly.
function createZhipuStrategy(deps) {
  const { sendCommand, execJs, sleep, closeAutomationWindow, detectInteractiveVerification, waitForInteractiveVerification, isValidZhipuApiKey, extractKeyFromCaptures, ZHIPU_URL, ZHIPU_CREATE_TEXTS, ZHIPU_CONFIRM_TEXTS, ZHIPU_NAME_SELECTORS, resolveActionCandidate, scoreActionCandidate, descriptorFingerprint } = deps;
async function createZhipuKey({ tokenName, run }) {
  // Append a short timestamp suffix to avoid name collisions on the platform
  // (zhipu rejects duplicate key names silently — the confirm button works
  // but no key is actually created, resulting in 0 captured API responses).
  // The current dialog enforces a hard 20-character limit.
  const uniqueName = `${String(tokenName || '').slice(0, 13)}-${Date.now().toString(36).slice(-6)}`;

  // 1. Navigate to zhipu API key page (reuse logged-in cookies)
  const nav = await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || 'navigate failed');
  const navData = nav.data || {};
  const tabId = navData.tabId;

  // 2. Arm network capture BEFORE clicking create
  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || 'network-capture-start failed');
  console.log('[auto-create] zhipu: capture armed');

  // 3. Wait for SPA to render the key management page, then dismiss modals.
  //    Poll for the create action to appear (up to 15s) — zhipu's SPA load
  //    time varies and a fixed sleep is unreliable. Each pass uses the shared
  //    two-phase clickCreateAction flow. A merely missing create button keeps
  //    polling; ambiguous or live-drifted results are fatal and never clicked.
  let createResult = null;
  let createFatal = false;
  for (let wait = 0; wait < 15; wait++) {
    await sleep(1000);
    if (await detectInteractiveVerification('zhipu')) {
      await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'before-create' });
    }
    // Dismiss leftover modals each iteration
    await execJs(`(() => {
      for (let i = 0; i < 3; i++) {
        const close = document.querySelector('.ant-modal-close, [aria-label="Close"], .ant-modal-mask');
        if (close) close.click();
        const cancel = [...document.querySelectorAll('button')].find(b => /取消|关闭|我知道了/.test(b.textContent));
        if (cancel) cancel.click();
      }
    })()`).catch(() => {});

    // Two-phase create click (read-only collect → Node resolve → fingerprint
    // recheck → click) against the exact bilingual API-Key phrases.
    createResult = await clickCreateAction({ createTexts: ZHIPU_CREATE_TEXTS });
    if (createResult.ok) break;
    if (createResult.error === 'create-ambiguous' || createResult.error === 'create-mismatch') {
      createFatal = true;
      break;
    }
  }
  console.log('[auto-create] zhipu: create →', createResult);
  if (!createResult.ok) {
    if (createFatal) {
      throw new Error(`创建按钮候选不唯一或点击前已变化，为避免误点已停止。页面按钮: ${JSON.stringify(createResult.buttons || [])}`);
    }
    throw new Error(`创建按钮未找到。页面按钮: ${JSON.stringify(createResult.buttons || [])}`);
  }

  // 5. Wait for dialog, fill name — scoped to modal if one exists
  await sleep(1000);
  const fillResult = await execJs(`(() => {
    // zhipu uses a custom dialog — try multiple container selectors then body
    const scopes = ['.ant-modal-content', '.ant-modal', '[role="dialog"]', '.el-dialog', '.el-dialog__body', '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]', 'body'];
    for (const scope of scopes) {
      const container = scope === 'body' ? document : document.querySelector(scope);
      if (!container) continue;
      const inp = container.querySelector(${JSON.stringify(ZHIPU_NAME_SELECTORS)});
      if (inp && inp.getBoundingClientRect().width > 0) {
        // Use multiple strategies to set the value — Vue/React frameworks
        // sometimes don't react to a single input event.
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, ${JSON.stringify(uniqueName)});
        // Trigger events that Vue/React/Angular listen to
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        // Also try keyboard events for frameworks that track key sequences
        inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        // Focus back to keep the field active
        inp.focus();
        return JSON.stringify({ ok: true, scope, value: inp.value });
      }
    }
    return JSON.stringify({ error: 'not-found' });
  })()`).catch(e => JSON.stringify({ error: e.message }));
  const fillObj = JSON.parse(fillResult || '{}');
  console.log('[auto-create] zhipu: fill →', fillResult);
  if (fillObj.error) throw new Error('名称输入框未找到(创建对话框可能未打开)');

  // 6. Confirm via the shared two-phase helper scoped to the name dialog/form.
  //    Read-only collect → Node resolve with ZHIPU_CONFIRM_TEXTS (generics
  //    allowed inside that scope, button[type=submit] as selector evidence) →
  //    fingerprint/scope/selector recheck → click. Missing, disabled or
  //    ambiguous results fail closed: an error is returned and nothing clicks.
  await sleep(500);
  if (await detectInteractiveVerification('zhipu')) {
    await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'create-action' });
  }
  const confirmState = await clickZhipuConfirm();
  console.log('[auto-create] zhipu: confirm →', confirmState);
  if (confirmState.error) {
    if (confirmState.error === 'confirm-ambiguous') {
      throw new Error(`确认按钮存在多个候选且无法安全区分，为避免误点已停止。候选: ${(confirmState.buttons || []).join('、') || '无'}`);
    }
    throw new Error('确认按钮未找到或不可用(在 modal 内)，未执行点击');
  }

  // Zhipu may open the account-security challenge only after the final Create
  // click. Reuse the same resumable handoff before attempting to read the
  // one-time secret; otherwise a valid logged-in session is reported as a
  // generic extraction failure.
  await sleep(250);
  if (await detectInteractiveVerification('zhipu')) {
    await waitForInteractiveVerification({ run, platform: { id: 'zhipu', label: '智谱 AI' }, stage: 'post-create-security-verification' });
  }

  // 7. IMMEDIATELY after confirm, check DOM for the full key. zhipu shows the
  //    complete "apiKey.secret" in a one-time success dialog that may close
  //    quickly. We check NOW (no sleep) before the dialog disappears.
  const immediateKey = await execJs(`(() => {
    // Look everywhere for the full "hex.secret" format
    const allText = document.body.innerText || '';
    // Strategy 1: full key in visible text
    let m = allText.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
    if (m) return m[0];
    // Strategy 2: in input/textarea values (copy fields)
    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.value && /[a-f0-9]{32}\./.test(el.value)) return el.value.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/)[0];
    }
    // Strategy 3: in data attributes / clipboard attributes
    for (const el of document.querySelectorAll('[data-clipboard-text], [data-copy], [data-key]')) {
      const val = el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') || el.getAttribute('data-key') || '';
      m = val.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    // Strategy 4: in any element's text content (dialogs, code blocks, spans)
    for (const el of document.querySelectorAll('[class*="key"], [class*="secret"], [class*="copy"], code, pre, .api-key')) {
      m = (el.textContent || '').match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    return '';
  })()`).catch(() => '');
  if (isValidZhipuApiKey(immediateKey)) {
    console.log('[auto-create] zhipu: found full key immediately after confirm');
    await closeAutomationWindow();
    return { value: immediateKey, name: uniqueName };
  }

  // 7b. Wait briefly and try again (dialog may take a moment to render)
  await sleep(1500);
  const delayedKey = await execJs(`(() => {
    const allText = document.body.innerText || '';
    let m = allText.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
    if (m) return m[0];
    for (const el of document.querySelectorAll('input, textarea, [data-clipboard-text], [data-key]')) {
      const val = el.value || el.getAttribute('data-clipboard-text') || el.getAttribute('data-key') || '';
      m = val.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/);
      if (m) return m[0];
    }
    return '';
  })()`).catch(() => '');
  if (isValidZhipuApiKey(delayedKey)) {
    console.log('[auto-create] zhipu: found full key after delay');
    await closeAutomationWindow();
    return { value: delayedKey, name: uniqueName };
  }

  // 7c. (moved to after key extraction — see below)

  //    Retry reading up to 3 times — the API response may arrive later than
  //    our initial 2s wait, especially on slow connections.
  let entries = [];
  let key = null;
  for (let retry = 0; retry < 3 && !key; retry++) {
    await sleep(retry === 0 ? 3000 : 2000); // first wait 3s, then 2s increments
    const read = await sendCommand('network-capture-read',
      { workspace: 'okit', ...(tabId ? { tabId } : {}) }, 10000);
    if (!read.ok) break;
    // network-capture-read drains the buffer, so accumulate across retries
    const newEntries = read.data || [];
    entries = entries.concat(newEntries);

    key = extractKeyFromCaptures(entries, 'zhipu');
    if (key) break;

    // If no key yet and this is the last retry, try the shared two-phase
    // confirm flow again in case the dialog is still open; it fails closed
    // (no click) when nothing confirmable is present.
    if (retry === 1) {
      const retryConfirm = await clickZhipuConfirm().catch(() => ({ error: 'confirm-not-found' }));
      console.log('[auto-create] zhipu: retry confirm check →', retryConfirm.ok ? 're-clicked-confirm' : retryConfirm.error);
    }
  }

  console.log(`[auto-create] zhipu: captured ${entries.length} requests total`);

  // 7c. zhipu's API returns a MASKED secret. The full key (apiKey.secret) is
  //    only available via the "copy" button (class: icon-wdapp_copy common-i)
  //    next to each key in the list. We inject a fetch/clipboard interceptor,
  //    click the copy button for our key, and read the intercepted value.
  // The current API platform returns the create response asynchronously and
  // may not expose the secret in the captured request. In that case, reload
  // the exact key list and copy only the row whose full test name matches.
  if (!key) {
    await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000).catch(() => {});
    await sleep(3000);
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      try {
        const original = navigator.clipboard?.writeText?.bind(navigator.clipboard);
        if (original) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: text => { window.__okitCapturedKey = String(text || ''); return original(text); } });
      } catch {}
      return 'interceptor-installed';
    })()`).catch(() => 'interceptor-failed');
    for (let attempt = 0; attempt < 5 && !key; attempt += 1) {
      const copyState = await execJs(`(() => {
        const target = ${JSON.stringify(uniqueName)};
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
        };
        const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(row => visible(row) && (row.innerText || '').includes(target));
        if (rows.length !== 1) return JSON.stringify({ ok: false, rows: rows.length });
        const copies = [...rows[0].querySelectorAll('.icon-wdapp_copy, [class*="wdapp_copy"], [class*="copy"]')].filter(visible);
        if (copies.length !== 1) return JSON.stringify({ ok: false, copies: copies.length });
        copies[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"ok":false}');
      let copyStateObj = {};
      try { copyStateObj = JSON.parse(copyState || '{}'); } catch {}
      await sleep(500);
      const copied = await execJs('window.__okitCapturedKey || ""').catch(() => '');
      if (isValidZhipuApiKey(copied)) key = copied;
      if (!key && copyStateObj.ok === false) await sleep(700);
    }
    if (!key) {
      const clipboardRead = await sendCommand('clipboard-read', {
        workspace: 'okit',
        clipboardPattern: '^[a-f0-9]{32}\\.[A-Za-z0-9]{6,}$',
      }, 5000).catch(() => ({ ok: false, data: {} }));
      const clipboardKey = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
      if (isValidZhipuApiKey(clipboardKey)) key = clipboardKey;
    }
    if (key) {
      await closeAutomationWindow();
      return { value: key, name: uniqueName };
    }
  }

  if (key) {
    // Reload the page to get a fresh key list with the newly created key
    await sendCommand('navigate', { url: ZHIPU_URL, workspace: 'okit' }, 30000).catch(() => {});
    await sleep(3000);

    // Inject a clipboard interceptor to capture what the copy button puts on the clipboard
    await execJs(`(() => {
      window.__okitCapturedKey = '';
      const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function(text) {
        window.__okitCapturedKey = text;
        return origWriteText(text);
      };
      // Also intercept execCommand('copy') as fallback
      const origExec = document.execCommand.bind(document);
      document.execCommand = function(cmd) {
        if (cmd === 'copy') {
          const sel = window.getSelection().toString();
          if (sel) window.__okitCapturedKey = sel;
        }
        return origExec(cmd);
      };
      return 'interceptor-installed';
    })()`).catch(() => 'interceptor-failed');

    // Find and click the copy button (icon-wdapp_copy) for our key
    const clickResult = await execJs(`(() => {
      const keyName = ${JSON.stringify(uniqueName)};
      const apiKey = ${JSON.stringify(key)};
      // Find the row containing our key name or apiKey
      const allEls = [...document.querySelectorAll('tr, li, [class*="row"], [class*="item"], [class*="card"], [class*="line"]')];
      let row = allEls.find(el => el.textContent.includes(keyName));
      if (!row) row = allEls.find(el => el.textContent.includes(apiKey));
      if (!row) return 'row-not-found';

      // Find the copy icon within the row
      const copyBtn = row.querySelector('.icon-wdapp_copy, [class*="wdapp_copy"], [class*="copy"]');
      if (copyBtn) { copyBtn.click(); return 'clicked-copy'; }

      // Fallback: search globally for copy icons near our key
      const allCopyBtns = [...document.querySelectorAll('.icon-wdapp_copy, [class*="wdapp_copy"]')];
      // Click each and check which one captures our key
      for (const btn of allCopyBtns) {
        btn.click();
      }
      return 'clicked-all-copy:' + allCopyBtns.length;
    })()`).catch(() => 'click-failed');
    console.log('[auto-create] zhipu: copy button →', clickResult);

    // Read the intercepted clipboard value
    await sleep(1000);
    const capturedKey = await execJs('window.__okitCapturedKey || ""').catch(() => '');
    console.log('[auto-create] zhipu: clipboard capture', capturedKey ? 'received' : 'empty');
    if (isValidZhipuApiKey(capturedKey)) {
      await closeAutomationWindow();
      return { value: capturedKey, name: uniqueName };
    }
  }

  // Diagnostic: retain only request metadata. Response bodies can contain the
  // one-time secret and must not be written to logs or to temporary images.
  for (const e of entries) {
    const body = e.responsePreview || '';
    if (/api_key|api_secret|apikey|secret/i.test(body) || /api_keys/i.test(e.url || '')) {
      console.log(`[auto-create] zhipu: matched ${e.method} ${e.responseStatus} ${e.url.slice(0, 100)}`);
    }
  }
  // Count likely key-shaped values for diagnostics without emitting any value.
  const domDiag = await execJs(`(() => {
    const text = document.body.innerText || '';
    // Find all hex-dot-alphanumeric patterns
    const fullKeys = text.match(/[a-f0-9]{32}\.[a-zA-Z0-9]{6,}/g) || [];
    // Find all 32-hex patterns
    const hexKeys = text.match(/[a-f0-9]{32}/g) || [];
    return JSON.stringify({ full: fullKeys.length, partial: hexKeys.length });
  })()`).catch(() => '{}');
  try {
    const diag = JSON.parse(domDiag || '{}');
    console.log('[auto-create] zhipu: DOM key pattern counts', { full: diag.full || 0, partial: diag.partial || 0 });
  } catch {}

  // 8. zhipu keys are "apiKey.secretKey" format. The network response only
  //    returns a masked secretKey (e.g. "*****Y4n6"), so we must get the full
  //    secret from the DOM — zhipu shows it in a success dialog or key list
  //    after creation, with a copy button containing the full value.
  if (key) {
    // We have the apiKey from network; try to find the full secret on the page
    const fullKey = await execJs(`(() => {
      const text = document.body.innerText || '';

      // Strategy 1: look for the complete "hex.alphanumeric" key format directly
      // e.g. "64a3a143172d4b5e9420583a0b93d943.i2IC1jQfoptP1xOe"
      const fullMatch = text.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
      if (fullMatch) return fullMatch[1];

      // Strategy 2: look in input/copy fields (zhipu may have a hidden input
      // or data-attribute with the full key for the copy-to-clipboard feature)
      const inputs = [...document.querySelectorAll('input, textarea, [data-key], [data-clipboard-text]')];
      for (const el of inputs) {
        const val = el.value || el.getAttribute('data-key') || el.getAttribute('data-clipboard-text') || '';
        const m = val.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
        if (m) return m[1];
      }

      // Strategy 3: look in clipboard-related buttons or code blocks
      const codeBlocks = [...document.querySelectorAll('code, pre, .api-key-value, .key-value, [class*="key"], [class*="secret"]')];
      for (const el of codeBlocks) {
        const val = el.textContent || el.value || '';
        const m = val.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
        if (m) return m[1];
      }

      return '';
    })()`).catch(() => '');
    if (isValidZhipuApiKey(fullKey)) {
      console.log('[auto-create] zhipu: found full key (with secret) from DOM');
      key = fullKey;
    }
  }

  // 9. If still no key, try DOM-only extraction of the full key format.
  if (!key) {
    const domKey = await execJs(`(() => {
      const text = document.body.innerText || '';
      const fullMatch = text.match(/([a-f0-9]{32}\\.[a-zA-Z0-9]{6,})/);
      return fullMatch ? fullMatch[1] : '';
    })()`).catch(() => '');
    if (isValidZhipuApiKey(domKey)) key = domKey;
  }

  if (!key) {
    // List key-like API URLs in the error for debugging
    const apiUrls = entries
      .filter(e => /api_keys|apikeys|apikey|token/i.test(e.url))
      .map(e => `${e.method} ${e.responseStatus} ${e.url.slice(0, 120)}`)
      .join('\n  ');
    throw new Error(`未捕获到 key (抓包 ${entries.length} 条,API 相关:\n  ${apiUrls || '(无)'})`);
  }

  // The full zhipu key is "32-hex.secret-alnum". A masked or partial capture
  // (bare id, truncated secret, asterisks, or ellipses) must never be saved.
  if (!isValidZhipuApiKey(key)) {
    throw new Error('未读到完整有效的智谱 API Key(应形如 32 位小写十六进制 + "." + 至少 6 位字母数字),为避免保存被掩码的值已停止写入。');
  }

  await closeAutomationWindow();
  return { value: key, name: uniqueName };
}

/** Two-phase confirm for the zhipu name dialog/form, shared by the initial
 *  confirm and by re-confirming while the one-time key dialog may still be
 *  open. Phase 1 is read-only: the browser lists visible enabled controls
 *  scoped to the name input's form/dialog and flags button[type=submit]
 *  selector evidence; Node resolves a single target with ZHIPU_CONFIRM_TEXTS
 *  (generic labels allowed only inside that scope). Phase 2 recomputes the
 *  scope and rechecks the same index, its fingerprint, and that the scope
 *  still contains the target plus the selector evidence before clicking.
 *  Missing, disabled or ambiguous targets fail closed: an error object is
 *  returned and nothing is clicked. */
async function clickZhipuConfirm() {
  const options = {
    phrases: ZHIPU_CONFIRM_TEXTS,
    allowGenericInsideScope: true,
  };
  const collectRaw = await execJs(`(() => {
    const nameSelector = ${JSON.stringify(ZHIPU_NAME_SELECTORS)};
    const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="popup"]';
    const visible = el => {
      const r = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
    };
    const visibleEnabled = el => visible(el) && !el.disabled;
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();

    const nameInputCandidate = document.querySelector(nameSelector);
    const nameInput = visible(nameInputCandidate) ? nameInputCandidate : null;
    // Scope to the form/dialog that holds the name input, else any visible
    // dialog. Zhipu ships no explicit confirmSelectors, so document-wide
    // scope is never acceptable.
    let scope = null;
    if (nameInput) scope = nameInput.closest('form') || nameInput.closest(dialogSelectors);
    const hasScope = Boolean(scope);
    const inScopeOf = el => hasScope && (scope === document || scope === el || scope.contains(el));

    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
    const descriptors = controls.map((el, index) => {
      let selectorMatch = false;
      try { if (el.matches('button[type="submit"]')) selectorMatch = true; } catch { /* unselectable selector */ }
      selectorMatch = selectorMatch && inScopeOf(el);
      return {
        index,
        text: (el.textContent || '').trim().slice(0, 120),
        ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
        title: (el.title || '').trim().slice(0, 120),
        inVerifiedScope: inScopeOf(el),
        selectorMatch,
      };
    });
    return JSON.stringify({
      hasScope,
      nameFound: Boolean(nameInput),
      descriptors,
      buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16),
    });
  })()`);
  let collect = {};
  try { collect = JSON.parse(collectRaw || '{}'); } catch { collect = {}; }

  if (!collect.hasScope) {
    return { error: 'confirm-not-found', buttons: collect.buttons || [] };
  }
  const scopedCandidates = (collect.descriptors || []).filter(d => d.inVerifiedScope);
  const selected = resolveActionCandidate(scopedCandidates, options);
  if (!selected) {
    const scored = scopedCandidates
      .map(c => ({ raw: (c.text || '').slice(0, 40), score: scoreActionCandidate(c, options) }))
      .filter(entry => entry.score >= CREATE_ACTION_SCORE_THRESHOLD);
    return {
      error: scored.length === 0 ? 'confirm-not-found' : 'confirm-ambiguous',
      buttons: collect.buttons || [],
      scores: scored,
    };
  }

  const fingerprint = descriptorFingerprint(selected);
  const expectSelector = Boolean(selected.selectorMatch);
  const clickRaw = await execJs(`(() => {
    const nameSelector = ${JSON.stringify(ZHIPU_NAME_SELECTORS)};
    const dialogSelectors = '[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"], [class*="popup"]';
    const visible = el => {
      const r = el?.getBoundingClientRect?.();
      const style = el ? getComputedStyle(el) : null;
      return Boolean(r && r.width > 0 && r.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none');
    };
    const visibleEnabled = el => visible(el) && !el.disabled;
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const slice = value => String(value == null ? '' : value).trim().slice(0, 120);

    const nameInputCandidate = document.querySelector(nameSelector);
    const nameInput = visible(nameInputCandidate) ? nameInputCandidate : null;
    let scope = null;
    if (nameInput) scope = nameInput.closest('form') || nameInput.closest(dialogSelectors);
    // Abort unless a scope around the name input still exists.
    if (!scope) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-gone' });

    const targetIndex = ${selected.index};
    const expected = ${JSON.stringify(fingerprint)};
    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visibleEnabled);
    const target = controls[targetIndex];
    if (!target) return JSON.stringify({ error: 'confirm-mismatch', reason: 'index-gone' });
    // The recomputed scope must still contain the approved target.
    if (scope !== document && !scope.contains(target)) return JSON.stringify({ error: 'confirm-mismatch', reason: 'scope-changed' });
    const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
      .map(normalize).join('|');
    if (actual !== expected) return JSON.stringify({ error: 'confirm-mismatch', reason: 'fingerprint-changed' });
    // Selector evidence must still hold when it chose the target.
    if (${expectSelector}) {
      let stillMatches = false;
      try { if (target.matches('button[type="submit"]')) stillMatches = true; } catch {}
      if (!stillMatches) return JSON.stringify({ error: 'confirm-mismatch', reason: 'selector-gone' });
    }
    target.click();
    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 20) });
  })()`);
  let clickState = {};
  try { clickState = JSON.parse(clickRaw || '{}'); } catch { clickState = {}; }
  if (!clickState.ok) {
    return { error: 'confirm-mismatch', reason: clickState.reason, buttons: collect.buttons || [] };
  }
  return { ok: true, text: clickState.text };
}

// ─── Volcengine Ark (火山方舟) — atomic-capability orchestration ──
// The IAM API-key page creates AK/SK credentials for the cloud API. Those
// credentials cannot authenticate against Ark's OpenAI-compatible /api/v3
// endpoint. Model management must instead use Ark's dedicated API Key page.
// Live-verified flow: API Key 管理 → 创建 API Key → 名称 → 创建 → find the
// created row → click its eye icon. Ark's creation response contains only an
// internal API-key ID; the actual model credential is revealed by that row.
const VOLC_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey';
const VOLC_AGENT_PLAN_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan';
const VOLC_CREATE_TEXTS = ['创建 API Key'];

  return { createZhipuKey };
}
module.exports = { createZhipuStrategy };
