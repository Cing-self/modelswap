import kleur from "kleur";
import fs from "fs-extra";
import path from "path";
import prompts from "prompts";
import { VaultStore } from "../vault/store";
import { t } from "../config/i18n";

const store = new VaultStore();

// Parse .okitenv file
// Format — each line: ENV_NAME: VAULT_KEY
//
// Examples:
//   OPENAI_API_KEY: OPENROUTER_KEY       # vault 的 OPENROUTER_KEY → 注入为 OPENAI_API_KEY
//   OPENAI_BASE_URL: OPENROUTER_BASE_URL # vault 的 OPENROUTER_BASE_URL → 注入为 OPENAI_BASE_URL
//   GITHUB_TOKEN: GITHUB_TOKEN           # vault 的 GITHUB_TOKEN → 注入为 GITHUB_TOKEN
//   DATABASE_URL                         # vault 的 DATABASE_URL → 注入为 DATABASE_URL
//
// envName = 项目 .env 里实际写入的变量名
// vaultKey = vault 里存储的 key
interface OkitEnvEntry {
  envName: string;     // .env 里的变量名（如 OPENAI_API_KEY）
  vaultKey: string;    // vault 里的 key（如 OPENROUTER_KEY）
}

async function parseOkitEnv(filePath: string): Promise<OkitEnvEntry[]> {
  if (!(await fs.pathExists(filePath))) return [];
  const content = await fs.readFile(filePath, "utf-8");
  const entries: OkitEnvEntry[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Try "ENV_NAME: VAULT_SOURCE" format
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const envName = line.slice(0, colonIdx).trim();
      const source = line.slice(colonIdx + 1).trim();
      if (source) {
        entries.push({ envName, vaultKey: source });
      } else {
        // No source specified, envName = vaultKey
        entries.push({ envName, vaultKey: envName });
      }
      continue;
    }

    // Simple format: just ENV_NAME (same as vault key)
    if (/^[A-Z_][A-Z0-9_]*$/.test(line)) {
      entries.push({ envName: line, vaultKey: line });
    }
  }

  return entries;
}

function findOkitEnv(dir?: string): string | null {
  const cwd = dir || process.cwd();
  const candidates = [".okitenv", ".okit-env"];
  for (const name of candidates) {
    const fp = path.join(cwd, name);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// okit vault set KEY value
export async function vaultSet(key: string, value: string): Promise<void> {
  await store.set(key, value);
  console.log(kleur.green(`${t("vaultSaved")} ${key}`));

}

// okit vault get KEY
export async function vaultGet(key: string): Promise<void> {
  const value = await store.get(key);
  if (value === null) {
    console.log(kleur.red(`${t("vaultNotFound")} ${key}`));
    process.exit(1);
  }
  // Output raw value (for piping)
  process.stdout.write(value);
}

// okit vault list
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

// okit vault delete KEY
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

// okit vault inject — output shell export statements
// Reads .okitenv from current directory to know which keys to inject
export async function vaultInject(options?: { keys?: string; dir?: string; shell?: string }): Promise<void> {
  const dir = options?.dir || process.cwd();
  const targetShell = options?.shell || (process.platform === "win32" ? "powershell" : "bash");
  let entries: OkitEnvEntry[];

  if (options?.keys) {
    entries = options.keys.split(",").map((key) => ({ envName: key.trim(), vaultKey: key.trim() }));
  } else {
    const envFile = findOkitEnv(dir);
    if (!envFile) {
      console.error(kleur.red(t("vaultNoOkitEnv")));
      process.exit(1);
    }
    entries = await parseOkitEnv(envFile);
  }

  if (entries.length === 0) {
    console.error(kleur.red(t("vaultNoKeys")));
    process.exit(1);
  }

  const loadedKeys: string[] = [];
  for (const entry of entries) {
    const value = await store.get(entry.vaultKey);
    if (value !== null) {
      const escaped = value.replace(/'/g, "'\\''");
      if (targetShell === "powershell") {
        process.stdout.write(`$env:${entry.envName} = '${escaped}'\n`);
      } else {
        process.stdout.write(`export ${entry.envName}='${escaped}'\n`);
      }
      loadedKeys.push(entry.envName);
    }
  }

  // Tracking vars for shell hook cleanup
  if (loadedKeys.length > 0 && !options?.keys) {
    if (targetShell === "powershell") {
      process.stdout.write(`$global:_OKIT_LOADED_KEYS = "${loadedKeys.join(" ")}"\n`);
      process.stdout.write(`$global:_OKIT_LOADED_DIR = "${dir}"\n`);
    } else {
      process.stdout.write(`_OKIT_LOADED_KEYS="${loadedKeys.join(" ")}"\n`);
      process.stdout.write(`_OKIT_LOADED_DIR="${dir}"\n`);
      process.stdout.write(`export _OKIT_LOADED_KEYS _OKIT_LOADED_DIR\n`);
    }
  }
}

// okit vault env [file] — write .env file from .okitenv
export async function vaultEnv(targetFile?: string, options?: { dir?: string }): Promise<void> {
  const dir = options?.dir || process.cwd();
  const envFile = findOkitEnv(dir);
  if (!envFile) {
    console.log(kleur.red(t("vaultNoOkitEnv")));
    process.exitCode = 1;
    return;
  }

  const entries = await parseOkitEnv(envFile);
  if (entries.length === 0) {
    console.log(kleur.yellow(t("vaultNoKeys")));
    process.exitCode = 1;
    return;
  }

  const dest = targetFile || ".env";
  const lines: string[] = [];
  let resolved = 0;
  let missing = 0;

  for (const entry of entries) {
    const value = await store.get(entry.vaultKey);
    if (value !== null) {
      lines.push(`${entry.envName}=${value}`);
      resolved++;
    } else {
      lines.push(`# ${entry.envName}= # ${t("vaultNotFound")} ${entry.vaultKey}`);
      missing++;
    }
  }

  const fullPath = path.isAbsolute(dest) ? dest : path.join(dir, dest);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, lines.join("\n") + "\n");

  console.log(kleur.green(`${t("vaultEnvWritten")} ${dest}`));
  console.log(kleur.gray(`  ${t("vaultResolved")}: ${resolved}, ${t("vaultMissing")}: ${missing}`));
}


