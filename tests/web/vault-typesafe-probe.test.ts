import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Module from 'module';
import http from 'node:http';

// vault.js constructs a real VaultStore through a bare CJS require seam at
// module load. Patch the same seams tests/vault-api.test.js uses so this suite
// never touches a real vault; the global isolated-home setup covers the rest.
const mockStore = { get: vi.fn(), reload: vi.fn() };
function MockVaultStore() { return mockStore; }
const origRequire = Module.prototype.require;
// The real shared module (vitest resolves the TS import); native require()
// cannot resolve the extensionless .ts specifiers on its own.
const realGroupMeta = await import('../../src/vault/group-meta');
Module.prototype.require = function (id) {
  if (id === '../../vault/store') return { VaultStore: MockVaultStore };
  if (id === '../../vault/group-meta') return realGroupMeta;
  return origRequire.apply(this, arguments);
};

const { testApiKey } = await import('../../src/web/api/vault.js');

describe('vault testApiKey — TypeSafe System One probe', () => {
  let server: http.Server;
  let baseUrl: string;
  let respondWith: number;
  let lastRequest: { path: string; authorization: string; body: any };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        lastRequest = {
          path: req.url || '',
          authorization: String(req.headers.authorization || ''),
          body: raw ? JSON.parse(raw) : null,
        };
        res.statusCode = respondWith;
        res.end(JSON.stringify({ ok: respondWith === 200 }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
    Module.prototype.require = origRequire;
  });

  function probe(overrides = {}) {
    const out: { statusCode: number; body: any } = { statusCode: 0, body: null };
    const res = {
      status(code: number) { out.statusCode = code; return this; },
      json(body: any) { out.body = body; return this; },
    };
    return testApiKey(
      { body: { baseUrl, type: 'typesafe', keyValue: 'sk-typesafe-test', ...overrides } } as any,
      res as any,
    ).then(() => out.body);
  }

  it('probes /v1/systemone with a minimal noul question and Bearer auth', async () => {
    respondWith = 200;
    const result = await probe();
    expect(lastRequest.path).toBe('/v1/systemone');
    expect(lastRequest.authorization).toBe('Bearer sk-typesafe-test');
    expect(lastRequest.body.model).toBe('jev-latest');
    expect(typeof lastRequest.body.state).toBe('string');
    expect(lastRequest.body.questions.probe.type).toBe('noul');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Key 有效');
  });

  it('normalizes a /v1 endpoint baseUrl instead of doubling the prefix', async () => {
    respondWith = 200;
    const result = await probe({ baseUrl: `${baseUrl}/v1` });
    expect(lastRequest.path).toBe('/v1/systemone');
    expect(result.success).toBe(true);
  });

  it('reports an invalid key on 401 and 403', async () => {
    respondWith = 401;
    const missing = await probe();
    expect(missing.success).toBe(false);
    expect(missing.message).toContain('API Key 无效');
    respondWith = 403;
    const invalid = await probe();
    expect(invalid.success).toBe(false);
    expect(invalid.message).toContain('API Key 无效');
  });

  it('treats 422 as a valid key: auth is checked before body validation', async () => {
    respondWith = 422;
    const result = await probe();
    expect(result.success).toBe(true);
    expect(result.message).toContain('Key 有效');
  });

  it('keeps a rate-limited probe from being reported as a credential failure', async () => {
    respondWith = 429;
    const result = await probe();
    expect(result.success).toBe(false);
    expect(result.message).toContain('速率限制');
    expect(result.message).not.toContain('API Key 无效');
  });
});
