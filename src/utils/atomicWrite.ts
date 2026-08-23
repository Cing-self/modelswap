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
 */
export async function atomicWrite(
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> {
  const tmpPath = filePath + ".okit-tmp";
  await fs.writeFile(tmpPath, data, options);
  await renameWithRetry(tmpPath, filePath);
}

async function renameWithRetry(src: string, dest: string, attempt = 1): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err: any) {
    if (err && err.code && ["EPERM", "EEXIST", "EBUSY"].includes(err.code) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
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
