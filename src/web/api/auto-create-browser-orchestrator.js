// Browser create/recovery orchestration. Platform-specific strategies are injected.
function createBrowserOrchestrator(deps) {
  const { AUTO_CREATE_PLATFORM_MAP, VOLC_AGENT_PLAN_URL, createZhipuKey, createVolcengineKey, createMinimaxKey, beginGenericBrowserCreate, submitGenericBrowserCreate, readGenericBrowserCreateResult, execJs, resolveActionCandidate, scoreActionCandidate, descriptorFingerprint, sendCommand, sleep, keyFromText, extractKeyFromCaptures, describeCapturedResponses, describeCapturedSecretFields, closeAutomationWindow, isAssetData } = deps;
  const CREATE_ACTION_STRONG_PHRASES = ["create api key", "create key", "add", "new api key", "创建 api 密钥", "新建 api key", "确定"];
  const CREATE_ACTION_SCORE_THRESHOLD = 70;

async function clickCreateAction(platform) {
  const createTexts = platform.createTexts || CREATE_ACTION_STRONG_PHRASES;
  const createSelectors = platform.createSelectors || [];
  if (platform.createDirectSelector) {
    const directRaw = await execJs(`(() => {
      const selector = ${JSON.stringify(platform.createDirectSelector)};
      const phrases = ${JSON.stringify(createTexts)};
      const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const target = document.querySelector(selector);
      if (!target) return JSON.stringify({ error: 'not-found' });
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (!(rect.width > 0 && rect.height > 0) || style.visibility === 'hidden' || style.display === 'none' || target.disabled) {
        return JSON.stringify({ error: 'not-visible-or-disabled' });
      }
      const label = normalize(target.textContent || '');
      const verifiedText = phrases.some(phrase => {
        const expected = normalize(phrase);
        return expected && (label === expected || label.includes(expected));
      });
      if (!verifiedText) return JSON.stringify({ error: 'text-mismatch', text: (target.textContent || '').trim().slice(0, 120) });
      target.click();
      return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 120), selector });
    })()`).catch(() => '{"error":"direct-click-failed"}');
    let directState = {};
    try { directState = JSON.parse(directRaw || '{}'); } catch { directState = {}; }
    if (directState.ok) return directState;
  }
  // Phase 1: read-only. The browser only describes visible, enabled controls
  // and their stable page index; it never scores or clicks. All matching is
  // decided in Node by resolveActionCandidate against platform.createTexts.
  const collectRaw = await execJs(`(() => {
    const phrases = ${JSON.stringify(createTexts)};
    const selectors = ${JSON.stringify(createSelectors)};
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const visibleEnabled = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visibleEnabled);
    const descriptors = controls.map((el, index) => {
      const label = normalize((el.textContent || '').trim());
      return {
        index,
        text: (el.textContent || '').trim().slice(0, 120),
        ariaLabel: (el.getAttribute('aria-label') || '').trim().slice(0, 120),
        title: (el.title || '').trim().slice(0, 120),
        exactPhraseMatch: Array.isArray(phrases) && phrases.some(phrase => label === normalize(phrase)),
        selectorMatch: Array.isArray(selectors) && selectors.some(selector => {
          try { return el.matches(selector); } catch { return false; }
        }),
      };
    });
    return JSON.stringify({
      descriptors,
      buttons: controls.map(el => (el.textContent || '').trim().slice(0, 40)).slice(0, 12),
      workspaceKeys: /\\/workspaces\\/[^/]+\\/keys(?:[/?#]|$)/.test(location.pathname),
      keyInterface: /API Keys|Create (?:API )?Key|Key Management/i.test((document.body?.innerText || '').slice(0, 16000)),
    });
  })()`);
  let collect = {};
  try { collect = JSON.parse(collectRaw || '{}'); } catch { collect = {}; }

  const descriptors = Array.isArray(collect.descriptors) ? collect.descriptors : [];
  const options = { phrases: createTexts };
  const selected = resolveActionCandidate(descriptors, options);
  if (!selected) {
    const scored = descriptors
      .map(c => ({ text: (c.text || '').slice(0, 40), score: scoreActionCandidate(c, options) }))
      .filter(entry => entry.score >= CREATE_ACTION_SCORE_THRESHOLD);
    return {
      error: scored.length === 0 ? 'create-not-found' : 'create-ambiguous',
      buttons: collect.buttons || [],
      workspaceKeys: collect.workspaceKeys,
      keyInterface: collect.keyInterface,
      scores: scored,
    };
  }

  // Phase 2: re-collect and click the SAME index only after the live element's
  // normalized text/aria/title fingerprint still matches the descriptor that
  // Node approved. Anything moved between the two passes aborts the click.
  const fingerprint = descriptorFingerprint(selected);
  const clickRaw = await execJs(`(() => {
    const normalize = value => String(value == null ? '' : value).replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
    const slice = value => String(value == null ? '' : value).trim().slice(0, 120);
    const visibleEnabled = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
    };
    const targetIndex = ${selected.index};
    const expected = ${JSON.stringify(fingerprint)};
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visibleEnabled);
    const target = controls[targetIndex];
    if (!target) return JSON.stringify({ error: 'create-mismatch', reason: 'index-gone' });
    const actual = [slice(target.textContent), slice(target.getAttribute('aria-label')), slice(target.title)]
      .map(normalize).join('|');
    if (actual !== expected) return JSON.stringify({ error: 'create-mismatch', reason: 'fingerprint-changed' });
    target.click();
    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60) });
  })()`);
  let clickState = {};
  try { clickState = JSON.parse(clickRaw || '{}'); } catch { clickState = {}; }
  if (!clickState.ok) {
    return { error: 'create-mismatch', buttons: collect.buttons || [], workspaceKeys: collect.workspaceKeys, keyInterface: collect.keyInterface };
  }
  return clickState;
}

async function createGenericBrowserKey({ tokenName, platform, run }) {
  const state = await beginGenericBrowserCreate({ tokenName, platform, run });
  if (state.value) return state;
  return readGenericBrowserCreateResult(await submitGenericBrowserCreate(state));
}

async function createBrowserPlatformKey(platform, tokenName, run) {
  const ORCHESTRATORS = {
    zhipu: createZhipuKey,
    volcengine: createVolcengineKey,
    'volcengine-agent': (params) => createVolcengineKey({ ...params, url: VOLC_AGENT_PLAN_URL }),
    minimax: createMinimaxKey,
  };
  const orchestrator = ORCHESTRATORS[platform.id]
    || ((params) => createGenericBrowserKey({ ...params, platform }));
  return orchestrator({ tokenName, run });
}

/** Recover the newest already-created Z.AI key without creating another one. */
async function recoverLatestZaiGlobalKey() {
  const platform = AUTO_CREATE_PLATFORM_MAP.get('zai-global');
  if (!platform) throw new Error('Z.AI platform metadata unavailable');
  const nav = await sendCommand('navigate', { url: platform.url, workspace: 'okit' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开 Z.AI 密钥列表失败');
  const tabId = nav.data && nav.data.tabId;
  const capStart = await sendCommand('network-capture-start', {
    pattern: '', workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || '无法开始 Z.AI 复制接口抓取');
  await sleep(7000);
  const raw = await execJs(`(() => {
    const rows = [...document.querySelectorAll('tr')]
      .filter(row => /^ZAI_API_KEY-/i.test((row.innerText || '').trim()));
    const row = rows[rows.length - 1];
    const icon = row?.querySelector('svg.lucide-copy');
    if (!row || !icon) return JSON.stringify({ error: !row ? 'row-not-found' : 'copy-not-found' });
    const target = icon.parentElement || icon;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    target.click?.();
    const rect = icon.getBoundingClientRect();
    const parentRect = target.getBoundingClientRect();
    return JSON.stringify({
      name: (row.querySelector('td')?.innerText || '').trim(),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0,
      parentX: parentRect.x + parentRect.width / 2,
      parentY: parentRect.y + parentRect.height / 2,
    });
  })()`).catch(() => '{}');
  let meta = {};
  try { meta = JSON.parse(raw || '{}'); } catch {}
  if (meta.error) throw new Error(`Z.AI 最近已创建行不可恢复：${meta.error}`);
  if (!meta.visible || !Number.isFinite(meta.x) || !Number.isFinite(meta.y)) {
    throw new Error('Z.AI 最近已创建行的复制控件不可用');
  }
  await execJs(`(() => {
    window.__okitRecoveryCopied = '';
    if (window.__okitRecoveryCopyHooked) return 'already-hooked';
    const capture = value => { if (typeof value === 'string' && value) window.__okitRecoveryCopied = value; };
    try {
      if (navigator.clipboard?.writeText) {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        const wrapped = text => { capture(String(text || '')); return original(text); };
        try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: wrapped }); } catch {}
      }
    } catch {}
    document.addEventListener('copy', event => {
      capture(event.clipboardData?.getData('text/plain') || '');
      const selected = window.getSelection()?.toString() || '';
      capture(selected);
    });
    window.__okitRecoveryCopyHooked = true;
    return 'hooked';
  })()`).catch(() => 'hook-failed');
  const focused = await sendCommand('focus-window', { workspace: 'okit' }, 5000);
  if (!focused.ok) throw new Error('无法将 Z.AI 复制窗口置前');
  await sleep(150);
  const pointer = { x: meta.x, y: meta.y, button: 'left', buttons: 1, clickCount: 1 };
  const pressed = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mousePressed' },
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 5000);
  const released = await sendCommand('cdp', {
    cdpMethod: 'Input.dispatchMouseEvent',
    cdpParams: { ...pointer, type: 'mouseReleased', buttons: 0 },
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 5000);
  if (!pressed.ok || !released.ok) throw new Error('Z.AI 最近已创建行复制点击失败');
  await sleep(500);
  const copiedNetwork = await sendCommand('network-capture-read', {
    workspace: 'okit', ...(tabId ? { tabId } : {}),
  }, 10000).catch(() => ({ ok: false, data: [] }));
  const copiedNetworkKey = copiedNetwork.ok
    ? keyFromText(extractKeyFromCaptures(copiedNetwork.data || [], 'zai-global'), platform)
    : null;
  if (copiedNetworkKey) {
    const { VaultStore } = require('../../vault/store');
    const vault = new VaultStore();
    await vault.set(platform.keyHint, copiedNetworkKey, platform.groupHint);
    await closeAutomationWindow();
    return { name: meta.name || 'latest', valueLength: copiedNetworkKey.length };
  }
  if (copiedNetwork.ok) {
    console.log('[auto-create] zai recovery copy response shapes', JSON.stringify({
      entries: describeCapturedResponses(copiedNetwork.data || []),
      secretFields: describeCapturedSecretFields(copiedNetwork.data || []),
    }));
  }
  const pageCopied = await execJs('window.__okitRecoveryCopied || ""').catch(() => '');
  const pageKey = keyFromText(pageCopied, platform);
  if (pageKey) {
    const { VaultStore } = require('../../vault/store');
    const vault = new VaultStore();
    await vault.set(platform.keyHint, pageKey, platform.groupHint);
    await closeAutomationWindow();
    return { name: meta.name || 'latest', valueLength: pageKey.length };
  }
  // A few React builds attach the handler to the icon wrapper rather than the
  // SVG node. Retry that exact same existing row once at the parent center.
  if (Number.isFinite(meta.parentX) && Number.isFinite(meta.parentY)) {
    const parentPointer = { x: meta.parentX, y: meta.parentY, button: 'left', buttons: 1, clickCount: 1 };
    await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchMouseEvent',
      cdpParams: { ...parentPointer, type: 'mousePressed' },
      workspace: 'okit', ...(tabId ? { tabId } : {}),
    }, 5000);
    await sendCommand('cdp', {
      cdpMethod: 'Input.dispatchMouseEvent',
      cdpParams: { ...parentPointer, type: 'mouseReleased', buttons: 0 },
      workspace: 'okit', ...(tabId ? { tabId } : {}),
    }, 5000);
    await sleep(500);
    const parentCopied = await execJs('window.__okitRecoveryCopied || ""').catch(() => '');
    const parentKey = keyFromText(parentCopied, platform);
    if (parentKey) {
      const { VaultStore } = require('../../vault/store');
      const vault = new VaultStore();
      await vault.set(platform.keyHint, parentKey, platform.groupHint);
      await closeAutomationWindow();
      return { name: meta.name || 'latest', valueLength: parentKey.length };
    }
  }
  const clipboardRead = await sendCommand('clipboard-read', {
    workspace: 'okit', clipboardPattern: platform.keyPatterns[0], clipboardAllowSurrounding: true,
  }, 5000);
  const value = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
  const key = keyFromText(value, platform);
  if (!key) throw new Error(`Z.AI 最近已创建行复制内容无法通过格式校验（长度 ${Number(clipboardRead.data?.length) || 0}）`);
  const { VaultStore } = require('../../vault/store');
  const vault = new VaultStore();
  await vault.set(platform.keyHint, key, platform.groupHint);
  await closeAutomationWindow();
  return { name: meta.name || 'latest', valueLength: key.length };
}
  return { clickCreateAction, createBrowserPlatformKey, recoverLatestZaiGlobalKey };
}

module.exports = { createBrowserOrchestrator };
