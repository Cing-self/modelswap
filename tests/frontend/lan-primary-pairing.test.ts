import { describe, expect, it, vi } from 'vitest';
import { createPrimaryPairing, enableAndCreatePrimaryPairing } from '../../src/web/frontend/src/lib/lanPrimaryPairing';

describe('createPrimaryPairing', () => {
  it('returns a non-empty session only after the listener is ready', async () => {
    const create = vi.fn().mockResolvedValue({
      success: true,
      expiresAt: '2026-08-28T12:00:00.000Z',
      codes: [{ address: '192.168.1.8', code: 'okit-lan://192.168.1.8:3790/example' }],
    });

    await expect(createPrimaryPairing({ running: true }, create)).resolves.toMatchObject({ codes: [{ address: '192.168.1.8' }] });
    expect(create).toHaveBeenCalledOnce();
  });

  it('surfaces listener and empty-code failures instead of silently completing', async () => {
    const create = vi.fn();
    await expect(createPrimaryPairing({ running: false, error: '端口不可用' }, create)).rejects.toThrow('端口不可用');
    expect(create).not.toHaveBeenCalled();
    await expect(createPrimaryPairing({ running: true }, vi.fn().mockResolvedValue({ success: true, expiresAt: '2026-08-28T12:00:00.000Z', codes: [] })))
      .rejects.toThrow('未生成可用配对码');
  });
});

describe('enableAndCreatePrimaryPairing', () => {
  const session = {
    success: true,
    expiresAt: '2026-08-28T12:00:00.000Z',
    codes: [{ address: '192.168.1.8', code: 'okit-lan://192.168.1.8:3790/example' }],
  };

  it('covers the first-device modal path in order: save password, enable, then show a generated code', async () => {
    const events: string[] = [];
    const result = await enableAndCreatePrimaryPairing({
      needsPasswordSave: true,
      savePassword: vi.fn(async () => { events.push('save'); return true; }),
      enableListener: vi.fn(async () => { events.push('enable'); return { running: true }; }),
      createPairing: vi.fn(async () => { events.push('create'); return session; }),
    });

    expect(events).toEqual(['save', 'enable', 'create']);
    expect(result).toEqual(session);
  });

  it('does not enable or create a code after a failed password save', async () => {
    const enableListener = vi.fn();
    const createPairing = vi.fn();
    await expect(enableAndCreatePrimaryPairing({
      needsPasswordSave: true,
      savePassword: vi.fn().mockResolvedValue(false),
      enableListener,
      createPairing,
    })).resolves.toBeNull();
    expect(enableListener).not.toHaveBeenCalled();
    expect(createPairing).not.toHaveBeenCalled();
  });

  it('bubbles listener and empty-code failures to the modal', async () => {
    await expect(enableAndCreatePrimaryPairing({
      needsPasswordSave: false,
      savePassword: vi.fn(),
      enableListener: vi.fn().mockResolvedValue({ running: false, error: '端口不可用' }),
      createPairing: vi.fn(),
    })).rejects.toThrow('端口不可用');

    await expect(enableAndCreatePrimaryPairing({
      needsPasswordSave: false,
      savePassword: vi.fn(),
      enableListener: vi.fn().mockResolvedValue({ running: true }),
      createPairing: vi.fn().mockResolvedValue({ ...session, codes: [] }),
    })).rejects.toThrow('未生成可用配对码');
  });
});
