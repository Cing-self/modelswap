import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp } from 'fs/promises';

const sep = process.platform === 'win32' ? '\\' : '/';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const sep = process.platform === 'win32' ? '\\' : '/';
  const prefix = (p: string) => (p.endsWith(sep) ? p : p + sep);
  const isDir = (p: string) =>
    dirs.has(p) || [...files.keys()].some(k => k.startsWith(prefix(p)));
  return {
    files,
    dirs,
    pathExists: vi.fn(async function (p: string) { return dirs.has(p) || files.has(p); }),
    readFile: vi.fn(async function (p: string) { return files.get(p) ?? ''; }),
    writeFile: vi.fn(async function (p: string, c: string) { files.set(p, c); }),
    rename: vi.fn(async function (oldPath: string, newPath: string) {
      if (files.has(oldPath)) { files.set(newPath, files.get(oldPath)!); files.delete(oldPath); }
    }),
    ensureDir: vi.fn(async function (p: string) { dirs.add(p); }),
    chmod: vi.fn(async function () {}),
    readdir: vi.fn(async function (dir: string) {
      const pfx = prefix(dir);
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(pfx)) {
          const rest = k.slice(pfx.length);
          const top = rest.includes(sep) ? rest.slice(0, rest.indexOf(sep)) : rest;
          if (top) names.add(top);
        }
      }
      for (const k of dirs.keys()) {
        if (k.startsWith(pfx)) {
          const rest = k.slice(pfx.length);
          const top = rest.includes(sep) ? rest.slice(0, rest.indexOf(sep)) : rest;
          if (top) names.add(top);
        }
      }
      return [...names];
    }),
    remove: vi.fn(async function (p: string) {
      const pfx = prefix(p);
      for (const k of [...files.keys()]) if (k === p || k.startsWith(pfx)) files.delete(k);
      for (const k of [...dirs.keys()]) if (k === p || k.startsWith(pfx)) dirs.delete(k);
    }),
    stat: vi.fn(async function (p: string) {
      return { isDirectory: () => isDir(p), size: files.get(p)?.length ?? 0 };
    }),
  };
});

vi.mock('fs-extra', () => ({ default: mocks }));

const {
  agentConfigFiles,
  capturePreSwitchSnapshot,
  listSnapshots,
  getSnapshotFiles,
  getCurrentFiles,
  restoreSnapshot,
} = await import('../../src/providers/snapshots');

const HOMEDIR = os.homedir();
const SETTINGS_PATH = path.join(HOMEDIR, '.claude', 'settings.json');
const HELPER_PATH = path.join(HOMEDIR, '.claude', '.okit-key-helper.sh');
const ZCODE_V2_PATH = path.join(HOMEDIR, '.zcode', 'v2', 'config.json');
const ZCODE_CLI_PATH = path.join(HOMEDIR, '.zcode', 'cli', 'config.json');

let ROOT: string;

beforeEach(async () => {
  mocks.files.clear();
  mocks.dirs.clear();
  ROOT = await mkdtemp(path.join(os.tmpdir(), 'okit-snap-'));
});

function snapshotDir(agentId: string, id: string): string {
  return path.join(ROOT, 'agent-snapshots', agentId, id);
}

function seedSnapshot(agentId: string, id: string, fileName = 'settings.json', content = '{}') {
  const dir = snapshotDir(agentId, id);
  mocks.files.set(path.join(dir, fileName), content);
  mocks.dirs.add(dir);
}

describe('agentConfigFiles', () => {
  it('covers all 10 agents with the expected paths', () => {
    const expected: [string, string[]][] = [
      ['claude', ['.claude/settings.json', '.claude/.credentials.json', '.claude/.okit-key-helper.sh']],
      ['codex', ['.codex/config.toml', '.codex/auth.json', '.codex/model-catalogs/model-catalogs.json']],
      ['grok', ['.grok/config.toml']],
      ['kimi-code', ['.kimi-code/config.toml']],
      ['mimo-code', ['.config/mimocode/mimocode.jsonc']],
      ['opencode', ['.config/opencode/opencode.json', '.local/share/opencode/auth.json']],
      ['openclaw', ['.openclaw/openclaw.json']],
      ['hermes', ['.hermes/config.yaml']],
      ['workbuddy', ['.workbuddy/models.json']],
      ['zcode', ['.zcode/v2/config.json', '.zcode/cli/config.json']],
    ];
    for (const [agentId, rels] of expected) {
      expect(agentConfigFiles(agentId)).toEqual(rels.map(r => path.join(HOMEDIR, r)));
    }
  });
});

