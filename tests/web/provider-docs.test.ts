import { describe, expect, it } from 'vitest';
import { PRESET_PROVIDERS } from '../../src/providers/presets';
import { buildPlatforms } from '../../src/providers/platforms';
import {
  getProviderDocs,
  PROVIDER_DOCS,
  PROVIDER_DOCS_LAST_AUDITED_AT,
} from '../../src/web/frontend/src/data/providerDocs';

describe('provider documentation', () => {
  it('has one audited official documentation entry for every bundled offering', () => {
    const presetIds = PRESET_PROVIDERS.map(provider => provider.id).sort();
    expect(Object.keys(PROVIDER_DOCS).sort()).toEqual(presetIds);
    expect(PROVIDER_DOCS_LAST_AUDITED_AT).toBe('2026-08-14');
  });

  it('uses the selected offering type rather than a generic platform document', () => {
    const providers = PRESET_PROVIDERS.map(provider => ({ ...provider }));
    const offerings = buildPlatforms(providers).flatMap(platform => platform.offerings);

    for (const offering of offerings) {
      const docs = getProviderDocs(offering.providerId);
      expect(docs, offering.providerId).not.toBeNull();
      if (docs?.kind === 'local') continue;
      // OpenCode Go is a coding subscription in product filters, while its
      // official documentation keeps the branded Go plan name.
      if (offering.providerId === 'opencode-go') {
        expect(offering.type).toBe('go_plan');
        expect(docs?.kind).toBe('go_plan');
        continue;
      }
      if (offering.type === 'api') expect(docs?.kind, offering.providerId).toBe('api');
      if (offering.type === 'coding_plan') expect(docs?.kind, offering.providerId).toBe('coding_plan');
      if (offering.type === 'token_plan') expect(docs?.kind, offering.providerId).toBe('token_plan');
      if (offering.type === 'agent_plan') expect(docs?.kind, offering.providerId).toBe('agent_plan');
      if (offering.type === 'agent_subscription') expect(docs?.kind, offering.providerId).toBe('agent_subscription');
      if (offering.type === 'go_plan') expect(docs?.kind, offering.providerId).toBe('go_plan');
    }
  });

  it('only links to secure external documentation', () => {
    for (const [providerId, docs] of Object.entries(PROVIDER_DOCS)) {
      expect(docs.url, providerId).toMatch(/^https:\/\//);
    }
  });
});
