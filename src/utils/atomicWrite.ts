import fs from "fs-extra";
import path from "path";

/**
 * Atomically write a file by writing to a temp file then renaming.
 *
 * Direct fs.writeFile can leave a truncated/corrupt file if the process
 * crashes mid-write. rename() is atomic on POSIX filesystems, so the
 * target file is either fully old or fully new — never half-written.
 *
 * On Windows, rename is not guaranteed atomic but is still far safer
 * than a bare write (the window of corruption is smaller).
 *
 * The temp name is UNIQUE per call: concurrent atomicWrites to the same
 * target (e.g. the language save racing the first-run hint save on a fresh
 * install) used to share one tmp path — the first rename consumed it and
 * the second failed with ENOENT. pid + counter keeps writers independent.
 */
let tmpCounter = 0;

export async function atomicWrite(
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.okit-tmp`;
  try {
    await fs.writeFile(tmpPath, data, options);
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    // Never leave the unique tmp file behind on failure.
    await fs.remove(tmpPath).catch(() => {});
    throw err;
  }
}

// Transient Windows failure codes: the dest (or the just-written tmp) can be
// briefly held by Defender real-time scanning or a concurrent reader. POSIX
// rename() atomically replaces and never returns these.
const TRANSIENT_RENAME_CODES = ["EPERM", "EEXIST", "EBUSY"];
const MAX_RENAME_ATTEMPTS = 8;

async function renameWithRetry(src: string, dest: string, attempt = 1): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err: any) {
    const transient = err && err.code && TRANSIENT_RENAME_CODES.includes(err.code);
    if (transient && attempt < MAX_RENAME_ATTEMPTS) {
      // Exponential backoff, capped: 20ms 40ms 80ms 160ms 250ms 250ms 250ms.
      // Under heavy contention (30 writers) 3 attempts were not enough on
      // windows-latest CI — Defender held handles past the old 150ms window.
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 * 2 ** (attempt - 1))));
      return renameWithRetry(src, dest, attempt + 1);
    }
    throw err;
  }
}

/**
 * Atomically write JSON with pretty-printing.
 */
export async function atomicWriteJSON(
  filePath: string,
  data: unknown,
  options?: { mode?: number },
): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2), options);
}
