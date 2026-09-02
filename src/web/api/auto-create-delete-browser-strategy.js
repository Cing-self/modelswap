// Shared fail-closed browser deletion orchestration.
function createBrowserDeleteStrategy(deps) {
  const { sendCommand, execJs, sleep, closeAutomationWindow, foregroundClick, waitForInteractiveVerification, waitForSecurityVerificationToClear, deleteAnthropicBrowserKey, deleteZhipuBrowserKey, deleteMoonshotBrowserKey, getBrowserPlatformUrl, isLoginUrl } = deps;
async function deleteCreatedBrowserKey({ platform, createdName, run = null }) {
  if (!platform || !createdName) throw new Error('删除测试密钥需要 platform 和 createdName');
  if (platform.cleanupMode === 'never') {
    throw new Error(`${platform.label || platform.id} 的自动创建流程复用或生成订阅密钥，禁止自动删除`);
  }
  const url = platform.deleteUrl || getBrowserPlatformUrl(platform);
  if (!url) throw new Error(`${platform.label || platform.id} 没有可用的删除控制台地址`);

  const nav = await sendCommand('navigate', { url, workspace: 'modelswap' }, 30000);
  if (!nav.ok) throw new Error(nav.error || '打开删除密钥页面失败');
  const tabId = nav.data?.tabId;
  if (isLoginUrl(nav.data?.url)) throw new Error(`${platform.label || platform.id} 删除前需要登录`);
  // Anthropic's settings SPA acknowledges navigation before the workspace key
  // table has mounted. Give the route one render window before the exact-row
  // cleanup loop starts; the loop still fails closed if the row/action remains
  // ambiguous.
  if (platform.id === 'anthropic') {
    await sleep(1800);
    return deleteAnthropicBrowserKey({ createdName, tabId });
  }
  if (platform.id === 'zhipu') return deleteZhipuBrowserKey({ createdName, tabId });
  if (platform.id === 'moonshot') return deleteMoonshotBrowserKey({ createdName, tabId });
  if (platform.deleteReload) {
    // Some same-URL SPAs preserve the pre-create list in memory after the
    // navigation command. Reload only the configured provider page so the
    // exact newly-created test row becomes observable before deletion.
    await execJs('location.reload(); "reloading"').catch(() => {});
    await sleep(Math.max(500, Number(platform.deleteReloadWaitMs) || 1500));
  }
  if (platform.deletePreDismissTexts?.length) {
    await execJs(`(() => {
      const texts = ${JSON.stringify(platform.deletePreDismissTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const target = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(el => texts.includes((el.textContent || '').trim()));
      if (target) target.click();
      return target ? 'dismissed' : 'not-found';
    })()`).catch(() => 'not-found');
    await sleep(350);
  }
  const lookupName = platform.deleteDisplayNameLength
    ? createdName.slice(0, Number(platform.deleteDisplayNameLength))
    : createdName;
  if (platform.deletePreNavigationTexts?.length) {
    let preNavigated = false;
    for (let attempt = 0; attempt < 8 && !preNavigated; attempt += 1) {
      const raw = await execJs(`(() => {
        const texts = ${JSON.stringify(platform.deletePreNavigationTexts)};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const candidates = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')]
          .filter(visible)
          .filter(el => texts.some(text => (el.textContent || '').trim() === text));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        const rect = candidates[0].getBoundingClientRect();
        return JSON.stringify({
          ok: true,
          href: candidates[0].getAttribute('href') || candidates[0].closest('a')?.getAttribute('href') || '',
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      })()`).catch(() => '{"ok":false}');
      let state = {};
      try { state = JSON.parse(raw || '{}'); } catch {}
      if (state.ok && platform.deletePreNavigationUseHref && state.href) {
        const exactUrl = new URL(state.href, url).href;
        const directNav = await sendCommand('navigate', { url: exactUrl, workspace: 'modelswap' }, 30000);
        preNavigated = Boolean(directNav.ok);
      } else if (state.ok && platform.deletePreNavigationUseHref && Number.isFinite(state.x) && Number.isFinite(state.y)) {
        preNavigated = await foregroundClick({ x: state.x, y: state.y, tabId });
      } else {
        preNavigated = Boolean(state.ok);
      }
      if (!preNavigated) await sleep(700);
    }
    if (!preNavigated) throw new Error(`${platform.label || platform.id} 删除前未找到导航入口：${platform.deletePreNavigationTexts.join('、')}`);
    await sleep(1000);
  }
  if (platform.deleteReadyAttempts) {
    let ready = false;
    for (let attempt = 0; attempt < Number(platform.deleteReadyAttempts) && !ready; attempt += 1) {
      const readyRaw = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const selector = ${JSON.stringify(platform.deleteButtonSelector || '')};
        const bodyText = document.body?.innerText || '';
        const hasTarget = bodyText.includes(targetName);
        const hasAction = !selector || Boolean(document.querySelector(selector));
        return JSON.stringify({ ready: hasTarget && hasAction, hasTarget, hasAction, loading: /Loading\\.\\.\\./i.test(bodyText) });
      })()`).catch(() => '{"ready":false}');
      let readyState = {};
      try { readyState = JSON.parse(readyRaw || '{}'); } catch {}
      ready = Boolean(readyState.ready);
      if (!ready) await sleep(1000);
    }
    if (!ready) throw new Error(`${platform.label || platform.id} 删除页面加载超时，未找到名称完全匹配的测试密钥：${createdName}`);
  }

  const deleteTexts = platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'];
  const deleteMenuTexts = platform.deleteMenuTexts || ['更多操作', 'More actions', '更多', 'More', '⋯', '…'];
  let clickState = null;
  for (let attempt = 0; attempt < 12 && !clickState?.ok; attempt += 1) {
    const raw = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(deleteTexts)};
      const deleteMenuTexts = ${JSON.stringify(deleteMenuTexts)};
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const labelOf = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').trim();
      const matchesDelete = el => {
        const label = normalize(labelOf(el));
        return deleteTexts.some(text => {
          const expected = normalize(text);
          return label === expected || label.includes(expected);
        }) && !/cancel|取消|close|关闭/i.test(label);
      };
      const matchesMenu = el => {
        const label = normalize(labelOf(el));
        return deleteMenuTexts.some(text => {
          const expected = normalize(text);
          return label === expected || label.includes(expected);
        }) && !/cancel|取消|close|关闭/i.test(label);
      };
      const clickTarget = (el, extra = {}) => {
        const rect = el.getBoundingClientRect();
        return { ...extra, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, action: labelOf(el).slice(0, 100) };
      };
      const exactRowMenus = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(el => visible(el)
          && normalize(labelOf(el)).includes(normalize(targetName))
          && (/more actions|更多操作|更多|more|⋯|…/i.test(labelOf(el)) || matchesMenu(el)));
      if (exactRowMenus.length === 1) {
        exactRowMenus[0].click();
        return JSON.stringify({ ok: false, menu: true, domClicked: true, action: labelOf(exactRowMenus[0]).slice(0, 100) });
      }
      const configuredSelector = ${JSON.stringify(platform.deleteButtonSelector || '')};
      const deleteTextSelector = ${JSON.stringify(platform.deleteTextSelector || '')};
      const containers = [...document.querySelectorAll('tr, [role="row"], li, article, section, [data-testid], div')]
        .filter(el => visible(el) && (el.innerText || '').includes(targetName))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      // A row-action menu can already be open from the previous retry. Consume
      // its exact destructive action before clicking the row trigger again;
      // otherwise menu-based consoles (for example OpenRouter) just toggle the
      // menu closed and never reach the delete item.
      const activeMenus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')]
        .filter(visible);
      for (const menu of activeMenus) {
        const actions = [...menu.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(el => visible(el) && matchesDelete(el));
        if (actions.length === 1) return JSON.stringify(clickTarget(actions[0], { ok: true, fromMenu: true }));
      }
      for (const container of containers) {
        const controls = [...container.querySelectorAll('button, a, [role="button"]' + (deleteTextSelector ? ', ' + deleteTextSelector : ''))].filter(visible);
        const configuredIndex = Number.isInteger(${JSON.stringify(platform.deleteButtonIndex)})
          ? ${JSON.stringify(platform.deleteButtonIndex)}
          : null;
        if (configuredIndex !== null && configuredIndex >= 0 && controls.length > configuredIndex) {
          return JSON.stringify(clickTarget(controls[configuredIndex], { ok: true, configuredIndex }));
        }
        if (configuredSelector) {
          const configured = [...container.querySelectorAll(configuredSelector)].filter(visible);
          if (configured.length === 1) return JSON.stringify(clickTarget(configured[0], { ok: true }));
        }
        if (${platform.deleteTextOnly ? 'true' : 'false'}) {
          const textActions = [...container.querySelectorAll('*')]
            .filter(visible)
            .filter(el => !el.children.length && matchesDelete(el));
          if (textActions.length === 1) return JSON.stringify(clickTarget(textActions[0], { ok: true, textOnly: true }));
        }
        const actions = controls.filter(matchesDelete);
        if (actions.length !== 1) continue;
        return JSON.stringify(clickTarget(actions[0], { ok: true }));
      }
      // Some consoles, including Claude Platform, keep destructive actions
      // behind a row-specific "More actions" menu. Open only the menu in the
      // exact row, then look for the delete item in the visible menu.
      for (const container of containers) {
        const menus = [...container.querySelectorAll('button, a, [role="button"]')].filter(el => visible(el) && matchesMenu(el));
        if (menus.length !== 1) continue;
        return JSON.stringify(clickTarget(menus[0], { ok: false, menu: true }));
      }
      const visibleMenus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')]
        .filter(visible)
        .filter(menu => ${platform.deleteMenuGlobal ? 'true' : `normalize(String(menu.innerText || '') + ' ' + labelOf(menu)).includes(normalize(targetName))`});
      for (const menu of visibleMenus) {
        const actions = [...menu.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(el => visible(el) && matchesDelete(el));
        if (actions.length === 1) return JSON.stringify(clickTarget(actions[0], { ok: true, fromMenu: true }));
      }
      return JSON.stringify({ ok: false, foundName: containers.length > 0 });
    })()`).catch(() => '{"ok":false}');
    try { clickState = JSON.parse(raw || '{}'); } catch { clickState = { ok: false }; }
    if (clickState?.menu) {
      if (!clickState.domClicked && !await foregroundClick({ x: clickState.x, y: clickState.y, tabId })) {
        await closeAutomationWindow();
        throw new Error(`无法打开测试密钥操作菜单：${createdName}`);
      }
      clickState = null;
      await sleep(350);
      continue;
    }
    if (!clickState.ok) await sleep(800);
  }
  // Last-resort exact-row fallback for consoles that expose the row action
  // through an accessible label but do not make the surrounding row stable
  // enough for the generic container scan. It still requires the full test
  // name, then resolves exactly one destructive item from the opened menu.
  if (!clickState?.ok) {
    const fallbackOpen = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .filter(el => {
          const value = label(el).toLowerCase();
          return value.includes(targetName.toLowerCase()) && /more actions|更多操作|更多/.test(value);
        });
      if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
      candidates[0].click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    let fallbackState = {};
    try { fallbackState = JSON.parse(fallbackOpen || '{}'); } catch {}
    if (fallbackState.ok) {
      await sleep(350);
      const fallbackDelete = await execJs(`(() => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
        const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')].filter(visible);
        const scope = menus.length ? menus : [document];
        const candidates = scope.flatMap(root => [...root.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')])
          .filter(visible)
          .filter(el => /delete|revoke|remove|删除|撤销/i.test(label(el)) && !/cancel|取消|close|关闭/i.test(label(el)));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true, domClicked: true });
      })()`).catch(() => '{"ok":false}');
      let fallbackDeleteState = {};
      try { fallbackDeleteState = JSON.parse(fallbackDelete || '{}'); } catch {}
      if (fallbackDeleteState.ok && fallbackDeleteState.domClicked) {
        clickState = { ok: true };
      }
    }
  }
  if (!clickState?.ok) {
    const diagnostic = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const redact = value => String(value || '')
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
        .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
      const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').trim().slice(0, 120);
      const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')]
        .filter(visible).map(label).filter(Boolean).slice(-30);
      const exactLabels = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .map(el => ({ value: label(el).slice(0, 160), target: label(el).toLowerCase().includes(${JSON.stringify(lookupName.toLowerCase())}), more: /more actions|更多操作|更多/i.test(label(el)) }))
        .filter(item => item.target);
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(visible).map(el => redact((el.innerText || '').trim()).slice(0, 240)).filter(Boolean).slice(-12);
      return JSON.stringify({ url: location.href.slice(-160), title: document.title.slice(0, 80), controls, exactLabels, rows });
    })()`).catch(() => '{}');
    await closeAutomationWindow();
    throw new Error(`未找到名称完全匹配的删除操作：${createdName}。页面诊断：${diagnostic}`);
  }

  let deleteClicked = false;
  if (platform.deleteDomFirst) {
    const domDeleteRaw = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'])};
      const deleteTextSelector = ${JSON.stringify(platform.deleteTextSelector || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return JSON.stringify({ ok: false, reason: 'row-count', count: rows.length });
      const controls = [...rows[0].querySelectorAll('button, a, [role="button"]' + (deleteTextSelector ? ', ' + deleteTextSelector : ''))]
        .filter(visible)
        .filter(control => deleteTexts.some(text => normalize(label(control)) === normalize(text)));
      if (controls.length !== 1) return JSON.stringify({ ok: false, reason: 'control-count', count: controls.length });
      controls[0].click();
      return JSON.stringify({ ok: true });
    })()`).catch(() => '{"ok":false}');
    try { deleteClicked = Boolean(JSON.parse(domDeleteRaw || '{}').ok); } catch { deleteClicked = false; }
    if (deleteClicked) {
      await sleep(350);
      const dialogVisible = await execJs(`(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')].some(dialog => {
        const rect = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }))()`).catch(() => false);
      if (dialogVisible !== true && dialogVisible !== 'true') deleteClicked = false;
    }
  }
  if (!deleteClicked) deleteClicked = await foregroundClick({ x: clickState.x, y: clickState.y, tabId });
  if (!deleteClicked) {
    for (let attempt = 0; attempt < 5 && !deleteClicked; attempt += 1) {
      const domDeleteRaw = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const configuredSelector = ${JSON.stringify(platform.deleteButtonSelector || '')};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
        const candidates = [...document.querySelectorAll('button, a, [role="menuitem"], [role="option"], [role="button"]')]
          .filter(visible)
          .filter(el => (configuredSelector && el.matches(configuredSelector))
            || (/delete api key|删除 API key|删除密钥|delete key/i.test(label(el))
              && !/cancel|取消|close|关闭/i.test(label(el))));
        if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
        candidates[0].click();
        return JSON.stringify({ ok: true });
      })()`).catch(() => '{"ok":false}');
      let domDeleteState = {};
      try { domDeleteState = JSON.parse(domDeleteRaw || '{}'); } catch {}
      deleteClicked = Boolean(domDeleteState.ok);
      if (!deleteClicked) await sleep(350);
    }
  }
  if (!deleteClicked) {
    await closeAutomationWindow();
    throw new Error(`无法点击测试密钥删除操作：${createdName}`);
  }
  await sleep(500);
  // Some provider consoles replace the normal delete confirmation with an
  // account-level security challenge immediately after the row action. Detect
  // that state before looking for a confirmation button; otherwise the
  // challenge's unrelated buttons are reported as an ambiguous delete
  // confirmation and the exact-row cleanup is stopped too early.
  if (platform.deleteSecurityVerificationTexts?.length) {
    const earlySecurityRaw = await execJs(`(() => {
      const phrases = ${JSON.stringify(platform.deleteSecurityVerificationTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
      const match = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .find(dialog => phrases.some(phrase => normalize(dialog.innerText || '').includes(normalize(phrase))));
      return JSON.stringify(match ? { matched: true, text: String(match.innerText || '').trim().slice(0, 180) } : { matched: false });
    })()`).catch(() => '{"matched":false}');
    let earlySecurityState = {};
    try { earlySecurityState = JSON.parse(earlySecurityRaw || '{}'); } catch {}
    if (earlySecurityState.matched) {
      if (run) {
        await waitForInteractiveVerification({ run, platform, stage: 'delete-security-verification' });
      } else {
        await waitForSecurityVerificationToClear({ platform, stage: 'delete' });
      }
      const remainingAfterSecurity = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        return [...document.querySelectorAll('tr, [role="row"], li, article')]
          .some(row => (row.innerText || '').includes(targetName));
      })()`).catch(() => true);
      if (!remainingAfterSecurity) {
        await closeAutomationWindow();
        return { success: true, platform: platform.id, name: createdName };
      }
    }
  }
  if (platform.deleteAllowMissingAfterClick) {
    const postClickStateRaw = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const bodyText = document.body?.innerText || '';
      const exactRowPresent = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .some(row => visible(row) && (row.innerText || '').includes(${JSON.stringify(lookupName)}));
      const securityVisible = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .some(dialog => visible(dialog) && /安全验证|短信验证码|MFA|身份验证/i.test(dialog.innerText || ''));
      const expectedPage = location.hash === '#/iam/apikey/list'
        && /API Key/.test(bodyText)
        && (bodyText.includes('暂无数据') || bodyText.includes('总共') || bodyText.includes('已创建') || bodyText.includes('名称'));
      return JSON.stringify({ exactRowPresent, securityVisible, expectedPage });
    })()`).catch(() => '{}');
    let postClickState = {};
    try { postClickState = JSON.parse(postClickStateRaw || '{}'); } catch {}
    if (postClickState.expectedPage && !postClickState.exactRowPresent && !postClickState.securityVisible) {
      await closeAutomationWindow();
      return { success: true, platform: platform.id, name: createdName };
    }
  }
  if (platform.deleteConfirmInputText) {
    const confirmInputResult = await execJs(`(() => {
      const selector = ${JSON.stringify(platform.deleteConfirmInputSelector || 'input, textarea')};
      const expected = ${JSON.stringify(platform.deleteConfirmInputText)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      // Some Ant Design dialogs are exposed through the accessibility tree
      // before their wrapper is discoverable from the extension's execution
      // context. The configured selector is exact, so scan the document and
      // still require a single visible match rather than trusting the wrapper.
      const scopes = [document];
      const inputs = scopes.flatMap(scope => [...scope.querySelectorAll(selector)]).filter(visible);
      if (inputs.length !== 1) return 'input-count:' + inputs.length;
      const input = inputs[0];
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, expected);
      else input.value = expected;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value === expected ? 'filled' : 'value-mismatch';
    })()`).catch(error => `error:${error.message || error}`);
    if (confirmInputResult !== 'filled') {
      await closeAutomationWindow();
      throw new Error(`删除确认文本输入失败（${confirmInputResult}）：${createdName}`);
    }
    await sleep(300);
  }
  if (platform.deleteConfirmInputFromDialog) {
    let dynamicConfirmInput = 'not-found';
    for (let attempt = 0; attempt < 10 && dynamicConfirmInput !== 'filled'; attempt += 1) {
      dynamicConfirmInput = await execJs(`(() => {
      const hint = ${JSON.stringify(platform.deleteDialogText || '')}.replace(/[\\s\\u3000]+/g, '');
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .filter(dialog => !hint || String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '').includes(hint))
        .filter(dialog => [...dialog.querySelectorAll('input, textarea')].some(visible));
      const hintedDialogs = [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter(dialog => !hint || String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '').includes(hint))
        .filter(dialog => [...dialog.querySelectorAll('input, textarea')].some(visible))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const dialogs = (semanticDialogs.length ? semanticDialogs : hintedDialogs)
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      if (!dialogs.length) return 'dialog-count:0';
      const dialog = dialogs[0];
      const inputs = [...dialog.querySelectorAll('input, textarea')].filter(visible);
      if (inputs.length !== 1) return 'input-count:' + inputs.length;
      const compactText = String(dialog.innerText || '').replace(/[\\s\\u3000]+/g, '');
      const match = compactText.match(/请输入([A-Za-z0-9_-]{4,32})确认删除/);
      if (!match) return 'confirmation-code-not-found';
      const input = inputs[0];
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, match[1]); else input.value = match[1];
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: match[1] }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return input.value === match[1] ? 'filled' : 'value-mismatch';
      })()`).catch(error => `error:${error.message || error}`);
      if (dynamicConfirmInput !== 'filled') await sleep(400);
    }
    if (dynamicConfirmInput !== 'filled') {
      await closeAutomationWindow();
      throw new Error(`删除确认动态文本输入失败（${dynamicConfirmInput}）：${createdName}`);
    }
    await sleep(300);
  }
  if (platform.deleteDomRetry) {
    await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      const deleteTexts = ${JSON.stringify(platform.deleteTexts || ['删除', 'Delete', 'Revoke', '撤销', 'Remove'])};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"]')].filter(visible);
      if (dialogs.length) return 'dialog-present';
      const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
        .filter(row => visible(row) && (row.innerText || '').includes(targetName));
      if (rows.length !== 1) return 'row-count:' + rows.length;
      const controls = [...rows[0].querySelectorAll('button, a, [role="button"]')]
        .filter(visible)
        .filter(el => deleteTexts.some(text => normalize([el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ')) === normalize(text)));
      if (controls.length !== 1) return 'control-count:' + controls.length;
      controls[0].click();
      return 'clicked';
    })()`).catch(() => 'failed');
    await sleep(500);
  }
  if (platform.deleteNoConfirm) {
    if (platform.deleteNoConfirmDomRetry) {
      await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        const deleteTexts = ${JSON.stringify(platform.deleteTexts || [])};
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        };
        const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
        const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, ' ').trim().toLowerCase();
        const rows = [...document.querySelectorAll('tr, [role="row"], li, article')]
          .filter(row => visible(row) && (row.innerText || '').includes(targetName));
        if (rows.length !== 1) return 'row-count:' + rows.length;
        const controls = [...rows[0].querySelectorAll('button, a, [role="button"]')]
          .filter(visible)
          .filter(el => deleteTexts.some(text => normalize(label(el)) === normalize(text)));
        if (controls.length !== 1) return 'control-count:' + controls.length;
        controls[0].click();
        return 'clicked';
      })()`).catch(() => 'failed');
      await sleep(500);
    }
    if (platform.deleteNoConfirmReload) {
      await execJs('location.reload(); "reloading"').catch(() => {});
      await sleep(Math.max(500, Number(platform.deleteNoConfirmReloadWaitMs) || 1200));
    }
    let remaining = true;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(500);
      remaining = await execJs(`(() => {
        const targetName = ${JSON.stringify(lookupName)};
        return [...document.querySelectorAll('body *')].some(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
        });
      })()`).catch(() => true);
      if (!remaining) break;
    }
    await closeAutomationWindow();
    if (remaining) throw new Error(`删除后仍能看到测试密钥：${createdName}`);
    return { success: true, platform: platform.id, name: createdName };
  }

  let confirmRaw = '{"ok":false}';
  let confirmState = {};
  const confirmAttempts = Math.max(1, Number(platform.deleteConfirmWaitAttempts) || 1);
  for (let attempt = 0; attempt < confirmAttempts && !confirmState.ok; attempt += 1) {
    confirmRaw = await execJs(`(() => {
    const configuredConfirmTexts = ${JSON.stringify(platform.deleteConfirmTexts || [])};
    const dialogTextHint = ${JSON.stringify(platform.deleteDialogText || '')};
    const configuredConfirmSelector = ${JSON.stringify(platform.deleteConfirmSelector || '')};
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
    };
    const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
    const hintedDialogs = dialogTextHint
      ? [...document.querySelectorAll('body *')]
        .filter(visible)
        .filter(el => String(el.innerText || '').replace(/[\s\u3000]+/g, '').includes(dialogTextHint.replace(/[\s\u3000]+/g, '')))
        .filter(el => [...el.querySelectorAll('button, [role="button"]')].some(visible))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
      : [];
    const dialogs = hintedDialogs.length
      ? [hintedDialogs[0]]
      : (semanticDialogs.length ? semanticDialogs : [...document.querySelectorAll('.modal, [class*="dialog"], [class*="modal"]')].filter(visible));
    const controls = (dialogs.length
      ? dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
      : [...document.querySelectorAll('button, [role="button"]')]).filter(visible);
    if (configuredConfirmSelector) {
      const selectorCandidates = [...document.querySelectorAll(configuredConfirmSelector)].filter(visible);
      if (selectorCandidates.length === 1) {
        const rect = selectorCandidates[0].getBoundingClientRect();
        return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
    }
    const candidates = controls.filter(el => {
      const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
      const compact = label.replace(/[\s\u3000]+/g, '');
      const matchesConfigured = configuredConfirmTexts.length > 0
        && configuredConfirmTexts.some(text => compact.includes(String(text).replace(/[\s\u3000]+/g, '')));
      if (configuredConfirmTexts.length > 0) return matchesConfigured;
      return /delete|revoke|remove|confirm|确定|确认|删除|撤销/i.test(compact) && !/cancel|取消|close|关闭/i.test(compact);
    });
    if (candidates.length !== 1) return JSON.stringify({ ok: false, count: candidates.length });
    const rect = candidates[0].getBoundingClientRect();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`).catch(() => '{"ok":false}');
    try { confirmState = JSON.parse(confirmRaw || '{}'); } catch { confirmState = {}; }
    if (!confirmState.ok && attempt + 1 < confirmAttempts) await sleep(500);
  }
  if (!confirmState.ok) {
    await closeAutomationWindow();
    throw new Error(`删除确认按钮不唯一（候选 ${Number(confirmState.count) || 0} 个），已停止以避免误删：${createdName}`);
  }
  let confirmClicked = await foregroundClick({ x: confirmState.x, y: confirmState.y, tabId });
  if (!confirmClicked) {
    const domConfirm = await execJs(`(() => {
      const configuredConfirmTexts = ${JSON.stringify(platform.deleteConfirmTexts || [])};
      const dialogTextHint = ${JSON.stringify(platform.deleteDialogText || '')};
      const configuredConfirmSelector = ${JSON.stringify(platform.deleteConfirmSelector || '')};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const semanticDialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
      const hintedDialogs = dialogTextHint
        ? [...document.querySelectorAll('body *')]
          .filter(visible)
          .filter(el => String(el.innerText || '').replace(/[\s\u3000]+/g, '').includes(dialogTextHint.replace(/[\s\u3000]+/g, '')))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        : [];
      const dialogs = hintedDialogs.length
        ? [hintedDialogs[0]]
        : (semanticDialogs.length ? semanticDialogs : [...document.querySelectorAll('.modal, [class*="dialog"], [class*="modal"]')].filter(visible));
      const candidates = (dialogs.length
        ? dialogs.flatMap(dialog => [...dialog.querySelectorAll('button, [role="button"]')])
        : [...document.querySelectorAll('button, [role="button"]')])
        .filter(visible)
        .filter(el => {
          const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
          const compact = label.replace(/[\s\u3000]+/g, '');
          const matchesConfigured = configuredConfirmTexts.length > 0
            && configuredConfirmTexts.some(text => compact.includes(String(text).replace(/[\s\u3000]+/g, '')));
          if (configuredConfirmTexts.length > 0) return matchesConfigured;
          return /delete|revoke|remove|confirm|确定|确认|删除|撤销/i.test(compact)
            && !/cancel|取消|close|关闭/i.test(compact);
        });
      if (configuredConfirmSelector) {
        const selectorCandidates = [...document.querySelectorAll(configuredConfirmSelector)].filter(visible);
        if (selectorCandidates.length === 1) {
          selectorCandidates[0].click();
          return true;
        }
      }
      if (candidates.length !== 1) return false;
      candidates[0].click();
      return true;
    })()`).catch(() => false);
    confirmClicked = domConfirm === true || domConfirm === 'true';
  }
  if (!confirmClicked) {
    await closeAutomationWindow();
    throw new Error(`无法确认删除测试密钥：${createdName}`);
  }

  if (platform.deleteSecurityVerificationTexts?.length) {
    const securityRaw = await execJs(`(() => {
      const phrases = ${JSON.stringify(platform.deleteSecurityVerificationTexts)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = value => String(value || '').replace(/[\\s\\u3000]+/g, '').toLowerCase();
      const match = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="dialog"]')]
        .filter(visible)
        .find(dialog => phrases.some(phrase => normalize(dialog.innerText || '').includes(normalize(phrase))));
      return JSON.stringify(match ? { matched: true, text: String(match.innerText || '').trim().slice(0, 180) } : { matched: false });
    })()`).catch(() => '{"matched":false}');
    let securityState = {};
    try { securityState = JSON.parse(securityRaw || '{}'); } catch {}
    if (securityState.matched) {
      if (run) {
        await waitForInteractiveVerification({ run, platform, stage: 'delete-security-verification' });
      } else {
        await waitForSecurityVerificationToClear({ platform, stage: 'delete' });
      }
    }
  }

  let remaining = true;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(500);
    remaining = await execJs(`(() => {
      const targetName = ${JSON.stringify(lookupName)};
      return [...document.querySelectorAll('body *')].some(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
      });
    })()`).catch(() => true);
    if (!remaining) break;
  }
  if (remaining && platform.deleteConfirmDomRetry) {
    const retryDelete = await execJs(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter(button => (button.textContent || '').trim() === 'Confirm');
      if (buttons.length !== 1) return false;
      buttons[0].click();
      return true;
    })()`).catch(() => false);
    if (retryDelete === true || retryDelete === 'true') {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await sleep(500);
        remaining = await execJs(`(() => {
          const targetName = ${JSON.stringify(lookupName)};
          return [...document.querySelectorAll('body *')].some(el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && (el.innerText || '').trim() === targetName && style.display !== 'none' && style.visibility !== 'hidden';
          });
        })()`).catch(() => true);
        if (!remaining) break;
      }
    }
  }
  await closeAutomationWindow();
  if (remaining) throw new Error(`删除后仍能看到测试密钥：${createdName}`);
  return { success: true, platform: platform.id, name: createdName };
}

  return { deleteCreatedBrowserKey };
}
module.exports = { createBrowserDeleteStrategy };
