/**
 * MODELSWAP capture wizard — page-guided overlay (demo, handoff §4.3.2).
 *
 * Injected alongside copy-guard into request-domain tabs. No bars, no
 * dialogs: the element named by the active step's selector
 * ("display text@@css selector" in --step) gets a spotlight ring, and the
 * step advances on its own when a pattern-matched capture for this request
 * lands (the highlight is only a suggestion). Guidance steps (danger notes
 * etc.) dwell ~6s then move on. Esc dismisses.
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

  // ─── Style ───────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.id = "msw-wiz-style";
  style.textContent = `
.msw-wiz-spot { position: fixed; z-index: 2147483645; border: 2px solid #22c55e;
  border-radius: 10px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, .55);
  pointer-events: none; }
.msw-wiz-spot.danger { border-color: #ef4444; }
.msw-wiz-tip { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
  z-index: 2147483646; background: #101014; color: #ececee;
  border: 1px solid #3a3a41; border-radius: 999px;
  font: 600 12px/1 system-ui, -apple-system, sans-serif; padding: 6px 14px;
  white-space: nowrap; }
.msw-wiz-tip.ok { border-color: #22c55e; }
`;
  document.documentElement.appendChild(style);

  // ─── Overlay elements ────────────────────────────────────────────────
  const spot = document.createElement("div");
  spot.className = "msw-wiz-spot";
  spot.hidden = true;
  const tip = document.createElement("div");
  tip.className = "msw-wiz-tip";
  tip.hidden = true;
  document.documentElement.append(spot, tip);

  let steps: Array<{ text: string; selector?: string }> = [];
  let active = 0;
  let lastFulfilled = 0;
  let currentReqId: string | null = null;
  let lastStepKey = "";
  let closed = false;
  let targetEl: Element | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleAdvance(): void {
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      goTo(active + 1);
    }, 2500);
  }

  function teardown(): void {
    if (closed) return;
    closed = true;
    spot.remove(); tip.remove(); style.remove();
  }

  function showPill(text: string, cls = ""): void {
    tip.className = `msw-wiz-tip${cls ? " " + cls : ""}`;
    tip.textContent = text;
    tip.hidden = false;
  }

  /** Activate a step. Copy steps wait indefinitely for their capture — no
   *  dwell fallback: a premature auto-advance is what made the guide feel
   *  broken. Announcement steps (no selector) dwell and move on. */
  function goTo(idx: number): void {
    active = Math.max(0, Math.min(steps.length - 1, idx));
    const key = `${currentReqId}:${active}`;
    if (key === lastStepKey) return;
    lastStepKey = key;
    renderStep();
  }

  function renderStep(): void {
    if (closed) return;
    const step = steps[active];

    targetEl = step.selector ? document.querySelector(step.selector) : null;
    const danger = DANGER.test(step.text);

    if (targetEl) {
      targetEl.scrollIntoView({ block: "center" });
      spot.className = `msw-wiz-spot${danger ? " danger" : ""}`;
      spot.hidden = false;
      positionSpotlight();
      showPill(danger ? "⚠ 危险操作 · 请勿点击" : `${active + 1}/${steps.length}`);
    } else if (step.selector) {
      // selector miss (page revamp) — degrade to a plain hint
      spot.hidden = true;
      showPill(`${active + 1}/${steps.length} · ${step.text.slice(0, 60)}`);
    } else {
      // announcement step — no element to spotlight; dwell and move on
      spot.hidden = true;
      showPill(step.text.slice(0, 80));
      scheduleAdvance();
    }
  }

  function renderDone(): void {
    spot.hidden = true;
    targetEl = null;
    showPill("✅ 全部捕获完成", "ok");
    setTimeout(teardown, 3000);
  }

  function positionSpotlight(): void {
    if (!targetEl || closed) return;
    const r = targetEl.getBoundingClientRect();
    spot.style.top = `${r.top - 6}px`;
    spot.style.left = `${r.left - 6}px`;
    spot.style.width = `${r.width + 12}px`;
    spot.style.height = `${r.height + 12}px`;
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
        goTo(0);
        return;
      }
      if (count > lastFulfilled) {
        // A pattern-matched copy landed — the capture IS the step completion.
        const diff = count - lastFulfilled;
        lastFulfilled = count;
        const justStored = req.items.filter((i) => i.status === "fulfilled").slice(-diff).map((i) => i.key).join(", ");
        if (req.items.every((i) => i.status === "fulfilled")) {
          renderDone();
          setTimeout(teardown, 3000);
          return;
        }
        // Visible ack at the point of action, then advance.
        showPill(`✅ 已存入 ${justStored}`, "ok");
        setTimeout(() => goTo(active + diff), 1200);
        return;
      }
      // Pure churn (WS reconnect re-pushes): keep the current step as-is.
    });
  }

  // ─── Wiring ──────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.vaultRequests) refresh();
  });
  window.addEventListener("scroll", () => positionSpotlight(), { passive: true });
  window.addEventListener("resize", () => positionSpotlight(), { passive: true });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") teardown(); });

  refresh();
})();
