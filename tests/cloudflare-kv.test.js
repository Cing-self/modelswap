import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

// The adapters use the native global fetch (no node-fetch dependency).
vi.stubGlobal('fetch', fetchMock);

const kv = await import('../src/web/api/platform-adapters/cloudflare-kv.js');

const ok = (result = {}) => ({
  ok: true,
  json: async () => ({ success: true, result }),
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('cloudflare-kv adapter', () => {
  it('reports a clear error when the token has no Cloudflare accounts', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));

    await expect(kv.pushSync({ apiToken: 'token' }, 'user-1', { nonce: 'n' }))
      .rejects.toThrow('未找到 Cloudflare 账户');
  });
});
