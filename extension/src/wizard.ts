/**
 * MODELSWAP capture wizard — page-guided overlay (demo, handoff §4.3.2).
 *
 * Injected alongside copy-guard into request-domain tabs. Renders a top bar
 * with the request's steps plus a spotlight around the element named by the
 * active step's selector ("display text@@css selector" in --step). Steps
 * advance on their own when a pattern-matched capture for this request lands
 * (the spotlight is only a suggestion), or manually via buttons. When every
 * key is stored the wizard announces completion and removes itself.
 *
 * Self-contained IIFE on purpose: content scripts are plain tsc output with
 * no bundler, so this file must not import anything (see copy-guard.ts).
 */

(() => {
  const w = window as unknown as { __modelswapWizard?: boolean };
  if (w.__modelswapWizard) return;
  w.__modelswapWizard = true;

  interface WizardItem {
    key: string;
    status: "pending" | "fulfilled";
    url?: string;
    steps?: string[];
    pattern?: string;
  }
  interface WizardRequest {
    id: string;
    createdAt: number;
    expiresAt: number;
    fulfilled: boolean;
    items: WizardItem[];
  }

  const DANGER = /regenerate|delete|destroy|revoke|删除|撤销|重置|作废/i;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function registrableDomain(url: string): string | null {
    try { return new URL(url).hostname.split(".").slice(-2).join("."); } catch { return null; }
  }

  function splitStep(raw: string): { text: string; selector?: string } {
    const at = raw.indexOf("@@");
    return at === -1 ? { text: raw } : { text: raw.slice(0, at), selector: raw.slice(at + 2) };
  }

  /** Newest pending request on this page's domain that carries guided steps. */
  function matchingRequest(reqs: WizardRequest[]): WizardRequest | null {
    const now = Date.now();
    const domain = registrableDomain(location.href);
    if (!domain) return null;
    const candidates = reqs
      .filter((r) => r.expiresAt > now && !r.fulfilled && r.items.some((i) => i.status === "pending"))
      .filter((r) => r.items.some((i) => i.url && registrableDomain(i.url) === domain))
      .filter((r) => r.items.some((i) => i.steps?.some((s) => s.includes("@@"))))
      .sort((a, b) => b.createdAt - a.createdAt);
    return candidates[0] ?? null;
  }

  // ─── Style (first page-injected stylesheet in this extension) ───────
  const style = document.createElement("style");
  style.id = "msw-wiz-style";
  style.textContent = `
.msw-wiz-bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 2147483646; background: #101014; color: #ececee;
  border: 1px solid #3a3a41; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.35); padding: 10px 14px;
  font: 12.5px/1.5 system-ui, -apple-system, sans-serif;
  max-width: min(600px, calc(100vw - 24px)); }
.msw-wiz-title { font-size: 10.5px; letter-spacing: .6px; color: #8e8e96; margin-bottom: 2px; }
.msw-wiz-step { font-size: 13px; font-weight: 600; }
.msw-wiz-note { font-size: 11.5px; color: #8e8e96; margin-top: 2px; }
.msw-wiz-actions { display: flex; gap: 6px; margin-top: 8px; }
.msw-wiz-actions button { font: inherit; font-size: 12px; color: #ececee; background: #1c1c20;
  border: 1px solid #3a3a41; border-radius: 7px; padding: 4px 10px; cursor: pointer; }
.msw-wiz-actions button:hover { background: #232328; }
.msw-wiz-spot { position: fixed; z-index: 2147483645; border: 2px solid #22c55e;
  border-radius: 8px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, .55);
  pointer-events: none; }
.msw-wiz-spot.danger { border-color: #ef4444; }
.msw-wiz-tip { position: fixed; z-index: 2147483647; background: #22c55e; color: #052e16;
  font: 600 11px/1 system-ui, -apple-system, sans-serif; padding: 4px 9px;
  border-radius: 999px; white-space: nowrap; }
.msw-wiz-tip.danger { background: #ef4444; color: #fff; }
`;
  document.documentElement.appendChild(style);

  // ─── Persistent overlay elements ────────────────────────────────────
  const bar = el("div", "msw-wiz-bar");
  const title = el("div", "msw-wiz-title");
  const stepText = el("div", "msw-wiz-step");
  const note = el("div", "msw-wiz-note");
  const actions = el("div", "msw-wiz-actions");
  const spot = el("div", "msw-wiz-spot");
  const tip = el("div", "msw-wiz-tip");
  document.documentElement.append(bar, spot, tip);
  bar.append(title, stepText, note, actions);

  let steps: Array<{ text: string; selector?: string }> = [];
  let active = 0;
  let lastFulfilled = 0;
  let currentReqId: string | null = null;
  let closed = false;
  let targetEl: Element | null = null;

  function teardown(): void {
    if (closed) return;
    closed = true;
    bar.remove(); spot.remove(); tip.remove(); style.remove();
  }

  function positionSpotlight(): void {
    if (!targetEl || closed) return;
    const r = targetEl.getBoundingClientRect();
    spot.style.top = `${r.top - 6}px`;
    spot.style.left = `${r.left - 6}px`;
    spot.style.width = `${r.width + 12}px`;
    spot.style.height = `${r.height + 12}px`;
    // tip above the ring; flip below when there is no headroom
    tip.style.top = `${r.top > 60 ? r.top - 30 : r.bottom + 8}px`;
    tip.style.left = `${Math.max(8, r.left)}px`;
  }

  function renderStep(): void {
    if (closed) return;
    if (active >= steps.length) active = steps.length - 1;
    if (active < 0) active = 0;
    const step = steps[active];

    title.textContent = `MODELSWAP 捕获向导 · 步骤 ${active + 1}/${steps.length}`;
    stepText.textContent = step.text;

    targetEl = step.selector ? document.querySelector(step.selector) : null;
    const danger = DANGER.test(step.text) || (targetEl ? DANGER.test(targetEl.textContent ?? "") : false);

    if (targetEl) {
      targetEl.scrollIntoView({ block: "center" });
      spot.className = `msw-wiz-spot${danger ? " danger" : ""}`;
      spot.hidden = false;
      tip.className = `msw-wiz-tip${danger ? " danger" : ""}`;
      tip.textContent = danger ? "⚠ 危险操作，确认后再点击" : "高亮元素 · 复制后自动进入下一步";
      tip.hidden = false;
      positionSpotlight();
      note.textContent = "";
    } else {
      spot.hidden = true;
      tip.hidden = true;
      note.textContent = step.selector ? "（未定位到该元素——按文字说明操作即可，不影响入库）" : "";
    }
  }

  function renderDone(): void {
    title.textContent = "MODELSWAP 捕获向导";
    stepText.textContent = "✅ 全部捕获完成，向导即将自动关闭";
    note.textContent = "";
    spot.hidden = true;
    tip.hidden = true;
  }

  // ─── Storage-driven state machine ───────────────────────────────────
  function refresh(): void {
    if (closed) return;
    chrome.storage.local.get("vaultRequests", (data) => {
      if (closed) return;
      const reqs = (data?.vaultRequests ?? []) as WizardRequest[];
      const req = matchingRequest(reqs);
      if (!req) {
        // The batch we were guiding just completed (matchingRequest only
        // returns unfinished ones) — say goodbye instead of vanishing.
        const guided = currentReqId ? reqs.find((r) => r.id === currentReqId) : null;
        if (guided && guided.fulfilled) {
          renderDone();
          setTimeout(teardown, 3000);
        } else {
          teardown();
        }
        return;
      }

      const count = req.items.filter((i) => i.status === "fulfilled").length;
      if (currentReqId !== req.id) {
        currentReqId = req.id;
        lastFulfilled = count;
        steps = (req.items.find((i) => i.steps?.some((s) => s.includes("@@")))?.steps ?? [])
          .filter((s) => s.includes("@@"))
          .map(splitStep);
        active = Math.min(count, steps.length - 1);
      } else if (count > lastFulfilled) {
        // A pattern-matched copy landed — the capture IS the step completion.
        active += count - lastFulfilled;
        lastFulfilled = count;
      }

      if (req.items.every((i) => i.status === "fulfilled")) {
        renderDone();
        setTimeout(teardown, 3000);
        return;
      }
      renderStep();
    });
  }

  // ─── Wiring ──────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.vaultRequests) refresh();
  });
  window.addEventListener("scroll", () => positionSpotlight(), { passive: true });
  window.addEventListener("resize", () => positionSpotlight(), { passive: true });

  const prevBtn = el("button", undefined, "上一步");
  const nextBtn = el("button", undefined, "下一步");
  const closeBtn = el("button", undefined, "关闭");
  prevBtn.addEventListener("click", () => { active = Math.max(0, active - 1); renderStep(); });
  nextBtn.addEventListener("click", () => { active = Math.min(steps.length - 1, active + 1); renderStep(); });
  closeBtn.addEventListener("click", () => teardown());
  actions.append(prevBtn, nextBtn, closeBtn);

  refresh();
})();
