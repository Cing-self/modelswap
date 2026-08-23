// Integration test for the POST /api/providers/switch handler — input validation
// and control flow only.
//
// The per-adapter applyConfig correctness is covered by the 66 unit tests under
// tests/providers/adapters/*.test.ts. Here we assert the handler's request
// validation: missing fields, unknown agent/provider/model ids, and the
// adapterSupportsProvider compatibility gate. These paths run before the adapter
// is invoked, so no fs mocking of the agent config files is needed — we only
// mock providers.json/user.json reads via fs-extra.
//
// The success-path end-to-end (actually writing ~/.claude/settings.json etc.)
// is covered by the manual test matrix in docs/USAGE-REDESIGN-BATTLE-PLAN.md,
// not by an automated test, because it requires mocking the full config/user.ts
// dependency chain which provides low signal given the exhaustive adapter
// unit coverage already in place.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';

const OKIT_DIR = path.join(os.homedir(), '.okit');
const PROVIDERS_PATH = path.join(OKIT_DIR, 'providers.json');

const memFiles = new Map<string, string>();

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(async (p: string) => memFiles.has(p)),
    readFile: vi.fn(async (p: string) => memFiles.get(p) ?? ''),
    writeFile: vi.fn(async (p: string, c: string) => { memFiles.set(p, c); }),
    rename: vi.fn(async (oldPath: string, newPath: string) => { const c = memFiles.get(oldPath); if (c !== undefined) memFiles.set(newPath, c); }),
    ensureDir: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/web/api/backup', () => ({ backupImportantData: vi.fn(async () => {}) }));

const { switchProvider } = await import('../../src/web/api/providers');

// Real preset ids so loadProviders (which falls back to PRESET_PROVIDERS when
// providers.json is absent) can resolve them.
const ANTHROPIC_PROVIDER_ID = 'anthropic';   // type: anthropic
const ANTHROPIC_MODEL_ID = 'claude-opus-4-7';

function makeRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = function (c: number) { this.statusCode = c; return this; };
  res.json = function (d: any) { this.body = d; return this; };
  return res;
}

beforeEach(() => {
  memFiles.clear();
  // Intentionally do NOT seed PROVIDERS_PATH — loadProviders falls back to the
  // built-in PRESET_PROVIDERS, giving deterministic ids to test against.
});

describe('switchProvider handler — input validation', () => {
  it('returns 400 on missing required fields', async () => {
    const req = { body: { agentId: 'claude' } };
    const res = makeRes();
    await switchProvider(req as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('returns 404 for an unknown agent id', async () => {
    const req = { body: { agentId: 'no-such-agent', providerId: ANTHROPIC_PROVIDER_ID, modelId: ANTHROPIC_MODEL_ID } };
    const res = makeRes();
    await switchProvider(req as any, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Agent not found/);
  });

  it('returns 404 for an unknown provider id', async () => {
    const req = { body: { agentId: 'claude', providerId: 'no-such-provider', modelId: ANTHROPIC_MODEL_ID } };
    const res = makeRes();
    await switchProvider(req as any, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/Provider not found/);
  });

  it('returns 400 when the adapter does not support the provider type', async () => {
    // codex only supports 'openai'; feeding an 'anthropic' provider is rejected
    // by adapterSupportsProvider before the adapter is ever called.
    const req = { body: { agentId: 'codex', providerId: ANTHROPIC_PROVIDER_ID, modelId: ANTHROPIC_MODEL_ID } };
    const res = makeRes();
    await switchProvider(req as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/does not support/);
  });

  it('returns 400 when the model id is not in the provider model list', async () => {
    const req = { body: { agentId: 'claude', providerId: ANTHROPIC_PROVIDER_ID, modelId: 'no-such-model' } };
    const res = makeRes();
    await switchProvider(req as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Model not found/);
  });
});
