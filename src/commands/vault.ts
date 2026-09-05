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
