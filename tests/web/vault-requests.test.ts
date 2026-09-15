import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'module';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Isolated HOME (setup-isolated-home also applies, but the queue path must
// land in the isolated dir, so assert against it below).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-requests-'));
vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);

const mockWs = vi.hoisted(() => ({
  pushToExtension: vi.fn(),
  isExtensionConnected: vi.fn(() => true),
}));

// TS-rooted deps of the CJS module under test — mockable only via the
// require hook (the web/api CJS convention; see sync.test.js).
const mockStore = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => (values.has(key) ? values.get(key) : null)),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    _values: values,
  };
});
const mockGroupMeta = vi.hoisted(() => ({
  normalizeVaultGroup: vi.fn((group?: string) => group ?? ''),
}));

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === './ws-extension') return mockWs;
  if (id === '../../vault/store') return { VaultStore: function () { return mockStore; } };
  if (id === '../../vault/group-meta') return mockGroupMeta;
  return origRequire.apply(this, arguments);
};

const QUEUE_FILE = path.join(TEST_HOME, '.modelswap', 'vault-requests.json');

type ModuleType = typeof import('../../src/web/api/vault-requests.js');

async function freshModule(): Promise<ModuleType> {
  vi.resetModules();
  return await import('../../src/web/api/vault-requests.js');
}

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

async function waitForFile(): Promise<void> {
  // persistQueue is fire-and-forget; give the atomic write a moment.
  for (let i = 0; i < 40 && !fs.pathExistsSync(QUEUE_FILE); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockStore._values.clear();
  await fs.remove(path.join(TEST_HOME, '.modelswap'));
});

describe('vault request pattern safety', () => {
  it('accepts ordinary key-shape patterns', async () => {
    const mod = await freshModule();
    expect(mod.isPatternSafe('sk-[a-f0-9]{32}')).toBe(true);
    expect(mod.isPatternSafe('[A-Za-z0-9_-]{20,}')).toBe(true);
    expect(mod.isPatternSafe('(\\d{1,3}\\.){3}\\d')).toBe(true);
    expect(mod.isPatternSafe('(safe)?next')).toBe(true);
  });

  it('rejects nested unbounded quantifiers and overlapping alternations', async () => {
    const mod = await freshModule();
    expect(mod.isPatternSafe('(a+)+$')).toBe(false);
    expect(mod.isPatternSafe('(a|aa)*')).toBe(false);
    expect(mod.isPatternSafe('((x+y)*)z')).toBe(false);
  });

  it('rejects an unsafe pattern at creation with a clear error', async () => {
    const mod = await freshModule();
    const res = mockRes();
    await mod.createRequests(
      { body: { items: [{ key: 'EVIL_KEY', pattern: '(a+)+$' }] } } as any,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('catastrophic backtracking');
  });
});

describe('vault request queue persistence', () => {
  it('survives a server restart: create → reload → list shows the request', async () => {
    const first = await freshModule();
    const res = mockRes();
    await first.createRequests(
      { body: { items: [{ key: 'PERSIST_KEY', group: 'AI', url: 'https://console.example.com/keys' }] } } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    const id = res.body.id;
    await waitForFile();
    expect(fs.pathExistsSync(QUEUE_FILE)).toBe(true);

    // Simulate a server restart: a brand-new module instance starts with an
    // empty in-memory map and must reload the queue from disk.
    const second = await freshModule();
    const list = mockRes();
    await second.listRequests({} as any, list);
    const restored = list.body.requests.find((r: any) => r.id === id);
    expect(restored).toBeTruthy();
    expect(restored.items[0].key).toBe('PERSIST_KEY');
    expect(restored.items[0].status).toBe('pending');
  });

  it('drops expired entries when reloading', async () => {
    const first = await freshModule();
    const res = mockRes();
    await first.createRequests({ body: { items: [{ key: 'OLD_KEY' }] } } as any, res);
    await waitForFile();
    // Age the persisted entry past its TTL.
    const raw = fs.readJsonSync(QUEUE_FILE);
    raw[0].expiresAt = Date.now() - 1000;
    fs.writeJsonSync(QUEUE_FILE, raw);

    const second = await freshModule();
    const list = mockRes();
    await second.listRequests({} as any, list);
    expect(list.body.requests).toEqual([]);
  });

  it('keeps a fulfilled capture across a restart', async () => {
    const first = await freshModule();
    const res = mockRes();
    await first.createRequests({ body: { items: [{ key: 'CAPTURE_KEY', pattern: 'sk-[a-f0-9]{8,}' }] } } as any, res);
    const id = res.body.id;
    const captured = await first.captureFromExtension({ requestId: id, key: 'CAPTURE_KEY', value: 'sk-abcd1234efgh' });
    expect(captured.ok).toBe(true);
    // The create's persist already wrote the file; wait until the capture's
    // serialized write lands (content flips to fulfilled).
    for (let i = 0; i < 40; i++) {
      if (fs.pathExistsSync(QUEUE_FILE) && fs.readFileSync(QUEUE_FILE, 'utf8').includes('"status": "fulfilled"')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const second = await freshModule();
    const list = mockRes();
    await second.listRequests({} as any, list);
    const restored = list.body.requests.find((r: any) => r.id === id);
    expect(restored.items[0].status).toBe('fulfilled');
    expect(restored.items[0].masked).toBeTruthy();
    // The persisted queue is metadata only — never the value itself.
    expect(fs.readFileSync(QUEUE_FILE, 'utf8')).not.toContain('sk-abcd1234efgh');
  });
});
