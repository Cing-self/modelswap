import { describe, it, expect } from 'vitest';

// Google's Generative Language API returns resource names ("models/…") even on
// its OpenAI-compatible directory. The bare id is canonical everywhere else,
// so both import normalization and selection healing must strip exactly that
// prefix — and never a route separator used by other providers.
const { createProviderStatusService } = require('../../src/application/provider-status-service');
const { normalizeAgentModelSelectionNamespaces } = require('../../src/web/api/agent-providers');

const service = createProviderStatusService({});

describe('normalizeRemoteModel Google namespace', () => {
  it('strips the "models/" prefix from ids', () => {
    const model = service.normalizeRemoteModel({ id: 'models/gemini-2.5-flash', name: 'Gemini 2.5 Flash' });
    expect(model.id).toBe('gemini-2.5-flash');
    expect(model.name).toBe('Gemini 2.5 Flash');
  });

  it('falls back to the healed id for the display name', () => {
    const model = service.normalizeRemoteModel({ id: 'models/gemma-4-26b-it' });
    expect(model.id).toBe('gemma-4-26b-it');
    expect(model.name).toBe('gemma-4-26b-it');
  });

  it('keeps route-shaped ids from other providers intact', () => {
    expect(service.normalizeRemoteModel({ id: 'anthropic/claude-sonnet-4' }).id).toBe('anthropic/claude-sonnet-4');
    expect(service.normalizeRemoteModel({ id: 'deepseek/model:free' }).id).toBe('deepseek/model:free');
    expect(service.normalizeRemoteModel({ id: 'gemini-3.8-flash' }).id).toBe('gemini-3.8-flash');
  });
});

describe('agent-providers namespace healing (CJS twin)', () => {
  it('heals prefixed selections and overrides, reports change once', () => {
    const config: any = {
      agentProviders: {
        zcode: {
          activeProviderId: 'google',
          activeModelId: 'models/gemini-3.8-flash',
          sites: { google: { modelIds: ['models/gemini-3.8-flash'], enabled: true } },
        },
      },
      modelOverrides: { google: { 'models/gemini-3.8-flash': { alias: 'flash' } } },
    };

    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(true);
    expect(config.agentProviders.zcode.activeModelId).toBe('gemini-3.8-flash');
    expect(config.agentProviders.zcode.sites.google.modelIds).toEqual(['gemini-3.8-flash']);
    expect(Object.keys(config.modelOverrides.google)).toEqual(['gemini-3.8-flash']);
    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(false);
  });

  it('ignores non-object configs and leaves clean states untouched', () => {
    expect(normalizeAgentModelSelectionNamespaces(null)).toBe(false);
    const config: any = { agentProviders: { codex: { sites: { openrouter: { modelIds: ['x-ai/grok-5'] } } } } };
    expect(normalizeAgentModelSelectionNamespaces(config)).toBe(false);
    expect(config.agentProviders.codex.sites.openrouter.modelIds).toEqual(['x-ai/grok-5']);
  });
});
