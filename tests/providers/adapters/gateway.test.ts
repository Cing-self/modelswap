import { describe, it, expect } from 'vitest';
import {
  OPENCODE_GATEWAY_UA,
  isOpenCodeGateway,
  isOpenRouter,
  gatewayHeadersFor,
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
});
