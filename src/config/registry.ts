import fs from "fs-extra";
import path from "path";
import os from "os";

export const OKIT_DIR = path.join(os.homedir(), ".okit");
export const LOGS_DIR = path.join(OKIT_DIR, "logs");
export const CACHE_DIR = path.join(OKIT_DIR, "cache");

export async function ensureOkitDir(): Promise<void> {
  await fs.ensureDir(OKIT_DIR);
  await fs.ensureDir(LOGS_DIR);
  await fs.ensureDir(CACHE_DIR);
}
