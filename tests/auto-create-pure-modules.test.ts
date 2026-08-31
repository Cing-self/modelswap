import { describe, expect, it } from 'vitest';

const extraction = require('../src/application/auto-create-extraction.js');
const actions = require('../src/application/auto-create-action-resolution.js');
const { createAutoCreateRunService } = require('../src/application/auto-create-run-service.js');
const { listPlatformDirectory } = require('../src/application/auto-create-platform-directory.js');

describe('auto-create pure extraction and action modules', () => {
  it('extracts credential pairs while rejecting masked values', () => {
    expect(extraction.findCredentialPair({ nested: { access_key_id: 'AKIA12345678', secret_access_key: 'secret-value-123' } }))
      .toEqual({ accessKey: 'AKIA12345678', secretKey: 'secret-value-123' });
    expect(extraction.findCredentialPair({ accessKey: 'AKIA12345678', secretKey: '***masked***' })).toBeNull();
    expect(extraction.isValidZhipuApiKey('a'.repeat(32) + '.secret12')).toBe(true);
    expect(extraction.isValidZhipuApiKey('a'.repeat(32) + '.***masked***')).toBe(false);
  });

  it('projects a public platform directory without browser selectors', () => {
    expect(listPlatformDirectory([{ id: 'demo', label: 'Demo', keyHint: 'DEMO_KEY', groupHint: 'Demo', mode: 'browser', createSelectors: ['secret'] }]))
      .toEqual([{ id: 'demo', label: 'Demo', keyHint: 'DEMO_KEY', groupHint: 'Demo', mode: 'browser' }]);
  });

  it('prefers the verified create control and fails closed for destructive or ambiguous actions', () => {
    const safe = { text: 'Create API Key', visible: true, selectorMatch: true };
    expect(actions.resolveActionCandidate([{ text: 'Delete API Key', visible: true }, safe])).toBe(safe);
    expect(actions.scoreActionCandidate({ text: 'Reset API Key', visible: true, selectorMatch: true })).toBe(0);
    expect(actions.resolveActionCandidate([
      { text: 'Create API Key', visible: true },
      { text: 'Create API Key', visible: true },
    ])).toBeNull();
  });

  it('expires completed runs and pauses/resumes safely without creating before verification', async () => {
    const timers: Array<() => void> = [];
    let created = 0;
    const service = createAutoCreateRunService({
      randomId: (() => { let index = 0; return () => `run-${++index}`; })(), now: () => new Date('2026-08-27T00:00:00Z'),
      setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined,
      resultTtlMs: 10, verificationTimeoutMs: 10, extensionConnected: () => true,
      createBrowserKey: async () => { created += 1; return { value: 'key-value', name: 'key' }; },
      isAssetData: () => false, classifyLimit: () => null, detectLogin: async () => ({ loginRequired: false }),
      focusBrowser: async () => false, sleep: async () => undefined, detectVerification: async () => false,
    });
    const run = service.create({ platformConfig: { id: 'demo', label: 'Demo' }, tokenName: 'token' });
    await service.execute(run);
    expect(service.status('run-1')).toMatchObject({ status: 'succeeded', value: 'key-value' });
    timers[0]();
    expect(() => service.status('run-1')).toThrow(/不存在或已过期/);
    const paused = service.create({ platformConfig: { id: 'demo', label: 'Demo' }, tokenName: 'token-2' });
    const waiting = service.pauseForVerification({ run: paused, platform: paused.platformConfig, stage: 'create-security-verification' });
    await Promise.resolve();
    expect(service.status('run-2')).toMatchObject({ status: 'verification_required', verificationRequired: true });
    service.resume('run-2');
    await waiting;
    expect(service.status('run-2')).toMatchObject({ status: 'running', pending: true });
    expect(created).toBe(1);
  });

  it('turns a Chinese sign-in error into a resumable login handoff even if the page probe is unavailable', async () => {
    const service = createAutoCreateRunService({
      randomId: () => 'login-run', now: () => new Date('2026-08-31T00:00:00Z'),
      setTimer: () => 1, clearTimer: () => undefined,
      resultTtlMs: 10, verificationTimeoutMs: 10, extensionConnected: () => true,
      createBrowserKey: async () => { throw new Error('需要登录智谱 AI (https://open.bigmodel.cn/login)'); },
      isAssetData: () => false, classifyLimit: () => null, detectLogin: async () => ({ loginRequired: false }),
      focusBrowser: async () => true, sleep: async () => undefined, detectVerification: async () => false,
    });
    const run = service.create({ platformConfig: { id: 'zhipu', label: '智谱 AI', url: 'https://open.bigmodel.cn/apikey/platform' }, tokenName: 'token' });

    await service.execute(run);

    expect(service.status('login-run')).toMatchObject({
      success: false,
      status: 'login_required',
      loginRequired: true,
      browserFocused: true,
      loginUrl: 'https://open.bigmodel.cn/apikey/platform',
    });
  });
});
