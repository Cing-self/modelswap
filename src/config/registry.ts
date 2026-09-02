import fs from "fs-extra";
import path from "path";
import os from "os";

export const MODELSWAP_DIR = path.join(os.homedir(), ".modelswap");
// ≤ v1.0.41 stored all data under ~/.okit; the ModelSwap rename moved the
// data dir. The one-time copy in migrateLegacyOkitDir carries vaults
// (machine-bound encrypted payloads decrypt fine after a straight copy),
// providers, and settings across the rename. The legacy dir is kept as a
// backup until the user deletes it manually.
const LEGACY_OKIT_DIR = path.join(os.homedir(), ".okit");
export const LOGS_DIR = path.join(MODELSWAP_DIR, "logs");
export const CACHE_DIR = path.join(MODELSWAP_DIR, "cache");

// v1.0.42 shipped a broken migration (it copied ~/.modelswap onto itself), so
// early upgraders got an auto-initialized empty dir: a fresh vault master.key
// and preset providers with no user data. Only such untouched dirs may be
// replaced by the legacy copy; anything holding real data is left alone.
function looksUntouched(dir: string): boolean {
  return (
    !fs.pathExistsSync(path.join(dir, "vault", "secrets.enc")) &&
    !fs.pathExistsSync(path.join(dir, "providers.json")) &&
    !fs.pathExistsSync(path.join(dir, "user.json"))
  );
}

export function migrateLegacyOkitDir(): void {
  if (!fs.pathExistsSync(LEGACY_OKIT_DIR)) return;
  if (fs.pathExistsSync(MODELSWAP_DIR) && !looksUntouched(MODELSWAP_DIR)) return;

  // Stage the copy next to the target and rename it into place so a mid-copy
  // crash can never leave a half-migrated ~/.modelswap that later runs would
  // treat as real data. The pid suffix keeps concurrent processes from
  // sharing a staging dir.
  const staging = `${MODELSWAP_DIR}.migrating-${process.pid}`;
  fs.removeSync(staging);
  fs.copySync(LEGACY_OKIT_DIR, staging, { preserveTimestamps: true });
  if (fs.pathExistsSync(MODELSWAP_DIR)) fs.removeSync(MODELSWAP_DIR);
  fs.renameSync(staging, MODELSWAP_DIR);
}

export async function ensureModelSwapDir(): Promise<void> {
  try {
    migrateLegacyOkitDir();
  } catch (error) {
    // The legacy dir stays intact, so the next run retries; a failed
    // migration must not take the whole process down.
    console.error(
      `modelswap: ~/.okit 数据迁移失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await fs.ensureDir(MODELSWAP_DIR);
  await fs.ensureDir(LOGS_DIR);
  await fs.ensureDir(CACHE_DIR);
}
