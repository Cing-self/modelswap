import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { createZhipuStrategy } = require('../src/web/api/auto-create-zhipu-strategy.js');
const { createGenericNavigationStrategy } = require('../src/web/api/auto-create-generic-navigation-strategy.js');
const { createVolcengineMinimaxStrategy } = require('../src/web/api/auto-create-volcengine-minimax-strategy.js');
const { createBrowserDeleteStrategy } = require('../src/web/api/auto-create-delete-browser-strategy.js');
const { createCloudflareKeyService } = require('../src/application/auto-create-cloudflare-service.js');

const asyncNoop = async () => undefined;
const successfulNavigation = { ok: true, data: { tabId: 'tab-1', url: 'https://console.example.test/keys' } };
const successfulCaptureStart = { ok: true, data: {} };

function commandForNavigationAndCapture(command: string) {
  if (command === 'navigate') return successfulNavigation;
  if (command === 'network-capture-start') return successfulCaptureStart;
  throw new Error(`Unexpected extension command in smoke test: ${command}`);
}

describe('auto-create strategy dependency wiring', () => {
  it('creates a Cloudflare token through its injected HTTPS transport', async () => {
    let writtenBody = '';
    const request = vi.fn((options: Record<string, unknown>, onResponse: (response: EventEmitter) => void) => {
      const requestStream = new EventEmitter() as EventEmitter & { write: (body: string) => void; end: () => void };
      requestStream.write = (chunk: string) => { writtenBody += chunk; };
      requestStream.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 200;
        onResponse(response);
        response.emit('data', JSON.stringify({ success: true, result: { id: 'token-id', name: 'qa-token', value: 'created-token' } }));
        response.emit('end');
      };
      expect(options).toMatchObject({
        hostname: 'api.cloudflare.com', path: '/client/v4/user/tokens', method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer parent-token' }),
      });
      return requestStream;
    });
    const { createCloudflareToken } = createCloudflareKeyService({ https: { request } });

    await expect(createCloudflareToken({ parentToken: 'parent-token', tokenName: 'qa-token' }))
      .resolves.toEqual({ id: 'token-id', name: 'qa-token', value: 'created-token' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writtenBody)).toMatchObject({ name: 'qa-token' });
  });

  it('drives Zhipu to its first safe create action through the injected click helper', async () => {
    const clickCreateAction = vi.fn(async () => ({ error: 'create-not-found', buttons: [] }));
    const { createZhipuKey } = createZhipuStrategy({
      sendCommand: commandForNavigationAndCapture,
      execJs: async () => 'dismissed',
      sleep: asyncNoop,
      closeAutomationWindow: asyncNoop,
      detectInteractiveVerification: async () => false,
      waitForInteractiveVerification: asyncNoop,
      isValidZhipuApiKey: () => false,
      extractKeyFromCaptures: () => null,
      ZHIPU_URL: 'https://console.example.test/zhipu',
      ZHIPU_CREATE_TEXTS: ['Create API Key'],
      ZHIPU_CONFIRM_TEXTS: ['Create'],
      ZHIPU_NAME_SELECTORS: 'input[name="name"]',
      resolveActionCandidate: () => null,
      scoreActionCandidate: () => 0,
      descriptorFingerprint: () => '',
      clickCreateAction,
    });

    await expect(createZhipuKey({ tokenName: 'qa-key' })).rejects.toThrow('创建按钮未找到');
    expect(clickCreateAction).toHaveBeenCalledTimes(15);
    expect(clickCreateAction).toHaveBeenCalledWith({ createTexts: ['Create API Key'] });
  });

  it('drives OpenRouter through its injected login handoff and public-page redirect before failing closed', async () => {
    const handoffOpenRouterLoginIfNeeded = vi.fn(async () => undefined);
    const hasOpenRouterPublicNavigation = vi.fn(() => true);
    const redirectOpenRouterToLogin = vi.fn(async () => undefined);
    const clickCreateAction = vi.fn(async () => ({
      error: 'create-not-found',
      buttons: ['Skip to content', 'Home', 'Models', 'Fusion', 'Chat'],
      workspaceKeys: false,
      keyInterface: false,
    }));
    const beginGenericBrowserCreate = createGenericNavigationStrategy({
      sendCommand: commandForNavigationAndCapture,
      sleep: asyncNoop,
      extractNewestNamedKeyFromCaptures: () => null,
      capturesContainMistralKeyRecords: () => false,
      closeAutomationWindow: asyncNoop,
      execJs: async () => 'dismissed',
      isLoginUrl: () => false,
      detectLoginRequired: async () => ({ loginRequired: false }),
      detectInteractiveVerification: async () => false,
      waitForInteractiveVerification: asyncNoop,
      waitForSecurityVerificationToClear: asyncNoop,
      recoverLatestZaiGlobalKey: asyncNoop,
      clickCreateAction,
      keyFromText: () => null,
      extractKeyFromCaptures: () => null,
      foregroundClick: async () => false,
      XIAOMI_ICON_CLASSIFY_JS: '() => "unknown"',
      handoffOpenRouterLoginIfNeeded,
      hasOpenRouterPublicNavigation,
      redirectOpenRouterToLogin,
    });

    await expect(beginGenericBrowserCreate({
      tokenName: 'qa-key',
      platform: { id: 'openrouter', url: 'https://console.example.test/openrouter' },
    })).rejects.toThrow('OpenRouter login required');
    expect(handoffOpenRouterLoginIfNeeded).toHaveBeenCalledTimes(1);
    expect(hasOpenRouterPublicNavigation).toHaveBeenCalledWith(['Skip to content', 'Home', 'Models', 'Fusion', 'Chat']);
    expect(redirectOpenRouterToLogin).toHaveBeenCalledTimes(1);
  });

  it('drives a normal generic provider to the injected create action without a browser', async () => {
    const clickCreateAction = vi.fn(async () => ({ error: 'create-not-found', buttons: ['No create action'] }));
    const beginGenericBrowserCreate = createGenericNavigationStrategy({
      sendCommand: commandForNavigationAndCapture,
      sleep: asyncNoop,
      extractNewestNamedKeyFromCaptures: () => null,
      capturesContainMistralKeyRecords: () => false,
      closeAutomationWindow: asyncNoop,
      execJs: async () => 'dismissed',
      isLoginUrl: () => false,
      detectLoginRequired: async () => ({ loginRequired: false }),
      detectInteractiveVerification: async () => false,
      waitForInteractiveVerification: asyncNoop,
      waitForSecurityVerificationToClear: asyncNoop,
      recoverLatestZaiGlobalKey: asyncNoop,
      clickCreateAction,
      keyFromText: () => null,
      extractKeyFromCaptures: () => null,
      foregroundClick: async () => false,
      XIAOMI_ICON_CLASSIFY_JS: '() => "unknown"',
      handoffOpenRouterLoginIfNeeded: asyncNoop,
      hasOpenRouterPublicNavigation: () => false,
      redirectOpenRouterToLogin: asyncNoop,
    });

    await expect(beginGenericBrowserCreate({
      tokenName: 'qa-key',
      platform: { id: 'deepseek', url: 'https://console.example.test/deepseek' },
    })).rejects.toThrow('未找到创建密钥按钮');
    expect(clickCreateAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'deepseek' }));
  });

  it('drives Volcengine through the injected public-shell login probe before any create operation', async () => {
    const detectVolcengineLoginSurface = vi.fn(async () => true);
    const { createVolcengineKey } = createVolcengineMinimaxStrategy({
      sendCommand: commandForNavigationAndCapture,
      execJs: asyncNoop,
      sleep: asyncNoop,
      closeAutomationWindow: asyncNoop,
      foregroundClick: async () => false,
      detectLoginRequired: async () => ({ loginRequired: false }),
      detectInteractiveVerification: async () => false,
      waitForInteractiveVerification: asyncNoop,
      isAssetData: () => false,
      extractKeyFromCaptures: () => null,
      describeCapturedResponses: () => [],
      describeCapturedSecretFields: () => [],
      describeMinimaxBackendResults: () => [],
      VOLC_URL: 'https://console.example.test/volcengine',
      VOLC_AGENT_PLAN_URL: 'https://console.example.test/volcengine/agent-plan',
      VOLC_CREATE_TEXTS: ['Create API Key'],
      MINIMAX_URL: 'https://console.example.test/minimax',
      MINIMAX_CREATE_TEXTS: ['Create API Key'],
      detectVolcengineLoginSurface,
    });

    await expect(createVolcengineKey({ tokenName: 'qa-key' })).rejects.toThrow('需要登录火山引擎');
    expect(detectVolcengineLoginSurface).toHaveBeenCalledTimes(1);
  });

  it('drives MiniMax through its injected navigation/capture dependencies before the first form action', async () => {
    const calls: string[] = [];
    const { createMinimaxKey } = createVolcengineMinimaxStrategy({
      sendCommand: async (command: string) => {
        calls.push(command);
        if (command === 'navigate') return successfulNavigation;
        if (command === 'network-capture-start') return successfulCaptureStart;
        throw new Error(`stop after first MiniMax form action: ${command}`);
      },
      execJs: async () => { throw new Error('stop after first MiniMax form action'); },
      sleep: asyncNoop,
      closeAutomationWindow: asyncNoop,
      foregroundClick: async () => false,
      detectLoginRequired: async () => ({ loginRequired: false }),
      detectInteractiveVerification: async () => false,
      waitForInteractiveVerification: asyncNoop,
      isAssetData: () => false,
      extractKeyFromCaptures: () => null,
      describeCapturedResponses: () => [],
      describeCapturedSecretFields: () => [],
      describeMinimaxBackendResults: () => [],
      VOLC_URL: 'https://console.example.test/volcengine',
      VOLC_AGENT_PLAN_URL: 'https://console.example.test/volcengine/agent-plan',
      VOLC_CREATE_TEXTS: ['Create API Key'],
      MINIMAX_URL: 'https://console.example.test/minimax',
      MINIMAX_CREATE_TEXTS: ['Create API Key'],
      detectVolcengineLoginSurface: async () => false,
    });

    await expect(createMinimaxKey({ tokenName: 'qa-key' })).rejects.toThrow('stop after first MiniMax form action');
    expect(calls).toEqual(['navigate', 'network-capture-start']);
  });

  it('uses the injected browser platform URL resolver before navigation', async () => {
    const getBrowserPlatformUrl = vi.fn(() => 'https://console.example.test/delete');
    const isLoginUrl = vi.fn(() => true);
    const { deleteCreatedBrowserKey } = createBrowserDeleteStrategy({
      sendCommand: commandForNavigationAndCapture,
      execJs: asyncNoop,
      sleep: asyncNoop,
      closeAutomationWindow: asyncNoop,
      foregroundClick: async () => false,
      waitForInteractiveVerification: asyncNoop,
      waitForSecurityVerificationToClear: asyncNoop,
      deleteAnthropicBrowserKey: asyncNoop,
      deleteZhipuBrowserKey: asyncNoop,
      deleteMoonshotBrowserKey: asyncNoop,
      getBrowserPlatformUrl,
      isLoginUrl,
    });

    await expect(deleteCreatedBrowserKey({ platform: { id: 'generic', label: 'Generic' }, createdName: 'qa-key' }))
      .rejects.toThrow('Generic 删除前需要登录');
    expect(getBrowserPlatformUrl).toHaveBeenCalledWith(expect.objectContaining({ id: 'generic' }));
    expect(isLoginUrl).toHaveBeenCalledWith('https://console.example.test/keys');
  });

  it('uses the injected login URL predicate when a browser deletion has an explicit URL', async () => {
    const isLoginUrl = vi.fn(() => true);
    const { deleteCreatedBrowserKey } = createBrowserDeleteStrategy({
      sendCommand: commandForNavigationAndCapture,
      execJs: asyncNoop,
      sleep: asyncNoop,
      closeAutomationWindow: asyncNoop,
      foregroundClick: async () => false,
      waitForInteractiveVerification: asyncNoop,
      waitForSecurityVerificationToClear: asyncNoop,
      deleteAnthropicBrowserKey: asyncNoop,
      deleteZhipuBrowserKey: asyncNoop,
      deleteMoonshotBrowserKey: asyncNoop,
      getBrowserPlatformUrl: () => { throw new Error('explicit deleteUrl must bypass resolver'); },
      isLoginUrl,
    });

    await expect(deleteCreatedBrowserKey({
      platform: { id: 'generic', label: 'Generic', deleteUrl: 'https://console.example.test/delete' },
      createdName: 'qa-key',
    })).rejects.toThrow('Generic 删除前需要登录');
    expect(isLoginUrl).toHaveBeenCalledWith('https://console.example.test/keys');
  });
});