describe('capturePreSwitchSnapshot', () => {
  it('snapshots only existing files with byte-identical content', async () => {
    mocks.files.set(SETTINGS_PATH, '{"env":{"ANTHROPIC_BASE_URL":"https://old.example"}}');
    mocks.files.set(HELPER_PATH, '#!/bin/sh\necho old\n');

    const id = await capturePreSwitchSnapshot('claude', ROOT);
    expect(id).toBeTruthy();

    const dir = snapshotDir('claude', id!);
    // Exactly the 2 existing files under the snapshot dir, .credentials.json missing.
    const filesUnderDir = [...mocks.files.entries()]
      .filter(([k]) => k.startsWith(dir + sep))
      .map(([k, v]) => ({ name: path.basename(k), content: v }));
    expect(filesUnderDir).toHaveLength(2);
    expect(filesUnderDir.find(f => f.name === 'settings.json')!.content).toBe(mocks.files.get(SETTINGS_PATH));
    expect(filesUnderDir.find(f => f.name === '.okit-key-helper.sh')!.content).toBe(mocks.files.get(HELPER_PATH));
  });

  it('returns null when no config file exists', async () => {
    const id = await capturePreSwitchSnapshot('claude', ROOT);
    expect(id).toBeNull();
  });

  it('rejects an invalid agentId', async () => {
    await expect(capturePreSwitchSnapshot('../etc', ROOT)).rejects.toThrow();
    await expect(capturePreSwitchSnapshot('CLAUDE', ROOT)).rejects.toThrow();
  });
});

describe('zcode duplicate basenames', () => {
  // zcode owns two files both named config.json. Snapshots must keep BOTH —
  // storing by basename made the second write clobber the first.
  it('captures both zcode config files under disambiguated names', async () => {
    mocks.files.set(ZCODE_V2_PATH, '{"v2":true}');
    mocks.files.set(ZCODE_CLI_PATH, '{"cli":true}');

    const id = await capturePreSwitchSnapshot('zcode', ROOT);
    expect(id).toBeTruthy();

    const dir = snapshotDir('zcode', id!);
    expect(mocks.files.get(path.join(dir, 'v2__config.json'))).toBe('{"v2":true}');
    expect(mocks.files.get(path.join(dir, 'cli__config.json'))).toBe('{"cli":true}');
    // The bare colliding name must not exist at all.
    expect(mocks.files.has(path.join(dir, 'config.json'))).toBe(false);
  });

  it('restores both zcode files after a switch changed them', async () => {
    mocks.files.set(ZCODE_V2_PATH, '{"v2":"original"}');
    mocks.files.set(ZCODE_CLI_PATH, '{"cli":"original"}');
    const id = await capturePreSwitchSnapshot('zcode', ROOT);

    mocks.files.set(ZCODE_V2_PATH, '{"v2":"switched"}');
    mocks.files.set(ZCODE_CLI_PATH, '{"cli":"switched"}');

    await restoreSnapshot('zcode', id!, ROOT);

    expect(mocks.files.get(ZCODE_V2_PATH)).toBe('{"v2":"original"}');
    expect(mocks.files.get(ZCODE_CLI_PATH)).toBe('{"cli":"original"}');
  });

  it('reports both files in getCurrentFiles with matching names', async () => {
    mocks.files.set(ZCODE_V2_PATH, '{"v2":1}');
    const files = await getCurrentFiles('zcode', ROOT);
    expect(files.map(f => f.name).sort()).toEqual(['cli__config.json', 'v2__config.json']);
    expect(files.find(f => f.name === 'v2__config.json')!.content).toBe('{"v2":1}');
    expect(files.find(f => f.name === 'cli__config.json')!.content).toBeNull();
  });

  it('still restores legacy snapshots that stored a bare config.json', async () => {
    // Old snapshots only contain the last-written file (cli). The basename
    // fallback must map it back to the cli file — the old behavior.
    mocks.files.set(ZCODE_V2_PATH, '{"v2":"current"}');
    mocks.files.set(ZCODE_CLI_PATH, '{"cli":"current"}');
    seedSnapshot('zcode', '2020-01-01T00-00-00-000Z', 'config.json', '{"cli":"legacy"}');

    await restoreSnapshot('zcode', '2020-01-01T00-00-00-000Z', ROOT);

    expect(mocks.files.get(ZCODE_CLI_PATH)).toBe('{"cli":"legacy"}');
    // The v2 file was never captured by the legacy format — untouched.
    expect(mocks.files.get(ZCODE_V2_PATH)).toBe('{"v2":"current"}');
  });
});

