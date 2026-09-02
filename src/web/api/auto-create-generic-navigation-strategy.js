/**
 * Generic browser create flow: navigation and pre-form preparation.
 * Browser/extension side effects are injected by the controller assembly.
 */
function createGenericNavigationStrategy(deps) {
  const { sendCommand, sleep, extractNewestNamedKeyFromCaptures, capturesContainMistralKeyRecords, closeAutomationWindow, execJs, isLoginUrl, detectLoginRequired, detectInteractiveVerification, waitForInteractiveVerification, waitForSecurityVerificationToClear, recoverLatestZaiGlobalKey, clickCreateAction, keyFromText, extractKeyFromCaptures, foregroundClick, XIAOMI_ICON_CLASSIFY_JS, handoffOpenRouterLoginIfNeeded, hasOpenRouterPublicNavigation, redirectOpenRouterToLogin } = deps;
  return async function beginGenericBrowserCreate({ tokenName, platform, run }) {
  if (!platform.url) throw new Error('该平台还没有可自动创建密钥的控制台地址');

  const uniqueSuffix = Date.now().toString(36).slice(-6);
  const rawUniqueName = `${tokenName}-${uniqueSuffix}`;
  const maxNameLength = Number(platform.nameMaxLength) || 0;
  const uniqueName = maxNameLength > 0 && rawUniqueName.length > maxNameLength
    ? `${String(tokenName).slice(0, Math.max(1, maxNameLength - uniqueSuffix.length - 1))}-${uniqueSuffix}`.slice(0, maxNameLength)
    : rawUniqueName;
  const nav = await sendCommand('navigate', { url: platform.url, workspace: 'modelswap' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开密钥管理页失败');
  const tabId = nav.data && nav.data.tabId;
  const arrivedUrl = nav.data && nav.data.url;
  if (isLoginUrl(arrivedUrl)) {
    throw new Error(`Login required at ${arrivedUrl}`);
  }

  // Do not infer authentication from the URL alone. Many provider consoles
  // keep their API-key route while their SPA replaces the content with a
  // sign-in form. Recheck before every possible create click below as that
  // form can render after navigation has already completed.
  const requireSignedIn = async () => {
    const loginState = await detectLoginRequired(platform);
    if (loginState.loginRequired) {
      throw new Error(`需要登录 ${platform.label || platform.id}${loginState.url ? ` (${loginState.url})` : ''}`);
    }
  };

  const capStart = await sendCommand('network-capture-start',
    { pattern: '', workspace: 'modelswap', ...(tabId ? { tabId } : {}) }, 10000);
  if (!capStart.ok) throw new Error(capStart.error || '无法开始安全抓取');

  await sleep(3000);
  await requireSignedIn();
  // A previous attempt may have successfully created the key but failed local
  // format validation. Recover only an MODELSWAP-named key from this provider's
  // credential-list response before considering another create action.
  if (platform.recoverExistingNamedKey || platform.blockWhenExistingKeys) {
    const recoveryRead = await sendCommand('network-capture-read', {
      workspace: 'modelswap',
      ...(tabId ? { tabId } : {}),
    }, 10000).catch(() => ({ ok: false, data: [] }));
    const capturedEntries = recoveryRead.ok ? (recoveryRead.data || []) : [];
    const recovered = platform.recoverExistingNamedKey
      ? extractNewestNamedKeyFromCaptures(recoveryRead.data || [], tokenName, platform)
      : null;
    if (recovered) {
      await closeAutomationWindow();
      return { value: recovered.key, name: recovered.name };
    }
    if (platform.blockWhenExistingKeys && capturesContainMistralKeyRecords(capturedEntries)) {
      throw new Error('Mistral 当前已有 Active API Key，控制台不会再次显示其明文。请使用已保存的 Key，或先在 Mistral 撤销旧 Key 后再自动创建。');
    }
  }
  // A few providers expose their console from a public product page. Follow
  // only the explicitly configured, non-destructive console action first.
  if (platform.preNavigationTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.preNavigationTexts)};
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled;
      });
      const target = candidates.find(el => texts.some(text => (el.textContent || '').trim().toLowerCase() === text.toLowerCase()));
      if (target) { target.click(); return 'clicked'; }
      return 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(2500);
  }
  // Some providers display a non-blocking profile reminder over their API-key
  // list. Dismiss only the provider's verified opt-out action; this never
  // accepts terms, billing, or permission changes on the user's behalf.
  if (platform.preCreateDismissTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.preCreateDismissTexts)};
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const target = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => texts.includes((el.textContent || '').trim()));
      if (target) target.click();
      return target ? 'dismissed' : 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(350);
  }
  if (await detectInteractiveVerification(platform)) {
    await waitForInteractiveVerification({ run, platform, stage: 'before-create' });
  }
  if (platform.id === 'openrouter') {
    await handoffOpenRouterLoginIfNeeded();
  }
  // Dismiss only generic promotional/cookie overlays before looking for the
  // create action. The actual creation dialog is never dismissed here.
  await execJs(`(() => {
    const closers = [...document.querySelectorAll('button, [role="button"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /^(关闭|取消|我知道了|Close|Dismiss|Got it)$/i.test((el.textContent || '').trim());
    });
    closers.slice(0, 2).forEach(el => el.click());
  })()`).catch(() => {});

  // MiMo Token Plan shows only Copy and Reset once a key already exists. In
  // that state there is deliberately no Create API Key button. Reuse the
  // existing key by clicking only the row's classified Copy icon; never click
  // Reset and never create a duplicate credential.
  if (platform.reuseExistingMaskedKey) {
    const existingRaw = await execJs(`(() => {
      const prefix = ${JSON.stringify(platform.existingMaskedKeyPrefix || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      const keyNode = [...document.querySelectorAll('input, textarea, p, span, div')]
        .filter(visible)
        .map(el => ({ el, text: String(el.value || el.textContent || '').trim() }))
        .filter(item => item.text.startsWith(prefix) && /(\\*{3,}|\.{3,}|…)/.test(item.text.slice(prefix.length)))
        .sort((a, b) => a.text.length - b.text.length)[0]?.el;
      const classifyIcon = ${XIAOMI_ICON_CLASSIFY_JS};
      let row = keyNode;
      for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
        const buttons = [...row.querySelectorAll('button, a, [role="button"]')].filter(visible);
        if (!buttons.length) continue;
        const copyTexts = ${JSON.stringify(platform.postCreateCopyTexts || [])};
        const copyButtons = buttons.filter(btn => {
          const label = [btn.textContent, btn.getAttribute('aria-label'), btn.getAttribute('title')]
            .filter(Boolean).join(' ').trim().toLowerCase();
          const textCopy = copyTexts.some(text => {
            const normalized = String(text).toLowerCase();
            return label === normalized || label.includes(normalized);
          });
          return textCopy || classifyIcon(btn) === 'copy';
        });
        // Only a single verified Copy action is safe to invoke. Zero or more
        // than one means the row is ambiguous — never click anything. Text
        // labels support providers such as Qianfan; icon-only controls still
        // use the existing MiMo classifier.
        if (copyButtons.length === 1) {
          const rect = copyButtons[0].getBoundingClientRect();
          return JSON.stringify({ found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, buttonCount: buttons.length });
        }
        if (copyButtons.length > 1) break;
      }
      return JSON.stringify({ found: false });
    })()`).catch(() => '{"found":false}');
    let existingState = {};
    try { existingState = JSON.parse(existingRaw || '{}'); } catch {}
    if (existingState.found) {
      // Install the same page-scoped Copy capture used after creation before
      // invoking an existing-key row. Some consoles (including Tencent) put
      // the one-time value into navigator.clipboard without exposing it in
      // the DOM or network response.
      await execJs(`(() => {
        window.__modelswapExistingCapturedKey = '';
        const capture = value => {
          const text = String(value || '');
          if (text) window.__modelswapExistingCapturedKey = text;
        };
        try {
          const clipboard = navigator.clipboard;
          const originalWriteText = clipboard?.writeText?.bind(clipboard);
          if (originalWriteText) {
            const wrappedWriteText = text => { capture(text); return originalWriteText(text); };
            try { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
            try { Object.defineProperty(Object.getPrototypeOf(clipboard), 'writeText', { configurable: true, value: wrappedWriteText }); } catch {}
          }
        } catch {}
        try {
          const originalExecCommand = document.execCommand.bind(document);
          document.execCommand = command => {
            if (String(command).toLowerCase() === 'copy') {
              const selected = window.getSelection()?.toString() || '';
              const active = document.activeElement;
              capture(selected || (typeof active?.value === 'string' ? active.value : ''));
            }
            return originalExecCommand(command);
          };
        } catch {}
        document.addEventListener('copy', event => {
          capture(event.clipboardData?.getData('text/plain') || window.getSelection()?.toString() || '');
        }, true);
        return 'capture-ready';
      })()`).catch(() => {});
      const clicked = await foregroundClick({ x: existingState.x, y: existingState.y, tabId });
      if (!clicked) throw new Error(platform.existingMaskedCopyFailureMessage || '已有 API Key 的复制控件无法点击');
      await sleep(500);
      const capturedExisting = await execJs('window.__modelswapExistingCapturedKey || ""').catch(() => '');
      const capturedExistingKey = keyFromText(capturedExisting, platform);
      if (capturedExistingKey) {
        await closeAutomationWindow();
        return { value: capturedExistingKey, name: tokenName };
      }
      if (platform.allowExtensionClipboardRead) {
        const clipboardRead = await sendCommand('clipboard-read', {
          workspace: 'modelswap',
          clipboardPattern: platform.keyPatterns?.[0] || '',
        }, 5000).catch(() => ({ ok: false, data: {} }));
        const clipboardValue = clipboardRead.ok && clipboardRead.data?.matched ? clipboardRead.data.value : '';
        const clipboardKey = keyFromText(clipboardValue, platform);
        if (clipboardKey) {
          await closeAutomationWindow();
          return { value: clipboardKey, name: tokenName };
        }
      }
      const existingNetwork = await sendCommand('network-capture-read', {
        workspace: 'modelswap',
        ...(tabId ? { tabId } : {}),
      }, 10000).catch(() => ({ ok: false, data: [] }));
      const existingEntries = existingNetwork.ok ? (existingNetwork.data || []) : [];
      const existingKey = keyFromText(extractKeyFromCaptures(existingEntries, platform.id), platform);
      if (existingKey) {
        await closeAutomationWindow();
        return { value: existingKey, name: tokenName };
      }
      throw new Error(platform.existingMaskedCopyFailureMessage || '已有 API Key，但复制控件没有返回可保存的明文');
    }
    if (platform.existingKeyRequired) {
      const loginState = await detectLoginRequired(platform);
      if (loginState.loginRequired) {
        throw new Error(`需要登录 ${platform.label || platform.id}`);
      }
      throw new Error(platform.missingExistingKeyMessage || '当前页面没有可复制的 API Key');
    }
  }

  await requireSignedIn();
  let createState = await clickCreateAction(platform);
  if (await detectInteractiveVerification(platform)) {
    await waitForInteractiveVerification({ run, platform, stage: 'create-action' });
  }
  // The Kimi console first renders its organization/navigation shell and only
  // adds the API key action after asynchronous data finishes loading. Poll the
  // proven action rather than guessing from the shell's early buttons.
  const createAttempts = Math.max(1, Number(platform.createWaitAttempts) || 1);
  for (let attempt = 1; createState.error === 'create-not-found' && attempt < createAttempts; attempt += 1) {
    await sleep(1000);
    await requireSignedIn();
    createState = await clickCreateAction(platform);
  }
  // The public OpenRouter shell can arrive after the earlier page-state probe.
  // These labels are the final button search's reliable, live signal.
  if (platform.id === 'openrouter'
    && createState.error
    && hasOpenRouterPublicNavigation(createState.buttons || [])
    && !createState.workspaceKeys
    && !createState.keyInterface) {
    await redirectOpenRouterToLogin();
    throw new Error('OpenRouter login required');
  }
  if (createState.error) {
    const actionLabel = platform.creationActionOnly ? '密钥操作按钮' : '创建密钥按钮';
    throw new Error(`未找到${actionLabel}：${(createState.buttons || []).join('、') || '请确认已登录并拥有操作权限'}`);
  }

  // Tencent Cloud shows a provider-owned warning before the actual SecretId /
  // SecretKey form. The acknowledgement is safe to automate only when the
  // exact warning, one checkbox, and one configured continuation action are
  // all present. This does not accept billing, terms, or permission changes.
  if (platform.preCreateAcknowledge) {
    const acknowledge = platform.preCreateAcknowledge;
    let acknowledged = false;
    let lastAcknowledgeState = {};
    const attempts = Math.max(1, Number(acknowledge.attempts) || 10);
    for (let attempt = 0; attempt < attempts && !acknowledged; attempt += 1) {
      const raw = await execJs(`(() => {
        const config = ${JSON.stringify(acknowledge)};
        const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
        const visible = el => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
        };
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
          .filter(visible)
          .filter(dialog => {
            const text = normalize(dialog.innerText || '');
            return (config.dialogTexts || []).some(expected => text.includes(normalize(expected)));
          })
          .filter(dialog => [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].some(visible))
          .filter(dialog => [...dialog.querySelectorAll('button, [role="button"]')].some(button => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            if (!(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden')) return false;
            const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
            return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
          }));
        if (!dialogs.length) return JSON.stringify({ ok: false, reason: 'dialog', count: 0 });
        const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        const checkboxes = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible);
        const checkbox = checkboxes.find(candidate => {
          const label = normalize([candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.closest('label')?.innerText, candidate.parentElement?.innerText].filter(Boolean).join(' '));
          return (config.checkboxTexts || []).some(expected => label.includes(normalize(expected)));
        });
        if (!checkbox || checkboxes.length !== 1) return JSON.stringify({ ok: false, reason: 'checkbox', count: checkboxes.length });
        const checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
        if (!checked) {
          const rect = checkbox.getBoundingClientRect();
          return JSON.stringify({ ok: false, reason: 'checked', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }
        const continueTexts = (config.continueTexts || []).map(normalize);
        const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => {
          const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
          return continueTexts.some(expected => label === expected || label.startsWith(expected));
        });
        if (buttons.length !== 1) return JSON.stringify({ ok: false, reason: 'continue', count: buttons.length });
        const rect = buttons[0].getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      })()`).catch(() => '{"ok":false}');
      let state = {};
      try { state = JSON.parse(raw || '{}'); } catch {}
      lastAcknowledgeState = state;
      if (state.ok) {
        const domClicked = await execJs(`(() => {
            const config = ${JSON.stringify(acknowledge)};
            const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
            const visible = el => {
              const rect = el?.getBoundingClientRect?.();
              const style = el ? getComputedStyle(el) : null;
              return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
            };
            const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
              .filter(visible)
              .filter(dialog => (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))));
            if (!dialogs.length) return false;
            const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
            const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter(visible).filter(button => {
              const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
              return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
            });
            if (buttons.length !== 1) return false;
            buttons[0].click();
            return true;
          })()`).catch(() => false);
        const clicked = domClicked === true || domClicked === 'true'
          || await foregroundClick({ x: state.x, y: state.y, tabId });
        if (!clicked) throw new Error(`${platform.label || platform.id} 主账号密钥风险确认按钮无法点击，未创建或保存密钥`);
        await sleep(450);
        const pendingWarning = await execJs(`(() => {
          const config = ${JSON.stringify(acknowledge)};
          const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const visible = el => {
            const rect = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden');
          };
          return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .some(dialog => visible(dialog) && (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))));
        })()`).catch(() => false);
        acknowledged = pendingWarning !== true && pendingWarning !== 'true';
      } else if (state.reason === 'checked' && Number.isFinite(state.x) && Number.isFinite(state.y)) {
        const domChecked = await execJs(`(() => {
          const config = ${JSON.stringify(acknowledge)};
          const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
          const visible = el => {
            const rect = el?.getBoundingClientRect?.();
            const style = el ? getComputedStyle(el) : null;
            return Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && !el.disabled);
          };
          const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]')]
            .filter(visible)
            .filter(dialog => (config.dialogTexts || []).some(expected => normalize(dialog.innerText || '').includes(normalize(expected))))
            .filter(dialog => [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].some(visible))
            .filter(dialog => [...dialog.querySelectorAll('button, [role="button"]')].some(button => {
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              if (!(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden')) return false;
              const label = normalize([button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')].filter(Boolean).join(' '));
              return (config.continueTexts || []).some(expected => label === normalize(expected) || label.startsWith(normalize(expected)));
            }));
          if (!dialogs.length) return false;
          const dialog = dialogs.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
          const checkboxes = [...dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible);
          const checkbox = checkboxes.find(candidate => {
            const label = normalize([candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.closest('label')?.innerText, candidate.parentElement?.innerText].filter(Boolean).join(' '));
            return (config.checkboxTexts || []).some(expected => label.includes(normalize(expected)));
          });
          if (!checkbox || checkboxes.length !== 1) return false;
          checkbox.click();
          let checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
          if (!checked) {
            const label = checkbox.closest('label') || checkbox.parentElement;
            if (label) label.click();
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            checked = checkbox.matches('[role="checkbox"]') ? checkbox.getAttribute('aria-checked') === 'true' : checkbox.checked === true;
          }
          return checked;
        })()`).catch(() => false);
        if (domChecked !== true && domChecked !== 'true') {
          const clicked = await foregroundClick({ x: state.x, y: state.y, tabId });
          if (!clicked) throw new Error(`${platform.label || platform.id} 主账号密钥风险复选框无法点击，未创建或保存密钥`);
        }
        await sleep(300);
      } else if (attempt + 1 < attempts) {
        await sleep(400);
      }
    }
    if (!acknowledged) throw new Error(`${platform.label || platform.id} 主账号密钥风险确认未完成，未创建或保存密钥（${lastAcknowledgeState.reason || 'unknown'}${Number.isFinite(lastAcknowledgeState.count) ? `:${lastAcknowledgeState.count}` : ''}）`);
    await sleep(700);
  }

  // Mistral's workspace action first opens the user's key-management panel;
  // enter its real form through the panel's visible "Create new key" action.
  if (platform.formEntryTexts?.length) {
    let formEntryState = { error: 'form-entry-not-found', buttons: [] };
    const formEntryAttempts = Math.max(1, Number(platform.formEntryWaitAttempts) || 5);
    for (let attempt = 0; attempt < formEntryAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 500 : 500);
      const raw = await execJs(`(() => {
        const texts = ${JSON.stringify(platform.formEntryTexts)};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
        };
        const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
        const target = candidates.find(el => texts.some(text => (el.textContent || '').trim().toLowerCase() === text.toLowerCase()));
        if (!target) return JSON.stringify({ error: 'form-entry-not-found', buttons: candidates.map(el => (el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16) });
        target.click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{}');
      try { formEntryState = JSON.parse(raw || '{}'); } catch { formEntryState = {}; }
      if (!formEntryState.error) break;
    }
    if (formEntryState.error && !platform.formEntryOptional) {
      throw new Error(`未找到创建密钥表单入口：${(formEntryState.buttons || []).join('、') || platform.formEntryTexts.join('、')}`);
    }
    await sleep(350);
  }

  // Several consoles keep the list page mounted while an asynchronous route
  // transition loads the actual creation form. In that interval the page can
  // still contain unrelated buttons (for example the BCE AI assistant's
  // recommendations). Poll only for the configured form input or confirmation
  // action so those unrelated buttons can never be reported as the form.
  const formReadyAttempts = Math.max(1, Number(platform.formReadyAttempts) || 1);
  const formReadyDelayMs = Math.max(150, Number(platform.formReadyDelayMs) || 500);
  let formReadyState = { ready: formReadyAttempts === 1, nameInput: false, confirmButton: false, buttons: [] };
  for (let attempt = 0; attempt < formReadyAttempts; attempt += 1) {
    await sleep(attempt === 0 ? 1200 : formReadyDelayMs);
    const readyRaw = await execJs(`(() => {
      const selectors = ${JSON.stringify(platform.nameSelectors || [])};
      const confirmTexts = ${JSON.stringify(platform.confirmTexts || [])};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.disabled;
      };
      const scopes = [...document.querySelectorAll('[role="dialog"], .ant-modal, .modal, [class*="dialog"], [class*="modal"]'), document];
      const nameInput = selectors.length > 0 && scopes.some(scope => selectors.some(selector => {
        const input = scope.querySelector(selector);
        return Boolean(input && visible(input));
      }));
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      const confirmButton = buttons.some(button => {
        const label = (button.textContent || '').trim().replace(/\\s+/g, '').toLowerCase();
        return confirmTexts.some(text => {
          const expected = String(text).replace(/\\s+/g, '').toLowerCase();
          return label === expected || label.startsWith(expected);
        });
      });
      return JSON.stringify({ ready: Boolean(nameInput || confirmButton), nameInput, confirmButton, buttons: buttons.map(button => (button.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(-16) });
    })()`).catch(() => '{}');
    try { formReadyState = JSON.parse(readyRaw || '{}'); } catch { formReadyState = {}; }
    if (formReadyState.ready) break;
  }
  if (formReadyAttempts > 1 && !formReadyState.ready) {
    throw new Error(`创建密钥表单加载超时：${(formReadyState.buttons || []).join('、') || '请确认已登录并拥有创建权限'}`);
  }
  // A name is optional across platforms. Populate it when the create dialog
  // exposes a conventional input; platforms that create unnamed keys continue.
    return { tokenName, platform, run, uniqueName, tabId };
  };
}

module.exports = { createGenericNavigationStrategy };
