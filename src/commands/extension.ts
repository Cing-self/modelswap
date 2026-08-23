import fs from "fs-extra";
import path from "path";
import kleur from "kleur";

export function bundledExtensionDir(): string {
  return path.resolve(__dirname, "../../extension");
}

export async function showExtensionPath(): Promise<void> {
  const source = bundledExtensionDir();
  if (!(await fs.pathExists(source))) {
    console.error(kleur.red(`✗ Bundled extension not found: ${source}`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${source}\n`);
}
