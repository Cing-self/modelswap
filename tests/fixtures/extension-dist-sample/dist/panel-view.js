/**
 * MODELSWAP shared panel view — renders the pending credential-request list
 * and the manual-save form into a host document. Used by both the toolbar
 * popup (popup.html) and the Chrome side panel (sidepanel.html).
 *
 * Lives on data the service worker caches in chrome.storage.local
 * (`vaultRequests`, `wsConnected`), so every open surface updates live as
 * captures happen while the user browses. Values ride the authenticated WS
 * channel via the background worker, never a page context fetch.
 */
let lastConnected = false;
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function svgIcon(path) {
    const wrap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wrap.setAttribute("viewBox", "0 0 24 24");
    wrap.setAttribute("fill", "none");
    wrap.setAttribute("stroke", "currentColor");
    wrap.setAttribute("stroke-width", "1.5");
    wrap.setAttribute("stroke-linecap", "round");
    wrap.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    wrap.append(p);
    return wrap;
}
const ICON_EXTERNAL = "M14 4h6v6m0-6L10 14M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3";
function maskedText(masked) {
    if (typeof masked === "string")
        return masked;
    if (masked && typeof masked === "object") {
        return Object.entries(masked)
            .map(([name, v]) => `${name}: ${v}`)
            .join("  ");
    }
    return "";
}
function relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000)
        return "刚刚";
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
}
/**
 * One vault request = one agent batch. Batches render as separate cards so
 * keys captured for different asks never blur together; the header shows
 * relative time and capture progress.
 */
