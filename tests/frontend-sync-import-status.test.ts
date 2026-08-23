import { describe, expect, it } from 'vitest';
import { getSyncImportStatus } from '../src/web/frontend/src/lib/syncImportStatus';

const t = (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params || {})}`;

describe('getSyncImportStatus', () => {
  it('returns visible feedback for sync file import lifecycle', () => {
    expect(getSyncImportStatus({ phase: 'importing', filename: 'okit-sync.json' }, t)).toEqual({
      tone: 'loading',
      message: 'settings.syncFileImporting:{"filename":"okit-sync.json"}',
    });

    expect(getSyncImportStatus({ phase: 'success', platform: 'Cloudflare', secrets: 2 }, t)).toEqual({
      tone: 'success',
      message: 'settings.syncFileImported:{"platform":"Cloudflare","n":2}',
    });

    expect(getSyncImportStatus({ phase: 'error', error: '同步密码不正确' }, t)).toEqual({
      tone: 'error',
      message: '同步密码不正确',
    });
  });
});
