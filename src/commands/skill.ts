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


// Headless/weak-model determinism: Claude Code -p never injects the skills
// list into the system prompt, so description-based triggering cannot fire
// there. A marker-guarded block in ~/.claude/CLAUDE.md is always loaded and
// routes the topics to the on-disk SKILL.md files regardless of model.
const CLAUDE_MD_HOOK_START = "<!-- modelswap-skills:start -->";
const CLAUDE_MD_HOOK_END = "<!-- modelswap-skills:end -->";

async function ensureClaudeMdHook(claudeSkillsDir: string): Promise<void> {
  const claudeMd = path.join(path.dirname(claudeSkillsDir), "CLAUDE.md");
  const block = [
    CLAUDE_MD_HOOK_START,
    "## ModelSwap 技能路由",
    "涉及以下话题时,先用 Read 读取对应 SKILL.md 并严格遵循其命令与红线,再回答或动手(路径相对本文件所在目录):",
    "- 模型平台/可用模型/换模型/模型在哪些平台可用 → skills/modelswap/SKILL.md(入口,含子技能路由与命令清单)",
    "- 密钥(API key/token/凭证)的查看、创建、打印、导出、轮换 → skills/modelswap/SKILL.md → 按其指引读 skills/modelswap-vault-secrets/SKILL.md",
    "- 多机同步/推送/拉取/配对 → skills/modelswap-sync/SKILL.md",
    "明文红线:密钥明文只允许进入用户机器上的目标系统(经 vault run 注入或用户本人终端),严禁打印到对话、记录或命令行参数。",
    CLAUDE_MD_HOOK_END,
  ].join("\n");
  let existing = "";
  if (await fs.pathExists(claudeMd)) existing = await fs.readFile(claudeMd, "utf8");
  if (existing.includes(CLAUDE_MD_HOOK_START)) {
    // Refresh the block in place (rules may evolve between versions).
    const start = existing.indexOf(CLAUDE_MD_HOOK_START);
    const end = existing.indexOf(CLAUDE_MD_HOOK_END) + CLAUDE_MD_HOOK_END.length;
    const updated = existing.slice(0, start) + block + existing.slice(end);
    if (updated !== existing) await fs.writeFile(claudeMd, updated);
    return;
  }
  const separator = existing.trim().length === 0 ? "" : "\n\n";
  await fs.writeFile(claudeMd, existing + separator + block + "\n");
  console.log(kleur.green(`✓ 已在 ${claudeMd} 写入 ModelSwap 技能路由(对所有模型生效)`));
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
    const answer = await prompts({
      type: "select",
      name: "agent",
      message: "安装到哪个 Agent？",
      choices: agents.map((a) => ({ title: a.detected ? a.label : `${a.label}（未检测到）`, value: a.id })),
    });
    if (!answer.agent) return;
    chosenAgents = agents.filter((a) => a.id === answer.agent);
  }
  if (chosenSkills.length === 0) {
    const answer = await prompts({
      type: "multiselect",
      name: "skills",
      message: "安装哪些技能？（空格勾选，回车确认）",
      choices: SKILL_FAMILY.map((name) => ({ title: name, value: name, selected: true })),
    });
    if (!answer.skills || answer.skills.length === 0) return;
    chosenSkills = answer.skills;
  }

  for (const agent of chosenAgents) {
    if (agent.id === "claude") await ensureClaudeMdHook(agent.skillsDir);
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
