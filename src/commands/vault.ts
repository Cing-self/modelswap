import kleur from "kleur";
import prompts from "prompts";
import { VaultStore } from "../vault/store";
import { normalizeVaultGroup } from "../vault/group-meta";
import { t } from "../config/i18n";

const store = new VaultStore();

interface VaultSetMeta {
  group?: string;
  desc?: string;
}

// modelswap vault set KEY value [--group G] [--desc D]
export async function vaultSet(key: string, value: string, meta?: VaultSetMeta): Promise<void> {
  // Undefined group/desc keep existing metadata on re-set (store skips them);
  // an explicit --group goes through the same normalization as the Web API so
  // both surfaces land in one canonical group.
  await store.set(
    key,
    value,
    meta?.group !== undefined ? normalizeVaultGroup(meta.group, key) : undefined,
    undefined,
    meta?.desc,
  );
  console.log(kleur.green(`${t("vaultSaved")} ${key}`));

  // Propagate the new value into agent configs whose providers bind this
  // key (Codex reads the vault live; the others embed the value at write
  // time and need the re-apply). Failures are logged, never fatal here.
  try {
    const { agentConfigService } = await import("./provider");
    const { updated } = await agentConfigService().reconcileVaultKey({ vaultKey: key });
    if (updated > 0) console.log(kleur.gray(t("vaultSetPropagated", { count: updated })));
  } catch (error) {
    console.warn(kleur.yellow(`vault: ${(error as Error).message}`));
  }
}

// modelswap vault get KEY
export async function vaultGet(key: string): Promise<void> {
  const value = await store.get(key);
  if (value === null) {
    console.log(kleur.red(`${t("vaultNotFound")} ${key}`));
    process.exit(1);
  }
  // Output raw value (for piping)
  process.stdout.write(value);
}

// modelswap vault mv OLD NEW — rename keeping group/desc/expiry
export async function vaultMv(oldKey: string, newKey: string): Promise<void> {
  if (oldKey === newKey) {
    console.log(kleur.yellow(t("vaultMoveSameKey")));
    return;
  }
  const entries = await store.list();
  const source = entries.find((entry) => entry.key === oldKey);
  if (!source) {
    console.log(kleur.red(`${t("vaultNotFound")} ${oldKey}`));
    process.exit(1);
  }
  if (entries.some((entry) => entry.key === newKey)) {
    console.log(kleur.red(t("vaultMoveTargetExists", { key: newKey })));
    process.exitCode = 1;
    return;
  }
  // Mirrors the Web API's originalKey move (vault.js): set the new key with
  // the source metadata, then delete the old one. The value comes from get()
  // because list() only carries the masked form.
  const value = await store.get(oldKey);
  if (value === null) {
    console.log(kleur.red(`${t("vaultNotFound")} ${oldKey}`));
    process.exit(1);
  }
  await store.set(newKey, value, normalizeVaultGroup(source.group, newKey), source.expiresAt || undefined, source.desc || undefined);
  await store.delete(oldKey);
  console.log(kleur.green(t("vaultMoved", { old: oldKey, new: newKey })));
}

// modelswap vault list [--group G] [--json]
export async function vaultList(options?: { json?: boolean; group?: string }): Promise<void> {
  const entries = await store.list();
  const groupFilter = options?.group !== undefined ? normalizeVaultGroup(options.group, "") : undefined;
  const filtered = groupFilter !== undefined
    ? entries.filter((entry) => (normalizeVaultGroup(entry.group, entry.key) || "") === groupFilter)
    : entries;

  if (filtered.length === 0) {
    if (options?.json) {
      process.stdout.write("[]\n");
      return;
    }
    console.log(kleur.yellow(groupFilter !== undefined ? t("vaultSearchNoMatch") : t("vaultEmpty")));
    return;
  }

  if (options?.json) {
    const safeEntries = filtered.map(entry => ({
      key: entry.key,
      masked: entry.masked,
      group: normalizeVaultGroup(entry.group, entry.key) || null,
      description: entry.desc || null,
      expiresAt: entry.expiresAt || null,
      updatedAt: entry.updatedAt || null,
    }));
    process.stdout.write(`${JSON.stringify(safeEntries, null, 2)}\n`);
    return;
  }

  console.log(kleur.cyan(`\n${t("vaultListTitle")}\n`));

  for (const e of filtered) {
    const group = normalizeVaultGroup(e.group, e.key);
    const groupLabel = group ? `  ${kleur.blue(`[${group}]`)}` : '';
    const description = e.desc ? `  ${kleur.gray(e.desc)}` : '';
    console.log(`  ${kleur.bold(e.key)}  ${kleur.gray(e.masked)}${groupLabel}${description}`);
  }
  console.log();
}

