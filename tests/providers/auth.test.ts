import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/vault/store', () => ({
  VaultStore: vi.fn().mockImplementation(function(this: any) {
    this.get = vi.fn(async (key: string) => key === 'SERVICE_KEY' ? 'secret-value' : null);
  }),
}));

const { checkVaultKey } = await import('../../src/providers/auth');

describe('checkVaultKey', () => {
  it('recognizes a stored vault key', async () => {
    await expect(checkVaultKey('SERVICE_KEY')).resolves.toBe(true);
  });
});