describe('listSnapshots', () => {
  it('returns snapshots newest-first with file metadata', async () => {
    seedSnapshot('claude', '2020-01-01T00-00-00-001Z', 'settings.json', '{"a":1}');
    seedSnapshot('claude', '2020-01-01T00-00-00-003Z', 'settings.json', '{"a":3}');
    seedSnapshot('claude', '2020-01-01T00-00-00-002Z', 'settings.json', '{"a":2}');

    const snapshots = await listSnapshots('claude', ROOT);
    expect(snapshots.map(s => s.id)).toEqual([
      '2020-01-01T00-00-00-003Z',
      '2020-01-01T00-00-00-002Z',
      '2020-01-01T00-00-00-001Z',
    ]);
    for (const s of snapshots) {
      expect(s.files).toEqual([{ name: 'settings.json', size: '{"a":3}'.length }]);
    }
  });

  it('returns an empty list when no snapshots exist', async () => {
    expect(await listSnapshots('claude', ROOT)).toEqual([]);
  });
});

describe('getSnapshotFiles / getCurrentFiles', () => {
  it('returns snapshot contents and current-with-null for missing files', async () => {
    mocks.files.set(SETTINGS_PATH, '{"snapped":true}');
    mocks.files.set(HELPER_PATH, '#!/bin/sh\necho x\n');
    const id = await capturePreSwitchSnapshot('claude', ROOT);

    const snapshotFiles = await getSnapshotFiles('claude', id!, ROOT);
    expect(snapshotFiles).toEqual([
      { name: '.okit-key-helper.sh', content: '#!/bin/sh\necho x\n' },
      { name: 'settings.json', content: '{"snapped":true}' },
    ]);

    const currentFiles = await getCurrentFiles('claude', ROOT);
    expect(currentFiles).toEqual([
      { name: 'settings.json', content: '{"snapped":true}' },
      { name: '.credentials.json', content: null },
      { name: '.okit-key-helper.sh', content: '#!/bin/sh\necho x\n' },
    ]);
  });

  it('rejects an invalid snapshot id', async () => {
    await expect(getSnapshotFiles('claude', '../etc', ROOT)).rejects.toThrow();
  });
});

describe('restoreSnapshot', () => {
  it('restores the original content via atomic write to the original path', async () => {
    mocks.files.set(SETTINGS_PATH, '{"env":{"ANTHROPIC_BASE_URL":"https://before.example"}}');
    mocks.files.set(HELPER_PATH, '#!/bin/sh\necho before\n');
    const id = await capturePreSwitchSnapshot('claude', ROOT);
    expect(id).toBeTruthy();

    mocks.files.set(SETTINGS_PATH, '{"env":{"ANTHROPIC_BASE_URL":"https://after.example"}}');
    mocks.files.set(HELPER_PATH, '#!/bin/sh\necho after\n');

    await restoreSnapshot('claude', id!, ROOT);

    expect(mocks.files.get(SETTINGS_PATH)).toBe('{"env":{"ANTHROPIC_BASE_URL":"https://before.example"}}');
    expect(mocks.files.get(HELPER_PATH)).toBe('#!/bin/sh\necho before\n');
    expect(mocks.files.has(SETTINGS_PATH + '.okit-tmp')).toBe(false);
  });
});

describe('snapshot retention', () => {
  it('keeps only the newest 10 snapshots per agent', async () => {
    mocks.files.set(SETTINGS_PATH, '{"env":{}}');

    const seedN = (n: number) => {
      const id = n < 10 ? `2020-01-01T00-00-00-00${n}Z` : `2020-01-01T00-00-00-${n}Z`;
      seedSnapshot('claude', id, 'settings.json', `{"seed":${n}}`);
      return id;
    };
    for (let n = 1; n <= 11; n++) seedN(n);

    const newId = await capturePreSwitchSnapshot('claude', ROOT);
    expect(newId).toBeTruthy();

    const snapshots = await listSnapshots('claude', ROOT);
    expect(snapshots).toHaveLength(10);

    const ids = snapshots.map(s => s.id);
    expect(ids).toContain(newId);
    // The 2 oldest seeded snapshots were pruned.
    expect(ids).not.toContain('2020-01-01T00-00-00-001Z');
    expect(ids).not.toContain('2020-01-01T00-00-00-002Z');
  });

  it('protects the given snapshot id from pruning', async () => {
    mocks.files.set(SETTINGS_PATH, '{"env":{}}');

    // 10 existing snapshots; the restore target is the very oldest.
    for (let n = 1; n <= 10; n++) {
      const id = n < 10 ? `2020-01-01T00-00-00-00${n}Z` : `2020-01-01T00-00-00-${n}Z`;
      seedSnapshot('claude', id, 'settings.json', `{"seed":${n}}`);
    }
    const targetId = '2020-01-01T00-00-00-001Z';

    await capturePreSwitchSnapshot('claude', ROOT, targetId);

    const ids = (await listSnapshots('claude', ROOT)).map(s => s.id);
    // The protected target survives; pruning is skipped for this round (11
    // entries) rather than evicting the next-newest snapshot to compensate.
    expect(ids).toContain(targetId);
    expect(ids).toHaveLength(11);
    expect(ids).toContain('2020-01-01T00-00-00-002Z');
  });
});