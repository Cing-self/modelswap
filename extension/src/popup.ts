/**
 * MODELSWAP popup — pending credential-request checklist + manual paste.
 *
 * Self-contained (no imports): rendered from data the service worker caches
 * in chrome.storage.local under `vaultRequests`. Manual pastes go through
 * the background worker so the value rides the authenticated WS channel,
 * never a page context fetch.
 */

interface RequestField {
  name: string;
  pattern?: string;
}

interface RequestItem {
  key: string;
  group?: string;
  desc?: string;
  url?: string;
  steps?: string[];
  pattern?: string;
  fields?: RequestField[];
  replace?: boolean;
  status: "pending" | "fulfilled";
  masked?: unknown;
  duplicate?: boolean;
}

interface VaultRequest {
  id: string;
  createdAt: number;
  expiresAt: number;
  fulfilled: boolean;
  items: RequestItem[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function maskedText(masked: unknown): string {
  if (typeof masked === "string") return masked;
  if (masked && typeof masked === "object") {
    return Object.entries(masked as Record<string, string>)
      .map(([name, v]) => `${name}: ${v}`)
      .join(" · ");
  }
  return "";
}

function renderItem(item: RequestItem): HTMLElement {
  const card = el("div", "item");

  const head = el("div", "item-head");
  head.append(el("span", "key-name", item.key));
  if (item.group) head.append(el("span", "chip", item.group));
  const status = el(
    "span",
    item.status === "fulfilled" ? "status done" : "status wait",
    item.status === "fulfilled" ? "✅ 已存入" : "⏳ 等待复制",
  );
  head.append(status);
  card.append(head);

  if (item.desc) card.append(el("div", "desc", item.desc));

  if (item.status === "fulfilled") {
    const m = maskedText(item.masked);
    if (m) card.append(el("div", "masked", `${m}${item.duplicate ? "（与现有值相同）" : ""}`));
    return card;
  }

  if (item.steps?.length) {
    const ol = el("ol", "steps");
    for (const step of item.steps) ol.append(el("li", undefined, step));
    card.append(ol);
  }

  if (item.fields?.length) {
    const fields = el("div", "fields");
    for (const f of item.fields) {
      const row = el("div", "f wait");
      row.textContent = `${f.name} ⏳`;
      row.dataset.field = f.name;
      fields.append(row);
    }
    card.append(fields);
  }

  const btnrow = el("div", "btnrow");
  if (item.url) {
    const open = el("button", undefined, "打开控制台");
    open.addEventListener("click", () => {
      void chrome.tabs.create({ url: item.url });
    });
    btnrow.append(open);
  }
  card.append(btnrow);

  // Manual paste — always-available fallback when auto-capture misses.
  const manual = el("div", "manual");
  const input = el("input");
  input.placeholder = item.fields?.length
    ? item.fields.map((f) => f.name).join(" 各一行，格式 字段名: 值")
    : "粘贴秘钥值，回车保存";
  const save = el("button", "primary", "保存");
  const errorNote = el("div", "note");
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    save.disabled = true;
    save.textContent = "保存中…";
    errorNote.textContent = "";
    try {
      const resp = await chrome.runtime.sendMessage({ type: "modelswap-manual-capture", key: item.key, text });
      if (!resp || resp.ok !== true) {
        save.disabled = false;
        save.textContent = "保存";
        input.value = text;
        errorNote.textContent = `✗ ${resp?.error ?? "保存失败"}`;
      }
    } catch (e) {
      save.disabled = false;
      save.textContent = "保存";
      input.value = text;
      errorNote.textContent = `✗ ${(e as Error).message}`;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  save.addEventListener("click", () => void submit());
  manual.append(input, save);
  card.append(manual);
  card.append(errorNote);
  card.append(el("div", "note", "提示：值直接进 vault，不经过任何对话。"));

  return card;
}

function render(requests: VaultRequest[], connected: boolean): void {
  const conn = document.getElementById("conn");
  if (conn) {
    conn.className = `conn ${connected ? "on" : "off"}`;
    conn.textContent = connected ? "已连接" : "未连接";
  }

  const now = Date.now();
  const live = requests.filter((r) => r.expiresAt > now);
  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  if (!list || !empty) return;
  list.textContent = "";

  const pendingItems = live.reduce(
    (count, r) => count + r.items.filter((i) => i.status !== "fulfilled").length,
    0,
  );
  empty.hidden = live.length > 0 && pendingItems > 0;
  if (live.length === 0) empty.hidden = false;

  for (const req of live) {
    const card = el("div", "card");
    for (const item of req.items) card.append(renderItem(item));
    list.append(card);
  }
}

async function init(): Promise<void> {
  const state = await chrome.runtime.sendMessage({ type: "modelswap-popup-init" });
  render(state?.requests ?? [], state?.connected === true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vaultRequests) {
    render((changes.vaultRequests.newValue as VaultRequest[]) ?? [], true);
  }
});

void init();
