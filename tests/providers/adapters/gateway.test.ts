import { describe, it, expect } from 'vitest';
import {
  OPENCODE_GATEWAY_UA,
  OPENCODE_FREE_MODEL_LIMITS,
  OPENROUTER_FREE_MODEL_LIMITS,
  isOpenCodeGateway,
  isOpenRouter,
  gatewayHeadersFor,
  modelLimitFor,
} from '../../../src/providers/adapters/gateway';

describe('gateway helpers', () => {
  it('detects opencode.ai host regardless of path/port', () => {
    expect(isOpenCodeGateway('https://opencode.ai/zen/v1')).toBe(true);
    expect(isOpenCodeGateway('https://opencode.ai')).toBe(true);
    expect(isOpenCodeGateway('https://api.deepseek.com')).toBe(false);
    expect(isOpenCodeGateway('not-a-url')).toBe(false);
  });

  it('detects openrouter.ai host', () => {
    expect(isOpenRouter('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouter('https://opencode.ai/zen/v1')).toBe(false);
  });

  it('returns opencode UA headers only for opencode.ai', () => {
    expect(gatewayHeadersFor('https://opencode.ai/zen/v1')).toEqual({ 'User-Agent': OPENCODE_GATEWAY_UA });
    expect(gatewayHeadersFor('https://openrouter.ai/api/v1')).toBeUndefined();
    expect(gatewayHeadersFor('https://api.deepseek.com')).toBeUndefined();
  });

  it('resolves zen limits for opencode.ai free models', () => {
    expect(modelLimitFor('https://opencode.ai/zen/v1', 'deepseek-v4-flash-free'))
      .toEqual(OPENCODE_FREE_MODEL_LIMITS['deepseek-v4-flash-free']);
    expect(modelLimitFor('https://opencode.ai/zen/v1', 'unknown-model')).toBeUndefined();
  });

  it('resolves openrouter :free limits', () => {
    expect(modelLimitFor('https://openrouter.ai/api/v1', 'cohere/north-mini-code:free'))
      .toEqual(OPENROUTER_FREE_MODEL_LIMITS['cohere/north-mini-code:free']);
    expect(modelLimitFor('https://openrouter.ai/api/v1', 'deepseek-v4-flash-free')).toBeUndefined();
  });

  it('returns no limits for non-gateway endpoints', () => {
    expect(modelLimitFor('https://api.deepseek.com', 'deepseek-v4-flash-free')).toBeUndefined();
  });
});