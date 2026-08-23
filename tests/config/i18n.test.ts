import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/config/user', () => ({
  loadUserConfig: vi.fn().mockResolvedValue({}),
  updateUserConfig: vi.fn().mockResolvedValue({}),
}));

const { setLanguage, getLanguage, t } = await import('../../src/config/i18n');

describe('i18n', () => {
  beforeEach(() => {
    setLanguage('zh');
  });

  it('defaults to Chinese', () => {
    expect(getLanguage()).toBe('zh');
  });

  it('switches to English and back', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    setLanguage('zh');
    expect(getLanguage()).toBe('zh');
  });

  it('returns Chinese translations', () => {
    setLanguage('zh');
    expect(t('success')).toBe('成功');
    expect(t('failed')).toBe('失败');
  });

  it('returns English translations', () => {
    setLanguage('en');
    expect(t('success')).toBe('Success');
    expect(t('failed')).toBe('Failed');
  });

  it('handles vault-related keys', () => {
    setLanguage('zh');
    expect(t('vaultSaved')).toBe('已保存:');
    setLanguage('en');
    expect(t('vaultSaved')).toBe('Saved:');
  });
});
