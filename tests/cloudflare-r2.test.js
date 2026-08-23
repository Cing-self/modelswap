import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('node-fetch', () => ({ default: fetchMock }));

const r2 = await import('../src/web/api/platform-adapters/cloudflare-r2.js');

const TEST_PREFIX = 'test-';
const VALID_CONFIG = {
  accountId: '0123456789abcdef0123456789abcdef',
  r2AccessKeyId: TEST_PREFIX + 'access',
  r2SecretAccessKey: TEST_PREFIX + 'secret',
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('cloudflare-r2 adapter', () => {
  it('rejects placeholder account ids before making network requests', async () => {
    await expect(r2.pushSync({
      ...VALID_CONFIG,
      accountId: 'cf_account_id',
    }, 'user-1', { ciphertext: 'x' })).rejects.toThrow('R2 Account ID 格式不正确');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing R2 credentials before making network requests', async () => {
    await expect(r2.pushSync({
      ...VALID_CONFIG,
      r2SecretAccessKey: '',
    }, 'user-1', { ciphertext: 'x' })).rejects.toThrow('请配置 R2 Access Key ID 和 Secret Access Key');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