// modelswap vault groups — list distinct groups with per-group counts
export async function vaultGroups(options?: { json?: boolean }): Promise<void> {
  const entries = await store.list();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const group = normalizeVaultGroup(entry.group, entry.key);
    if (!group) continue;
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));

  if (options?.json) {
    process.stdout.write(`${JSON.stringify(groups.map(([group, count]) => ({ group, count })), null, 2)}\n`);
    return;
  }
  if (groups.length === 0) {
    console.log(kleur.yellow(t("vaultEmpty")));
    return;
  }
  console.log(kleur.cyan(`\n${t("vaultGroupsTitle")}\n`));
  for (const [group, count] of groups) {
    console.log(`  ${kleur.bold(group)}  ${kleur.gray(t("vaultGroupCount", { count }))}`);
  }
  console.log();
}

// modelswap vault search QUERY — fuzzy match on key / desc / group
export async function vaultSearch(query: string, options?: { json?: boolean }): Promise<void> {
  const needle = query.trim().toLowerCase();
  const entries = await store.list();
  const matches = entries.filter((entry) => {
    const group = normalizeVaultGroup(entry.group, entry.key);
    return (
      entry.key.toLowerCase().includes(needle) ||
      (entry.desc || "").toLowerCase().includes(needle) ||
      (group || "").toLowerCase().includes(needle)
    );
  });

  if (options?.json) {
    const safeEntries = matches.map(entry => ({
      key: entry.key,
      masked: entry.masked,
      group: normalizeVaultGroup(entry.group, entry.key) || null,
      description: entry.desc || null,
      updatedAt: entry.updatedAt || null,
    }));
    process.stdout.write(`${JSON.stringify(safeEntries, null, 2)}\n`);
    return;
  }
  if (matches.length === 0) {
    console.log(kleur.yellow(t("vaultSearchNoMatch")));
    return;
  }
  console.log(kleur.cyan(`\n${t("vaultSearchTitle", { query })}\n`));
  for (const e of matches) {
    const group = normalizeVaultGroup(e.group, e.key);
    const groupLabel = group ? `  ${kleur.blue(`[${group}]`)}` : '';
    const description = e.desc ? `  ${kleur.gray(e.desc)}` : '';
    console.log(`  ${kleur.bold(e.key)}  ${kleur.gray(e.masked)}${groupLabel}${description}`);
  }
  console.log();
}

// modelswap vault delete KEY
export async function vaultDelete(key: string): Promise<void> {
  const confirm = await prompts({
    type: "confirm",
    name: "yes",
    message: `${t("vaultConfirmDelete")} ${key}?`,
    initial: false,
  });
  if (!confirm.yes) return;

  if (await store.delete(key)) {
    console.log(kleur.green(`${t("vaultDeleted")} ${key}`));
  } else {
    console.log(kleur.red(`${t("vaultNotFound")} ${key}`));
    process.exitCode = 1;
  }
}

