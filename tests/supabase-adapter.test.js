import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

// The adapters use the native global fetch (no node-fetch dependency).
vi.stubGlobal('fetch', fetchMock);

const supabase = await import('../src/web/api/platform-adapters/supabase.js');

beforeEach(() => {
  fetchMock.mockReset();
});

describe('supabase adapter', () => {
  it('upserts sync data by key on repeated pushes', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 201,
      ok: true,
      text: async () => '[]',
    });

    await supabase.pushSync({
      projectId: 'abcdefghijklmnopqrst',
      apiKey: 'secret',
    }, 'user-1', { nonce: 'n' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1/modelswap_sync?on_conflict=key',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Prefer: 'resolution=merge-duplicates' }),
      }),
    );
  });
});
