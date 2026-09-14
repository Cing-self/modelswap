import fs from "fs-extra";
import path from "path";
import kleur from "kleur";

// The ModelSwap skill family: one entrypoint plus focused sub-skills that
// agents load on demand. They are authored together, installed together,
// and updated together.
export const SKILL_FAMILY = [
  "modelswap", // 核心：范围、检查、验证纪律、子技能路由
  "modelswap-agent-routing", // Agent 模型路由
  "modelswap-vault-secrets", // 密钥安全（捕获/轮换/使用）
  "modelswap-sync", // 云同步
] as const;

export function bundledSkillDir(): string {
  return path.resolve(__dirname, "../../skills");
}

export function bundledSkillPath(): string {
  return path.join(bundledSkillDir(), "modelswap", "SKILL.md");
}

export async function showSkillPath(): Promise<void> {
  let missing = false;
  for (const name of SKILL_FAMILY) {
    const source = path.join(bundledSkillDir(), name, "SKILL.md");
    if (await fs.pathExists(source)) {
      process.stdout.write(`${source}\n`);
    } else {
      missing = true;
      console.error(kleur.red(`✗ Bundled MODELSWAP Skill not found: ${source}`));
    }
  }
  if (missing) process.exitCode = 1;
}

export async function installSkill(targetDir = process.cwd(), options?: { force?: boolean }): Promise<void> {
  const projectDir = path.resolve(targetDir);
  const destinations = SKILL_FAMILY.map((name) => ({
    name,
    source: path.join(bundledSkillDir(), name, "SKILL.md"),
    destination: path.join(projectDir, ".agents", "skills", name, "SKILL.md"),
  }));

  for (const { source } of destinations) {
    if (!(await fs.pathExists(source))) {
      console.error(kleur.red(`✗ Bundled MODELSWAP Skill not found: ${source}`));
      process.exitCode = 1;
      return;
    }
  }

  const conflicts: string[] = [];
  for (const { destination } of destinations) {
    if ((await fs.pathExists(destination)) && !options?.force) conflicts.push(destination);
  }
  if (conflicts.length > 0) {
    console.error(kleur.red("✗ Skill already exists, nothing was changed:"));
    conflicts.forEach((c) => console.error(kleur.gray(`  ${c}`)));
    console.error(kleur.gray("  Re-run with --force to replace the whole family."));
    process.exitCode = 1;
    return;
  }

  for (const { source, destination } of destinations) {
    await fs.ensureDir(path.dirname(destination));
    await fs.copyFile(source, destination);
    console.log(kleur.green(`✓ Installed MODELSWAP Skill: ${destination}`));
  }
}
