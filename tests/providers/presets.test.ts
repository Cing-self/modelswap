import { describe, it, expect } from 'vitest';
import { PRESET_PROVIDERS } from '../../src/providers/presets';

describe('PRESET_PROVIDERS', () => {
  it('has at least 6 presets', () => {
    expect(PRESET_PROVIDERS.length).toBeGreaterThanOrEqual(20);
  });

  it('includes anthropic preset', () => {
    const p = PRESET_PROVIDERS.find(p => p.id === 'anthropic');
    expect(p).toBeDefined();
    expect(p!.name).toBe('Anthropic');
    expect(p!.type).toBe('anthropic');
    expect(p!.baseUrl).toBe('https://api.anthropic.com');
    expect(p!.models.length).toBeGreaterThan(0);
  });

  it('includes openai preset', () => {
    const p = PRESET_PROVIDERS.find(p => p.id === 'openai');
    expect(p).toBeDefined();
    expect(p!.type).toBe('openai');
  });

  it('each preset has valid fields', () => {
    for (const p of PRESET_PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.type).toMatch(/^(anthropic|openai)$/);
      expect(p.baseUrl).toBeTruthy();
      expect(Array.isArray(p.models)).toBe(true);
      for (const m of p.models) {
        expect(m.id).toBeTruthy();
      }
    }
  });
});
