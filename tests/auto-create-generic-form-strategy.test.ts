import { describe, expect, it, vi } from 'vitest';

const { createGenericFormStrategy } = require('../src/web/api/auto-create-generic-form-strategy.js');

describe('generic auto-create form strategy', () => {
  it('fails during setup when a safety action helper is not wired', () => {
    expect(() => createGenericFormStrategy({
      execJs: async () => '',
      sendCommand: vi.fn(),
      sleep: async () => undefined,
      foregroundClick: async () => true,
      waitForInteractiveVerification: async () => undefined,
    })).toThrow('通用创建表单策略缺少安全动作解析依赖');
  });

  it('resolves and confirms Mistral’s verified New key action through injected action helpers', async () => {
    const candidate = {
      index: 0,
      text: 'New key',
      ariaLabel: '',
      title: '',
      inVerifiedScope: true,
      selectorMatch: true,
      belowNameInput: true,
    };
    const resolveActionCandidate = vi.fn(() => candidate);
    const scoreActionCandidate = vi.fn(() => 100);
    const descriptorFingerprint = vi.fn(() => 'new key||');
    const execJs = vi.fn(async (script: string) => {
      if (script.includes('const confirmSelectors') && script.includes('const descriptors')) {
        return JSON.stringify({ hasScope: true, descriptors: [candidate], buttons: ['New key'] });
      }
      if (script.includes('const targetIndex')) return JSON.stringify({ ok: true, foreground: false });
      return JSON.stringify({ filled: true });
    });
    const submit = createGenericFormStrategy({
      execJs,
      sendCommand: vi.fn(),
      sleep: async () => undefined,
      foregroundClick: async () => true,
      waitForInteractiveVerification: async () => undefined,
      resolveActionCandidate,
      scoreActionCandidate,
      descriptorFingerprint,
    });
    const state = {
      platform: {
        id: 'mistral',
        label: 'Mistral',
        nameSelectors: ['input[placeholder="My API Key"]'],
        confirmTexts: ['New key'],
        confirmSelectors: ['button[type="submit"]'],
        confirmAfterNameInput: true,
      },
      uniqueName: 'MISTRAL_API_KEY-test',
      tabId: 'mistral-tab',
    };

    await expect(submit(state)).resolves.toBe(state);
    expect(resolveActionCandidate).toHaveBeenCalledWith([candidate], expect.objectContaining({
      phrases: ['New key'], belowNameInputBonus: true,
    }));
    expect(descriptorFingerprint).toHaveBeenCalledWith(candidate);
    expect(scoreActionCandidate).not.toHaveBeenCalled();
  });
});