// modelswap vault inject [--keys k1,k2] [--group G] — export statements
export async function vaultInject(options?: { keys?: string; shell?: string; group?: string }): Promise<void> {
  const targetShell = options?.shell || (process.platform === "win32" ? "powershell" : "bash");
  let keys = (options?.keys || "").split(",").map((key) => key.trim()).filter(Boolean);

  if (keys.length === 0 && options?.group) {
    // Inject a whole group: agents commonly need every key of one service.
    const groupFilter = normalizeVaultGroup(options.group, "");
    const entries = await store.list();
    keys = entries
      .filter((entry) => (normalizeVaultGroup(entry.group, entry.key) || "") === groupFilter)
      .map((entry) => entry.key);
  }

  if (keys.length === 0) {
    console.error(kleur.red(t("vaultNoKeys")));
    process.exit(1);
  }

  for (const key of keys) {
    const value = await store.get(key);
    if (value === null) continue;
    const escaped = value.replace(/'/g, "'\''");
    if (targetShell === "powershell") {
      process.stdout.write(`$env:${key} = '${escaped}'\n`);
    } else {
      process.stdout.write(`export ${key}='${escaped}'\n`);
    }
  }
}

// ─── vault request — agent-issued credential capture ─────────────────
//
// The CLI never touches the secret. It registers metadata (key name / group /
// desc / expected pattern / console URL) with the local server, which arms the
// browser extension; the value enters the vault only when the user copies it
// on the provider console and the extension captures it.

export interface VaultRequestItem {
  key: string;
  group?: string;
  desc?: string;
  url?: string;
  steps?: string[];
  pattern?: string;
  fields?: { name: string; pattern?: string }[];
  replace?: boolean;
}

const MODELSWAP_LOCAL_PORTS = [3780, 3781, 3782, 3783, 3784, 3785];

async function findLocalServerPort(): Promise<number | null> {
  // Explicit override (dev/testing against a non-default port).
  const override = parseInt(process.env.MODELSWAP_PORT ?? "", 10);
  if (Number.isInteger(override) && override > 0) {
    try {
      const res = await fetch(`http://localhost:${override}/ping`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return override;
    } catch {
      // fall through to the probe list
    }
  }
  for (const port of MODELSWAP_LOCAL_PORTS) {
    try {
      const res = await fetch(`http://localhost:${port}/ping`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return port;
    } catch {
      // No server on this port — try the next one.
    }
  }
  return null;
}

async function localVaultApi<T>(port: number, pathName: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}${pathName}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export async function vaultRequest(
  keys: string[],
  options: {
    group?: string;
    desc?: string;
    url?: string;
    step?: string[];
    pattern?: string;
    fields?: string;
    fieldPattern?: string[];
    replace?: boolean;
    wait?: boolean;
    timeout?: string;
  },
): Promise<void> {
  // KEY@分组 syntax; a bare --group covers keys without their own group.
  const items: VaultRequestItem[] = keys.map((raw) => {
    const at = raw.indexOf("@");
    return at === -1
      ? { key: raw, group: options.group }
      : { key: raw.slice(0, at), group: raw.slice(at + 1) };
  });
  if (items.some((item) => !item.key)) {
    console.error(kleur.red("✗ key 名不能为空（KEY@分组 中 @ 前必须有 key）"));
    process.exitCode = 1;
    return;
  }
  if ((options.pattern || options.fields) && items.length > 1) {
    console.error(kleur.red("✗ --pattern / --fields 只支持单 key 请求，多 key 请分次发起"));
    process.exitCode = 1;
    return;
  }

  if (options.pattern !== undefined) {
    try {
      new RegExp(options.pattern);
    } catch (error) {
      console.error(kleur.red(`✗ --pattern 编译失败: ${(error as Error).message}`));
      process.exitCode = 1;
      return;
    }
    items[0].pattern = options.pattern;
  }
  if (options.fields) {
    const names = options.fields.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      console.error(kleur.red("✗ --fields 格式: app_id,app_secret"));
      process.exitCode = 1;
      return;
    }
    const fieldPatterns = new Map<string, string>();
    for (const fp of options.fieldPattern ?? []) {
      const eq = fp.indexOf("=");
      if (eq === -1) {
        console.error(kleur.red(`✗ --field-pattern 格式: name=regex（收到 "${fp}"）`));
        process.exitCode = 1;
        return;
      }
      fieldPatterns.set(fp.slice(0, eq), fp.slice(eq + 1));
    }
    const parsedFields: Array<{ name: string; pattern?: string }> = [];
    for (const name of names) {
      const pattern = fieldPatterns.get(name);
      if (pattern !== undefined) {
        try {
          new RegExp(pattern);
        } catch (error) {
          console.error(kleur.red(`✗ 字段 ${name} 的 pattern 编译失败: ${(error as Error).message}`));
          process.exitCode = 1;
          return;
        }
        parsedFields.push({ name, pattern });
      } else {
        parsedFields.push({ name });
      }
    }
    items[0].fields = parsedFields;
  }
  for (const item of items) {
    if (options.desc !== undefined) item.desc = options.desc;
    if (options.url !== undefined) item.url = options.url;
    if (options.step?.length) item.steps = options.step;
    if (options.replace) item.replace = true;
  }

  const port = await findLocalServerPort();
  if (port === null) {
    console.error(kleur.red("✗ 未找到运行中的 MODELSWAP 服务（先启动桌面 App，或运行 modelswap web）"));
    process.exitCode = 1;
    return;
  }

  let created: { id: string; request: { items: Array<{ key: string; group?: string }> }; extensionConnected?: boolean };
  try {
    created = await localVaultApi(port, "/api/vault/requests", { items });
  } catch (error) {
    console.error(kleur.red(`✗ 创建凭证请求失败: ${(error as Error).message}`));
    process.exitCode = 1;
    return;
  }

  console.log(kleur.green("✓ 凭证请求已创建，已通知浏览器扩展待命捕获"));
  for (const item of created.request.items) {
    console.log(`  ⏳ ${kleur.cyan(item.key)}${item.group ? kleur.gray(`（${item.group}）`) : ""}`);
  }
  if (created.extensionConnected === false) {
    console.log(kleur.yellow("⚠ 浏览器扩展未连接 — 复制秘钥不会被自动捕获，本次等待大概率超时。"));
    console.log(kleur.gray("  安装: 打开 ModelSwap → 设置 → 浏览器扩展，按引导一键加载；"));
    console.log(kleur.gray("  或 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 extension 目录。"));
    console.log(kleur.gray("  临时替代: 按 agent 给的元数据执行 modelswap vault set 手动录入。"));
  } else {
    console.log(kleur.gray("  用户操作: 在控制台页面复制 key，扩展自动捕获入库；也可点扩展图标手动粘贴。"));
  }

  if (!options.wait) return;

  const timeoutSeconds = parseInt(options.timeout || "600", 10) || 600;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let list: { requests: Array<{ id: string; items: Array<{ key: string; status: string; masked?: unknown; duplicate?: boolean }> }> };
    try {
      list = await localVaultApi(port, "/api/vault/requests");
    } catch {
      continue; // transient — retry until timeout
    }
    const mine = list.requests.find((r) => r.id === created.id);
    if (!mine) {
      console.log(kleur.red("\n✗ 请求已取消或过期"));
      process.exit(1);
    }
    const pending = mine.items.filter((item) => item.status !== "fulfilled");
    if (pending.length === 0) {
      console.log("");
      for (const item of mine.items) {
        const masked = typeof item.masked === "string" ? item.masked : JSON.stringify(item.masked);
        console.log(kleur.green(`  ✅ ${item.key} → ${masked}${item.duplicate ? kleur.gray("（与现有值相同）") : ""}`));
      }
      // Explicit exit: pooled keep-alive sockets from the poll loop must not
      // keep a finished CLI process alive.
      process.exit(process.exitCode === undefined ? 0 : process.exitCode);
    }
    process.stdout.write(`\r⏳ 等待捕获: ${pending.map((item) => item.key).join(", ")} `);
  }
  console.log(kleur.red(`\n✗ 等待超时（${timeoutSeconds}s）。扩展里仍可手动完成，本次命令退出。`));
  process.exit(1);
}
