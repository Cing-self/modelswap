import { describe, expect, it, vi } from 'vitest';

const { createBrowserOrchestrator } = require('../src/web/api/auto-create-browser-orchestrator.js');

describe('browser create orchestrator', () => {
  it('returns the successful two-phase create result to every platform strategy', async () => {
    const approved = { index: 0, text: 'Create API Key', ariaLabel: '', title: '' };
    const execJs = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        descriptors: [approved],
        buttons: ['Create API Key'],
        workspaceKeys: true,
        keyInterface: true,
      }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, text: 'Create API Key' }));
    const orchestrator = createBrowserOrchestrator({
      AUTO_CREATE_PLATFORM_MAP: new Map(),
      VOLC_AGENT_PLAN_URL: '',
      createZhipuKey: vi.fn(),
      createVolcengineKey: vi.fn(),
      createMinimaxKey: vi.fn(),
      beginGenericBrowserCreate: vi.fn(),
      submitGenericBrowserCreate: vi.fn(),
      readGenericBrowserCreateResult: vi.fn(),
      execJs,
      resolveActionCandidate: vi.fn(() => approved),
      scoreActionCandidate: vi.fn(),
      descriptorFingerprint: vi.fn(() => 'create api key||'),
      sendCommand: vi.fn(),
      sleep: vi.fn(),
      keyFromText: vi.fn(),
      extractKeyFromCaptures: vi.fn(),
      describeCapturedResponses: vi.fn(),
      describeCapturedSecretFields: vi.fn(),
      closeAutomationWindow: vi.fn(),
      isAssetData: vi.fn(),
    });

    await expect(orchestrator.clickCreateAction({ createTexts: ['Create API Key'] }))
      .resolves.toEqual({ ok: true, text: 'Create API Key' });
  });
});
