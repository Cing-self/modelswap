import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// Behavior of the diagnostics update entry (QA: settings keeps ONLY the
// explicit check action; details/download/install live in the titlebar).
import {
  performSettingsUpdateCheck,
  UpdateCheckButton,
  UpdateDetailsProvider,
} from '../../src/web/frontend/src/components/update/UpdateDetails';
import { AppProvider } from '../../src/web/frontend/src/components/Layout/AppContext';
import { I18nProvider } from '../../src/web/frontend/src/i18n';
import type { UpdateState } from '../../src/web/frontend/src/hooks/useAppUpdate';

describe('diagnostics update entry: explicit check orchestration', () => {
  it('performs an EXPLICIT check (silent=false) exactly once', async () => {
    const check = vi.fn(async () => ({ status: 'upToDate' } as UpdateState));
    const notify = vi.fn();
    await performSettingsUpdateCheck(check as any, notify);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(false);
  });

  it('reports upToDate feedback without opening anything', async () => {
    const notify = vi.fn();
    await performSettingsUpdateCheck(vi.fn(async () => ({ status: 'upToDate' } as UpdateState)) as any, notify);
    expect(notify).toHaveBeenCalledWith({ kind: 'upToDate' });
  });

  it('reports a found version — the titlebar indicator owns everything after this', async () => {
    const notify = vi.fn();
    const check = vi.fn(async () => ({
      status: 'available', latest: 'v1.0.38',
    } as unknown as UpdateState));
    await performSettingsUpdateCheck(check as any, notify);
    expect(notify).toHaveBeenCalledWith({ kind: 'found', version: 'v1.0.38' });
  });

  it('surfaces an error for a failed explicit check', async () => {
    const notify = vi.fn();
    const check = vi.fn(async () => ({ status: 'error', error: 'HTTP 502' } as UpdateState));
    await performSettingsUpdateCheck(check as any, notify);
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: 'HTTP 502' });
  });
});

describe('diagnostics update entry: rendered UI', () => {
  // The frontend's React lives in src/web/frontend/node_modules; resolve
  // from there instead of the repository root.
  const requireFromFrontend = createRequire(
    path.join(__dirname, '../../src/web/frontend/src/placeholder.js'),
  );

  beforeAll(() => {
    const g = globalThis as any;
    // Minimal browser-API provisioning for server rendering (the component
    // tree itself is the real, unmocked implementation).
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    g.window = globalThis;
    g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} });
  });

  const renderEntry = () => {
    const React = requireFromFrontend('react');
    const { renderToString } = requireFromFrontend('react-dom/server');
    return renderToString(
      React.createElement(AppProvider, null,
        React.createElement(I18nProvider, null,
          React.createElement(UpdateDetailsProvider, null,
            React.createElement(UpdateCheckButton)))));
  };

  it('renders the explicit check button with the refresh icon and label', () => {
    const html = renderEntry();
    expect(html).toContain('settings-system-download');
    expect(html).toContain('lucide-refresh-cw');
    expect(html).toContain('检查更新');
  });

  it('renders NO details entry, download icon, or details-sheet affordance', () => {
    const html = renderEntry();
    expect(html).not.toContain('查看更新详情');
    expect(html).not.toContain('lucide-arrow-down-to-line');
    expect(html).not.toContain('update-details-sheet');
  });

  it('keeps the titlebar preview non-modal and no longer exports the old entry', async () => {
    const mod = await import('../../src/web/frontend/src/components/update/UpdateDetails');
    expect((mod as any).UpdateDetailsEntry).toBeUndefined();
    expect((mod as any).UpdateDetailsSheet).toBeUndefined();
    expect(typeof mod.UpdateCheckButton).toBe('function');
    expect(typeof mod.UpdateHoverCard).toBe('function');
  });
});
