import { describe, it, expect } from 'vitest';
import {
  issueExtensionToken,
  consumeExtensionToken,
  isExtensionOrigin,
} from '../../src/web/api/ws-extension.js';

describe('ws-extension auth gate', () => {
  it('only accepts browser-extension origins', () => {
    expect(isExtensionOrigin('chrome-extension://abcdef123456')).toBe(true);
    expect(isExtensionOrigin('moz-extension://1234abcd-5678')).toBe(true);
    // The attack surface the gate exists for: ordinary web pages.
    expect(isExtensionOrigin('http://localhost:3780')).toBe(false);
    expect(isExtensionOrigin('https://evil.example.com')).toBe(false);
    expect(isExtensionOrigin('null')).toBe(false);
    expect(isExtensionOrigin(undefined)).toBe(false);
    expect(isExtensionOrigin('')).toBe(false);
  });

  it('issues 256-bit tokens', () => {
    const token = issueExtensionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tokens are single-use: a second consume fails', () => {
    const token = issueExtensionToken();
    expect(consumeExtensionToken(token)).toBe(true);
    expect(consumeExtensionToken(token)).toBe(false);
  });

  it('unknown tokens are rejected without side effects', () => {
    expect(consumeExtensionToken('deadbeef')).toBe(false);
    const token = issueExtensionToken();
    expect(consumeExtensionToken('deadbeef')).toBe(false);
    expect(consumeExtensionToken(token)).toBe(true);
  });

  it('expired tokens are rejected', () => {
    const token = issueExtensionToken(-1); // already expired
    expect(consumeExtensionToken(token)).toBe(false);
  });
});
