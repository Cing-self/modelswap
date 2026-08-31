import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

// The publish workflow must gate on reviewed release notes BEFORE anything
// with an external side effect runs. A release whose notes are missing or
// invalid has to fail while the repository and registries are still
// untouched — a late validation leaves a pushed tag and a bumped main with
// no GitHub Release and no npm publish (the v1.0.36 near-miss).
describe('publish workflow release-notes gate', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  // Match the step definition, not the workflow name ("name: Publish to NPM
  // and GitHub Release") or prose comments mentioning a step.
  const stepIndex = (stepName: string) => {
    const index = workflow.indexOf(`- name: ${stepName}`);
    expect(index, `expected publish.yml to define step "${stepName}"`).toBeGreaterThan(-1);
    return index;
  };

  it('validates release notes before the bump commit, push, tag, npm publish, or release', () => {
    const validate = workflow.indexOf('- name: Validate reviewed release notes');
    expect(validate).toBeGreaterThan(-1);

    const mutationSteps = [
      'Commit version bump and tag',
      'Publish to NPM',
      'Publish GitHub Release',
    ];
    for (const step of mutationSteps) {
      expect(
        validate,
        `"Validate reviewed release notes" must precede "${step}" in publish.yml`,
      ).toBeLessThan(stepIndex(step));
    }
  });

  it('validates the notes exactly once (no stale duplicate after the push)', () => {
    expect(workflow.split('Validate reviewed release notes').length - 1).toBe(1);
  });

  it('ships reviewed notes for the current package version', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const version = `v${pkg.version}`;
    const notesPath = path.join(root, 'release-notes', `${version}.json`);
    const notes = JSON.parse(readFileSync(notesPath, 'utf8'));

    // Local require of the CJS contract module (dependency-free by design).
    const { validateReleaseNotes } = require('../../src/application/release-notes');
    const result = validateReleaseNotes(notes, version);
    expect(result.errors, `invalid release notes for ${version}`).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('makes normal CI validate the default next patch before it can trigger publishing', () => {
    const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const validate = ci.indexOf('- name: Validate default patch release notes');
    const tests = ci.indexOf('- run: npx vitest run');
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(tests);
    expect(ci).toContain('node .github/scripts/validate-default-next-release-notes.js');

    const script = readFileSync(path.join(root, '.github/scripts/validate-default-next-release-notes.js'), 'utf8');
    expect(script).toContain("path.join(__dirname, 'release-notes.js')");
    expect(script).toContain('patch + 1');
  });
});
