import fs from "fs-extra";
import path from "path";
import kleur from "kleur";

export function bundledSkillPath(): string {
  return path.resolve(__dirname, "../../skills/okit-cli/SKILL.md");
}

export async function showSkillPath(): Promise<void> {
  const source = bundledSkillPath();
  if (!(await fs.pathExists(source))) {
    console.error(kleur.red(`✗ Bundled OKIT Skill not found: ${source}`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${source}\n`);
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
