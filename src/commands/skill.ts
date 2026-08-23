import fs from "fs-extra";
import os from "os";
import path from "path";
import kleur from "kleur";

export function bundledSkillPath(): string {
  return path.resolve(__dirname, "../../skills/okit-cli/SKILL.md");
}

/**
 * Inside the standalone pkg binary the bundled SKILL.md lives in the virtual
 * /snapshot/... filesystem, which is only readable from within the process —
 * an external Agent cannot open it. When running as a binary we materialize
 * the file to ~/.okit/skills and hand out that real path instead.
 */
export async function materializedSkillPath(): Promise<string> {
  const source = bundledSkillPath();
  const inSnapshot =
    typeof (process as { pkg?: unknown }).pkg !== "undefined" && source.startsWith("/snapshot");
  if (!inSnapshot) return source;

  const dest = path.join(os.homedir(), ".okit", "skills", "okit-cli", "SKILL.md");
  await fs.ensureDir(path.dirname(dest));
  await fs.copyFile(source, dest);
  return dest;
}

export async function showSkillPath(): Promise<void> {
  const source = bundledSkillPath();
  if (!(await fs.pathExists(source))) {
    console.error(kleur.red(`✗ Bundled OKIT Skill not found: ${source}`));
    process.exitCode = 1;
    return;
  }
  const printable = await materializedSkillPath();
  process.stdout.write(`${printable}\n`);
}

export async function installSkill(targetDir = process.cwd(), options?: { force?: boolean }): Promise<void> {
  const source = bundledSkillPath();
  if (!(await fs.pathExists(source))) {
    console.error(kleur.red(`✗ Bundled OKIT Skill not found: ${source}`));
    process.exitCode = 1;
    return;
  }

  const projectDir = path.resolve(targetDir);
  const destination = path.join(projectDir, ".agents", "skills", "okit-cli", "SKILL.md");
  if (await fs.pathExists(destination) && !options?.force) {
    console.error(kleur.red(`✗ Skill already exists: ${destination}`));
    console.error(kleur.gray("  Re-run with --force only if you intend to replace it."));
    process.exitCode = 1;
    return;
  }

  await fs.ensureDir(path.dirname(destination));
  await fs.copyFile(source, destination);
  console.log(kleur.green(`✓ Installed OKIT CLI Skill: ${destination}`));
}
