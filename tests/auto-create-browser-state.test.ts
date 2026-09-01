import { describe, expect, it, vi } from 'vitest';

const { createAutoCreateBrowserState, classifyVolcengineLoginSurface } = require('../src/web/api/auto-create-browser-state.js');

function createStateProbe(execJs: (script: string) => Promise<string>) {
  return createAutoCreateBrowserState({
    execJs,
    sendCommand: vi.fn(),
    focusAutomationWindow: vi.fn(),
    sleep: async () => undefined,
    verificationTimeoutMs: 1000,
  });
}

describe('auto-create browser login state', () => {
  it('recognizes Zhipu’s phone/SMS login shell even when its input has no placeholder', async () => {
    const execJs = vi.fn(async () => JSON.stringify({
      url: 'https://open.bigmodel.cn/usercenter/apikeys',
      loginRoute: false,
      hasPasswordField: false,
      hasLoginInput: false,
      hasLoginPrompt: false,
      hasLoginAction: true,
      hasSmsLoginSurface: true,
      publicRootLoginSurface: false,
    }));
    const state = createStateProbe(execJs);

    await expect(state.detectLoginRequired({ id: 'zhipu', label: '智谱 AI' }))
      .resolves.toEqual({ loginRequired: true, url: 'https://open.bigmodel.cn/usercenter/apikeys' });
    expect(execJs.mock.calls[0][0]).toContain('获取验证码');
    expect(execJs.mock.calls[0][0]).toContain('登录 / 注册');
  });

  it('does not treat a normal signed-in page as a login surface', () => {
    const state = createStateProbe(async () => '{}');

    expect(state.classifyLoginRequiredState({
      loginRoute: false,
      hasPasswordField: false,
      hasLoginInput: false,
      hasLoginPrompt: false,
      hasLoginAction: true,
      hasSmsLoginSurface: false,
      publicRootLoginSurface: false,
    })).toBe(false);
  });

  it('does not mistake a signed-in Volcengine Agent Plan console shell for login merely because it retains a login link', () => {
    // Captured from the Agent Plan console: it exposes an account-resource
    // menu after sign-in, but the page shell may still contain login wording.
    expect(classifyVolcengineLoginSurface({
      loginPrompt: false,
      credentialSurface: true,
      loginAction: true,
      signedInAccountSurface: true,
    })).toBe(false);
  });

  it('still recognizes a Volcengine credential page with only a login action as signed out', () => {
    expect(classifyVolcengineLoginSurface({
      loginPrompt: false,
      credentialSurface: true,
      loginAction: true,
      signedInAccountSurface: false,
    })).toBe(true);
  });
});
