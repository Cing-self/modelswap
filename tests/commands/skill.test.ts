import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { bundledSkillDir, bundledSkillPath, installSkill, SKILL_FAMILY } from '../../src/commands/skill';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => fs.remove(dir)));
});

describe('MODELSWAP CLI Skill family', () => {
  it('ships every skill in the family with matching frontmatter', async () => {
    for (const name of SKILL_FAMILY) {
      const source = path.join(bundledSkillDir(), name, 'SKILL.md');
      expect(await fs.pathExists(source)).toBe(true);
      const content = await fs.readFile(source, 'utf8');
      expect(content).toContain(`name: ${name}`);
      expect(content).toContain('description:');
    }
  });

  it('keeps the core entrypoint and the security spec in sync with the CLI', async () => {
    const core = await fs.readFile(bundledSkillPath(), 'utf8');
    expect(core).toContain('modelswap provider current --json');
    expect(core).toContain('modelswap-vault-secrets');

    const secrets = await fs.readFile(
      path.join(bundledSkillDir(), 'modelswap-vault-secrets', 'SKILL.md'),
      'utf8',
    );
    expect(secrets).toContain('modelswap vault request');
    expect(secrets).toContain('modelswap vault set <KEY> --stdin');
    expect(secrets).toContain('modelswap vault run --key <KEY> --env <ENV_VAR>');
  });

  it('installs the whole family into the Agent Skills discovery directory', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswap-skill-'));
    created.push(project);

    await installSkill(project);

    for (const name of SKILL_FAMILY) {
      const bundled = path.join(bundledSkillDir(), name, 'SKILL.md');
      const installed = path.join(project, '.agents', 'skills', name, 'SKILL.md');
      expect(await fs.readFile(installed, 'utf8')).toBe(await fs.readFile(bundled, 'utf8'));
    }
  });

  it('refuses to overwrite an existing family without --force', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswap-skill-'));
    created.push(project);

    await installSkill(project);
    const coreInstalled = path.join(project, '.agents', 'skills', 'modelswap', 'SKILL.md');
    const before = await fs.readFile(coreInstalled, 'utf8');

    // conflict path: exit code 1, nothing overwritten
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await installSkill(project);
      expect(process.exitCode).toBe(1);
      expect(await fs.readFile(coreInstalled, 'utf8')).toBe(before);
    } finally {
      process.exitCode = savedExitCode === undefined ? undefined : 0;
    }

    // --force replaces the whole family
    await expect(installSkill(project, { force: true })).resolves.toBeUndefined();
  });
});
