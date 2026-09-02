import fs from "fs-extra";
import path from "path";
import os from "os";

export const MODELSWAP_DIR = path.join(os.homedir(), ".modelswap");
const LEGACY_MODELSWAP_DIR = path.join(os.homedir(), ".modelswap");
export const LOGS_DIR = path.join(MODELSWAP_DIR, "logs");
export const CACHE_DIR = path.join(MODELSWAP_DIR, "cache");

/**
 * One-time migration: v1.0.x installed as MODELSWAP used ~/.modelswap. Copy it to
 * ~/.modelswap on first run so existing vaults, snapshots, and settings
 * survive the rename. The vault payload is machine-bound encrypted, so a
 * straight copy preserves decryptability. The legacy dir is kept as a
 * backup until the user deletes it manually.
 */
export async function migrateLegacyModelSwapDir(): Promise<void> {
  const legacyExists = await fs.pathExists(LEGACY_MODELSWAP_DIR);
  const newExists = await fs.pathExists(MODELSWAP_DIR);
  if (!legacyExists || newExists) return;
  await fs.copy(LEGACY_MODELSWAP_DIR, MODELSWAP_DIR, { preserveTimestamps: true });
}

export async function ensureModelSwapDir(): Promise<void> {
  await migrateLegacyModelSwapDir();
  await fs.ensureDir(MODELSWAP_DIR);
  await fs.ensureDir(LOGS_DIR);
  await fs.ensureDir(CACHE_DIR);
}
