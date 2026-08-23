import { describe, it, expect, afterEach } from 'vitest';

const origPlatform = process.platform;
const origShell = process.env.SHELL;

// Import after setting up environment
const { detectShell } = await import('../../src/commands/hook');

describe('detectShell', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    if (origShell !== undefined) process.env.SHELL = origShell;
    else delete process.env.SHELL;
  });

  it('detects zsh from SHELL env', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.SHELL = '/bin/zsh';
    expect(detectShell()).toBe('zsh');
  });

  it('detects bash from SHELL env', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.SHELL = '/bin/bash';
    expect(detectShell()).toBe('bash');
  });

  it('defaults to bash when SHELL is empty', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.SHELL = '';
    expect(detectShell()).toBe('bash');
  });

  it('returns powershell on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(detectShell()).toBe('powershell');
  });
});
