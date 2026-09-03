import kleur from "kleur";
import prompts from "prompts";
import { VaultStore } from "../vault/store";
import { t } from "../config/i18n";

const store = new VaultStore();

// modelswap vault set KEY value
export async function vaultSet(key: string, value: string): Promise<void> {
  await store.set(key, value);
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

// modelswap vault list
export async function vaultList(options?: { json?: boolean }): Promise<void> {
  const entries = await store.list();
  if (entries.length === 0) {
    if (options?.json) {
      process.stdout.write("[]\n");
      return;
    }
    console.log(kleur.yellow(t("vaultEmpty")));
    return;
  }

  if (options?.json) {
    const safeEntries = entries.map(entry => ({
      key: entry.key,
      masked: entry.masked,
      group: entry.group || null,
      description: entry.desc || null,
      expiresAt: entry.expiresAt || null,
    }));
    process.stdout.write(`${JSON.stringify(safeEntries, null, 2)}\n`);
    return;
  }

  console.log(kleur.cyan(`\n${t("vaultListTitle")}\n`));

  for (const e of entries) {
    const description = e.desc ? `  ${kleur.gray(e.desc)}` : '';
    console.log(`  ${kleur.bold(e.key)}  ${kleur.gray(e.masked)}${description}`);
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

// modelswap vault inject — output shell export statements for explicit keys
export async function vaultInject(options?: { keys?: string; shell?: string }): Promise<void> {
  const targetShell = options?.shell || (process.platform === "win32" ? "powershell" : "bash");
  const keys = (options?.keys || "").split(",").map((key) => key.trim()).filter(Boolean);

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
