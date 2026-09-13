"use strict";
/**
 * MODELSWAP popup — pending credential-request checklist + manual paste.
 *
 * Self-contained (no imports): rendered from data the service worker caches
 * in chrome.storage.local under `vaultRequests`. Manual pastes go through
 * the background worker so the value rides the authenticated WS channel,
 * never a page context fetch.
 */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function maskedText(masked) {
    if (typeof masked === "string")
        return masked;
    if (masked && typeof masked === "object") {
        return Object.entries(masked)
            .map(([name, v]) => `${name}: ${v}`)
            .join(" · ");
    }
    return "";
}
// ─── Manual save — user-initiated, always available ───────────────────
function renderSaveForm() {
    const host = document.getElementById("save-form");
    if (!host)
        return;
    host.textContent = "";
    const form = el("div", "save-form");
    const valueLabel = el("label", undefined, "秘钥值（多行「字段名: 值」自动存为 JSON）");
    const value = el("textarea");
    value.placeholder = "粘贴或输入秘钥值…";
    form.append(valueLabel, value);
    const row1 = el("div", "row");
    const keyBox = el("div");
    const groupBox = el("div");
    keyBox.style.flex = "1.4";
    groupBox.style.flex = "1";
    const keyInput = el("input", "mono");
    keyInput.placeholder = "key 名（必填）";
    const groupInput = el("input");
    groupInput.placeholder = "分组";
    keyBox.append(el("label", undefined, "Key 名"), keyInput);
    groupBox.append(el("label", undefined, "分组"), groupInput);
    row1.append(keyBox, groupBox);
    form.append(row1);
    const descBox = el("div");
    descBox.style.marginTop = "6px";
    const descInput = el("input");
    descInput.placeholder = "用途说明（可选）";
    descBox.append(el("label", undefined, "描述"), descInput);
    form.append(descBox);
    const actions = el("div", "actions");
    const save = el("button", "primary", "保存到 vault");
    const overwrite = el("button", undefined, "覆盖已有值");
    overwrite.hidden = true;
    const note = el("span", "note");
    actions.append(save, overwrite, note);
    form.append(actions);
    let lastPayload = null;
    const doSave = async (force) => {
        const key = keyInput.value.trim();
        const text = value.value.trim();
        if (!key) {
            note.className = "note";
            note.textContent = "✗ 请填 key 名";
            return;
        }
        if (!text) {
            note.className = "note";
            note.textContent = "✗ 请填秘钥值";
            return;
        }
        lastPayload = { key, group: groupInput.value.trim() || undefined, desc: descInput.value.trim() || undefined, value: text };
        save.disabled = true;
        save.textContent = "保存中…";
        overwrite.hidden = true;
        note.textContent = "";
        try {
            const resp = await chrome.runtime.sendMessage({ type: "modelswap-manual-save", ...lastPayload, force });
            if (resp && resp.ok === true) {
                note.className = "note ok-note";
                const m = maskedText(resp.masked);
                note.textContent = `✅ 已保存 ${m}${resp.duplicate ? "（与现有值相同）" : ""}`;
                value.value = "";
            }
            else if (resp && resp.code === "key-exists") {
                note.className = "note";
                note.textContent = `✗ ${resp.error ?? "同名 key 已存在"}`;
                overwrite.hidden = false;
            }
            else {
                note.className = "note";
                note.textContent = `✗ ${resp?.error ?? "保存失败"}`;
            }
        }
        catch (e) {
            note.className = "note";
            note.textContent = `✗ ${e.message}`;
        }
        save.disabled = false;
        save.textContent = "保存到 vault";
    };
    save.addEventListener("click", () => void doSave(false));
    overwrite.addEventListener("click", () => void doSave(true));
    host.append(form);
    // Prefill from the clipboard — the popup document is focused, so
    // navigator.clipboard.readText() works under the clipboardRead permission.
    void navigator.clipboard
        .readText()
        .then((text) => {
        const trimmed = text.trim();
        if (trimmed && trimmed.length <= 4096 && !value.value)
            value.value = trimmed;
    })
        .catch(() => undefined);
}
function renderItem(item) {
    const card = el("div", "item");
    const head = el("div", "item-head");
    head.append(el("span", "key-name", item.key));
    if (item.group)
        head.append(el("span", "chip", item.group));
    const status = el("span", item.status === "fulfilled" ? "status done" : "status wait", item.status === "fulfilled" ? "✅ 已存入" : "⏳ 等待复制");
    head.append(status);
    card.append(head);
    if (item.desc)
        card.append(el("div", "desc", item.desc));
    if (item.status === "fulfilled") {
        const m = maskedText(item.masked);
        if (m)
            card.append(el("div", "masked", `${m}${item.duplicate ? "（与现有值相同）" : ""}`));
        return card;
    }
    if (item.steps?.length) {
        const ol = el("ol", "steps");
        for (const step of item.steps)
            ol.append(el("li", undefined, step));
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
        ? `每行一个字段，格式「字段名: 值」：${item.fields.map((f) => f.name).join("、")}`
        : "粘贴秘钥值，回车保存";
    const save = el("button", "primary", "保存");
    const errorNote = el("div", "note");
    const submit = async () => {
        const text = input.value.trim();
        if (!text)
            return;
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
        }
        catch (e) {
            save.disabled = false;
            save.textContent = "保存";
            input.value = text;
            errorNote.textContent = `✗ ${e.message}`;
        }
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter")
            void submit();
    });
    save.addEventListener("click", () => void submit());
    manual.append(input, save);
    card.append(manual);
    card.append(errorNote);
    card.append(el("div", "note", "提示：值直接进 vault，不经过任何对话。"));
    return card;
}
function render(requests, connected) {
    const conn = document.getElementById("conn");
    if (conn) {
        conn.className = `conn ${connected ? "on" : "off"}`;
        conn.textContent = connected ? "已连接" : "未连接";
    }
    const now = Date.now();
    const live = requests.filter((r) => r.expiresAt > now);
    const list = document.getElementById("list");
    const empty = document.getElementById("empty");
    if (!list || !empty)
        return;
    list.textContent = "";
    const pendingItems = live.reduce((count, r) => count + r.items.filter((i) => i.status !== "fulfilled").length, 0);
    empty.hidden = live.length > 0 && pendingItems > 0;
    if (live.length === 0)
        empty.hidden = false;
    for (const req of live) {
        const card = el("div", "card");
        for (const item of req.items)
            card.append(renderItem(item));
        list.append(card);
    }
    renderSaveForm();
}
async function init() {
    const state = await chrome.runtime.sendMessage({ type: "modelswap-popup-init" });
    render(state?.requests ?? [], state?.connected === true);
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.vaultRequests) {
        render(changes.vaultRequests.newValue ?? [], true);
    }
});
void init();
