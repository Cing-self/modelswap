import fs from "fs-extra";
import os from "os";
import path from "path";
import kleur from "kleur";

export function bundledExtensionDir(): string {
  return path.resolve(__dirname, "../../extension");
}

/**
 * Inside the standalone pkg binary the extension files live in the virtual
 * /snapshot/... filesystem — Chrome cannot load an unpacked extension from
 * there. When running as a binary we materialize the whole extension
 * directory to ~/.okit/extension and hand out that real path instead.
 */
export async function materializedExtensionDir(): Promise<string> {
  const source = bundledExtensionDir();
  const inSnapshot =
    typeof (process as { pkg?: unknown }).pkg !== "undefined" && source.startsWith("/snapshot");
  if (!inSnapshot) return source;

  const dest = path.join(os.homedir(), ".okit", "extension");
  // Re-copy every call: keeps the materialized copy in sync with the binary's
  // bundled version after an upgrade. Cheap (a handful of small files).
  await fs.remove(dest);
  await fs.copy(source, dest);
  return dest;
}

export async function showExtensionPath(): Promise<void> {
  const source = bundledExtensionDir();
  if (!(await fs.pathExists(source))) {
    console.error(kleur.red(`✗ Bundled extension not found: ${source}`));
    process.exitCode = 1;
    return;
  }
  const dir = await materializedExtensionDir();
  process.stdout.write(`${dir}\n`);
}
