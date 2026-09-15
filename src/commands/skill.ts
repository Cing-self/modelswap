import fs from "fs-extra";
import os from "os";
import path from "path";
import kleur from "kleur";
import prompts from "prompts";

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

// ─── skill add — install the family into a chosen agent's skill dir ──

export interface SkillAgent {
  id: string;
  label: string;
  /** Absolute base dir whose <name>/SKILL.md subdirs that agent loads. */
  skillsDir: string;
  detected: boolean;
}

/** Known agents + the shared ~/.agents/skills convention, detection by dir. */
export async function listSkillAgents(): Promise<SkillAgent[]> {
  const home = os.homedir();
  const candidates: Array<Omit<SkillAgent, "detected">> = [
    { id: "claude", label: "Claude Code (~/.claude/skills)", skillsDir: path.join(home, ".claude", "skills") },
    { id: "agents", label: "共享 agents 目录 (~/.agents/skills，ZCode 等通用)", skillsDir: path.join(home, ".agents", "skills") },
    { id: "codex", label: "Codex (~/.codex/skills)", skillsDir: path.join(home, ".codex", "skills") },
    { id: "opencode", label: "OpenCode (~/.config/opencode/skills)", skillsDir: path.join(home, ".config", "opencode", "skills") },
    { id: "project", label: "当前项目 (./.agents/skills)", skillsDir: path.join(process.cwd(), ".agents", "skills") },
  ];
  return Promise.all(candidates.map(async (c) => ({
    ...c,
    detected: c.id === "project" ? true : await fs.pathExists(path.join(c.skillsDir, "..")),
  })));
}

export interface SkillAddOptions {
  agents?: string[];
  skills?: string[];
  all?: boolean;
  force?: boolean;
}

export async function skillAdd(options: SkillAddOptions): Promise<void> {
  const agents = await listSkillAgents();
  const validSkills = new Set(SKILL_FAMILY);
  for (const requested of options.skills ?? []) {
    if (!validSkills.has(requested as any)) {
      console.error(kleur.red(`✗ 未知技能: ${requested}（可选: ${SKILL_FAMILY.join(", ")}）`));
      process.exitCode = 1;
      return;
    }
  }
  for (const requested of options.agents ?? []) {
    if (!agents.some((a) => a.id === requested)) {
      console.error(kleur.red(`✗ 未知 agent: ${requested}（可选: ${agents.map((a) => a.id).join(", ")}）`));
      process.exitCode = 1;
      return;
    }
  }

  let chosenAgents = agents.filter((a) => options.agents?.includes(a.id));
  let chosenSkills = options.all
    ? [...SKILL_FAMILY]
    : SKILL_FAMILY.filter((name) => options.skills?.includes(name));

  const interactive = chosenAgents.length === 0 || chosenSkills.length === 0;
  if (interactive && !process.stdin.isTTY) {
    console.error(kleur.red("✗ 非交互环境需要 --agent 与 --skill（或 --all）。例如: modelswap skill add --agent claude --skill modelswap-sync"));
    process.exitCode = 1;
    return;
  }

  if (chosenAgents.length === 0) {
    const picked = await (prompts as any).select({
      message: "安装到哪个 Agent？",
      choices: agents.map((a) => ({ title: a.detected ? a.label : `${a.label}（未检测到）`, value: a.id })),
    });
    if (!picked) return;
    chosenAgents = agents.filter((a) => a.id === picked);
  }
  if (chosenSkills.length === 0) {
    const picked = await (prompts as any).multiselect({
      message: "安装哪些技能？",
      choices: SKILL_FAMILY.map((name) => ({ title: name, value: name, selected: true })),
    });
    if (!picked || picked.length === 0) return;
    chosenSkills = picked;
  }

  let installed = 0;
  let skipped = 0;
  for (const agent of chosenAgents) {
    for (const name of chosenSkills) {
      const destination = path.join(agent.skillsDir, name, "SKILL.md");
      if (fs.pathExistsSync(destination) && !options.force) {
        console.log(kleur.yellow(`↷ 跳过 ${name} → ${destination}（已存在，--force 覆盖）`));
        skipped++;
        continue;
      }
      await fs.ensureDir(path.dirname(destination));
      await fs.copyFile(path.join(bundledSkillDir(), name, "SKILL.md"), destination);
      console.log(kleur.green(`✓ ${name} → ${destination}`));
      installed++;
    }
  }
  console.log(kleur.gray(`完成：安装 ${installed}，跳过 ${skipped}。技能对 agent 立即可用（新会话生效）。`));
}