function renderBatch(req) {
    const card = el("div", `batch${req.items.every((i) => i.status === "fulfilled") ? " done" : ""}`);
    const head = el("div", "batch-head");
    head.append(el("span", "batch-tag", "Agent 请求"));
    head.append(el("span", "batch-time", relTime(req.createdAt)));
    const doneCount = req.items.filter((i) => i.status === "fulfilled").length;
    head.append(el("span", "batch-count", `${doneCount}/${req.items.length}`));
    card.append(head);
    for (const item of req.items)
        card.append(renderItem(item));
    return card;
}
function statusLine(status, duplicate) {
    const wrap = el("span", `status ${status === "fulfilled" ? "done" : "pending"}`);
    wrap.append(el("span", "dot"));
    wrap.append(el("span", undefined, status === "fulfilled" ? (duplicate ? "已存入（同值）" : "已存入") : "等待复制"));
    return wrap;
}
function renderItem(item) {
    const itemEl = el("div", "item");
    const head = el("div", "item-head");
    head.append(el("span", "key", item.key));
    head.append(statusLine(item.status, item.duplicate));
    itemEl.append(head);
    const metaParts = [item.group, item.desc].filter(Boolean).join(" · ");
    if (metaParts)
        itemEl.append(el("div", "meta", metaParts));
    if (item.status === "fulfilled") {
        const m = maskedText(item.masked);
        if (m)
            itemEl.append(el("div", "masked-line", m));
        return itemEl;
    }
    if (item.fields?.length) {
        const done = new Set(item.masked && typeof item.masked === "object" && !Array.isArray(item.masked)
            ? Object.keys(item.masked)
            : []);
        const fields = el("div", "fields");
        for (const f of item.fields) {
            const row = el("div", "f");
            row.append(el("span", undefined, f.name));
            if (done.has(f.name))
                row.append(el("span", "val", "已捕获"));
            else
                row.append(el("span", undefined, "待复制"));
            fields.append(row);
        }
        itemEl.append(fields);
    }
    if (item.steps?.length) {
        const ol = el("ol", "steps");
        for (const step of item.steps)
            ol.append(el("li", undefined, step));
        itemEl.append(ol);
    }
    const actions = el("div", "actions");
    if (item.url) {
        const open = el("button", "icon");
        open.type = "button";
        open.append(el("span", undefined, "打开控制台"));
        open.append(svgIcon(ICON_EXTERNAL));
        open.addEventListener("click", () => {
            void chrome.tabs.create({ url: item.url });
        });
        actions.append(open);
    }
    itemEl.append(actions);
    // Inline capture — always-available fallback when auto-capture misses.
    const captureRow = el("div", "capture-row");
    const input = el("input");
    input.placeholder = item.fields?.length ? "字段名: 值（每行一个）" : "粘贴秘钥值";
    const save = el("button", undefined, "存入");
    save.type = "button";
    const submit = async () => {
        const text = input.value.trim();
        if (!text)
            return;
        save.disabled = true;
        try {
            const resp = await chrome.runtime.sendMessage({ type: "modelswap-manual-capture", key: item.key, text });
            if (!resp || resp.ok !== true) {
                input.value = text;
                input.placeholder = resp?.error ?? "保存失败";
            }
        }
        catch (e) {
            input.value = text;
            input.placeholder = e.message;
        }
        save.disabled = false;
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void submit();
        }
    });
    save.addEventListener("click", () => void submit());
    captureRow.append(input, save);
    itemEl.append(captureRow);
    return itemEl;
}
// ─── Manual save — user-initiated, always available ───────────────────
function renderSaveForm() {
    const form = document.getElementById("save-form");
    if (!form)
        return;
    form.textContent = "";
    const valueField = el("div", "field");
    valueField.append(el("label", undefined, "秘钥值 · 多行「字段名: 值」自动存为 JSON"));
    const value = el("textarea");
    value.placeholder = "粘贴或输入秘钥值";
    valueField.append(value);
    form.append(valueField);
    const grid = el("div", "grid-2");
    const keyField = el("div", "field");
    keyField.append(el("label", undefined, "Key 名"));
    const keyInput = el("input", "mono");
    keyInput.placeholder = "必填";
    keyField.append(keyInput);
    const groupField = el("div", "field");
    groupField.append(el("label", undefined, "分组"));
    const groupWrap = el("div", "group-wrap");
    const groupInput = el("input");
    groupInput.placeholder = "可选，输入或选择已有分组";
    groupInput.autocomplete = "off";
    const groupChev = el("span", "group-chev");
    groupChev.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    const groupMenu = el("div", "group-menu");
    groupMenu.hidden = true;
    groupWrap.append(groupInput, groupChev, groupMenu);
    groupField.append(groupWrap);
    let menuActive = -1;
    const closeGroupMenu = () => {
        groupMenu.hidden = true;
        groupWrap.classList.remove("open");
        menuActive = -1;
    };
    const selectGroup = (name) => {
        groupInput.value = name;
        closeGroupMenu();
    };
    const renderGroupMenu = () => {
        const query = groupInput.value.trim().toLowerCase();
        const matches = groupOptions.filter((g) => g.toLowerCase().includes(query));
        if (matches.length === 0) {
            closeGroupMenu();
            return;
        }
        groupMenu.textContent = "";
        menuActive = -1;
        matches.forEach((name) => {
            const opt = el("button", "group-opt", name);
            opt.type = "button";
            opt.addEventListener("mousedown", (e) => {
                e.preventDefault(); // keep focus in the input
                selectGroup(name);
            });
            groupMenu.append(opt);
        });
        groupMenu.hidden = false;
        groupWrap.classList.add("open");
    };
    // Clicking the chevron toggles the menu; preventDefault keeps focus in
    // the input so the outside-pointerdown closer doesn't fight the toggle.
    groupChev.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (groupMenu.hidden)
            renderGroupMenu();
        else
            closeGroupMenu();
    });
    groupInput.addEventListener("focus", () => {
        void loadGroups().then(renderGroupMenu);
    });
    groupInput.addEventListener("input", renderGroupMenu);
    groupInput.addEventListener("keydown", (e) => {
        if (groupMenu.hidden)
            return;
        const opts = [...groupMenu.querySelectorAll(".group-opt")];
        if (e.key === "Escape") {
            closeGroupMenu();
        }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const delta = e.key === "ArrowDown" ? 1 : -1;
            menuActive = (menuActive + delta + opts.length) % opts.length;
            opts.forEach((o, i) => o.classList.toggle("active", i === menuActive));
            opts[menuActive]?.scrollIntoView({ block: "nearest" });
        }
        else if (e.key === "Enter" && menuActive >= 0 && opts[menuActive]) {
            e.preventDefault();
            selectGroup(opts[menuActive].textContent ?? "");
        }
    });
    groupField.append(groupWrap);
    // Close the menu when clicking anywhere outside it.
    document.addEventListener("pointerdown", (e) => {
        if (!groupMenu.hidden && !groupWrap.contains(e.target))
            closeGroupMenu();
    });
    grid.append(keyField, groupField);
    form.append(grid);
    const descField = el("div", "field");
    descField.append(el("label", undefined, "描述"));
    const descInput = el("input");
    descInput.placeholder = "用途说明（可选）";
    descField.append(descInput);
    form.append(descField);
    const actions = el("div", "form-actions");
    const save = el("button", "primary", "保存到 vault");
    save.type = "button";
    actions.append(save);
    form.append(actions);
    const note = el("div", "form-note");
    form.append(note);
    const overwriteBtn = el("button", undefined, "覆盖已有值并保存");
    overwriteBtn.type = "button";
    overwriteBtn.hidden = true;
    overwriteBtn.style.marginTop = "8px";
    form.append(overwriteBtn);
    const setNote = (kind, text) => {
        note.className = `form-note ${kind === "plain" ? "" : kind}`.trim();
        note.textContent = text;
    };
    const doSave = async (force) => {
        const key = keyInput.value.trim();
        const text = value.value.trim();
        if (!key)
            return setNote("err", "请填写 Key 名");
        if (!text)
            return setNote("err", "请填写秘钥值");
        save.disabled = true;
        overwriteBtn.hidden = true;
        setNote("plain", "保存中…");
        try {
            const resp = await chrome.runtime.sendMessage({
                type: "modelswap-manual-save",
                key,
                group: groupInput.value.trim() || undefined,
                desc: descInput.value.trim() || undefined,
                value: text,
                force,
            });
            if (resp && resp.ok === true) {
                setNote("ok", `已保存 ${maskedText(resp.masked)}`);
                value.value = "";
            }
            else if (resp && resp.code === "key-exists") {
                setNote("err", resp.error ?? "同名 Key 已存在");
                overwriteBtn.hidden = false;
            }
            else {
                setNote("err", resp?.error ?? "保存失败");
            }
        }
        catch (e) {
            setNote("err", e.message);
        }
        save.disabled = false;
    };
    save.addEventListener("click", () => void doSave(false));
    overwriteBtn.addEventListener("click", () => void doSave(true));
    // Prefill from the clipboard — focused extension pages can read it under
    // the clipboardRead permission. The side panel is not always focused, so
    // failures are silently ignored there.
    void navigator.clipboard
        .readText()
        .then((text) => {
        const trimmed = text.trim();
        if (trimmed && trimmed.length <= 4096 && !value.value)
            value.value = trimmed;
    })
        .catch(() => undefined);
}
let lastRequests = [];
// Vault group labels for the create-form autocomplete (custom dropdown —
// native datalist renders detached from inputs inside extension popups).
let groupOptions = [];
async function loadGroups() {
    try {
        const resp = await chrome.runtime.sendMessage({ type: "modelswap-get-groups" });
        groupOptions = resp?.groups ?? [];
    }
    catch {
        groupOptions = [];
    }
}
function render(requests, connected) {
    lastConnected = connected;
    lastRequests = requests;
    const conn = document.getElementById("conn");
    const connText = document.getElementById("conn-text");
    if (conn && connText) {
        conn.className = `conn ${connected ? "on" : "off"}`;
        connText.textContent = connected ? "已连接" : "未连接";
    }
    const banner = document.getElementById("banner");
    if (banner) {
        banner.hidden = connected;
        banner.textContent = "未连接到 ModelSwap 服务 — 捕获与保存暂不可用";
    }
    const now = Date.now();
    const live = requests.filter((r) => r.expiresAt > now);
    // Default surface is the create form; agent batches appear above it only
    // while they are alive, newest first.
    const section = document.getElementById("batches-section");
    const list = document.getElementById("list");
    const count = document.getElementById("batch-count");
    if (!section || !list || !count)
        return;
    list.textContent = "";
    const ordered = [...live].sort((a, b) => b.createdAt - a.createdAt);
    section.hidden = ordered.length === 0;
    if (ordered.length > 0) {
        count.textContent = `${ordered.length} 批`;
        for (const req of ordered)
            list.append(renderBatch(req));
    }
}
/** Wire the shared view into the host document (popup or side panel). */
export function mountPanel() {
    // The create form is built once — re-rendering it on every storage tick
    // would wipe whatever the user is typing and slam the dropdown shut.
    renderSaveForm();
    void init();
    void loadGroups();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local")
            return;
        if (changes.vaultRequests) {
            render(changes.vaultRequests.newValue ?? [], lastConnected);
        }
        if (changes.wsConnected) {
            render(lastRequests, changes.wsConnected.newValue === true);
        }
    });
    // Keep the batch relative-times ticking without waiting for a data push.
    setInterval(() => render(lastRequests, lastConnected), 30000);
}
async function init() {
    const state = await chrome.runtime.sendMessage({ type: "modelswap-popup-init" });
    render(state?.requests ?? [], state?.connected === true);
}
