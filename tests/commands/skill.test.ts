import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { bundledSkillPath, installSkill } from '../../src/commands/skill';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => fs.remove(dir)));
});

describe('OKIT CLI Skill', () => {
  it('ships a valid Skill entrypoint', async () => {
    const source = bundledSkillPath();
    expect(await fs.pathExists(source)).toBe(true);
    const content = await fs.readFile(source, 'utf8');
    expect(content).toContain('name: okit-cli');
    expect(content).toContain('okit provider current --json');
    expect(content).toContain('okit vault set <KEY> --stdin');
  });

  it('installs into the Agent Skills discovery directory', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'okit-skill-'));
    created.push(project);

    await installSkill(project);

    const installed = path.join(project, '.agents', 'skills', 'okit-cli', 'SKILL.md');
    expect(await fs.readFile(installed, 'utf8')).toBe(await fs.readFile(bundledSkillPath(), 'utf8'));
  });
});
