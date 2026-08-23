import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'module';

const fetchMock = vi.hoisted(() => vi.fn());

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-fetch') return fetchMock;
  return origRequire.apply(this, arguments);
};

const d1 = await import('../src/web/api/platform-adapters/cloudflare-d1.js');

const ok = (result = {}) => ({
  json: async () => ({ success: true, result }),
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('cloudflare-d1 adapter', () => {
  it('reports a clear error when the token has no Cloudflare accounts', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));

    await expect(d1.pushSync({ apiToken: 'token' }, 'user-1', { nonce: 'n' }))
      .rejects.toThrow('未找到 Cloudflare 账户');
  });

  it('recreates wrong okit_sync schemas before pushing sync data', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 'account-1' }]))
      .mockResolvedValueOnce(ok([{ name: 'okit-sync', uuid: 'db-1' }]))
      .mockResolvedValueOnce(ok([{ name: 'name' }, { name: 'value' }, { name: 'updated_at' }]))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await d1.pushSync({ apiToken: 'token' }, 'user-1', { nonce: 'n', ciphertext: "has'quote" });

    const sqlStatements = fetchMock.mock.calls
      .map(([, options]) => options?.body && JSON.parse(options.body).sql)
      .filter(Boolean);

    expect(sqlStatements).toContain('DROP TABLE IF EXISTS okit_sync');
    expect(sqlStatements).toContain('CREATE TABLE IF NOT EXISTS okit_sync (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, machine_id TEXT, updated_at TEXT NOT NULL)');
    expect(sqlStatements).toContain('DELETE FROM okit_sync WHERE user_id = ?');
    expect(sqlStatements).toContain('INSERT INTO okit_sync (user_id, data, machine_id, updated_at) VALUES (?, ?, ?, ?)');

    const insertCall = fetchMock.mock.calls.find(([, options]) => {
      const body = options?.body && JSON.parse(options.body);
      return body?.sql === 'INSERT INTO okit_sync (user_id, data, machine_id, updated_at) VALUES (?, ?, ?, ?)';
    });
    expect(JSON.parse(insertCall[1].body).params[1]).toBe(JSON.stringify({ nonce: 'n', ciphertext: "has'quote" }));
  });
});
