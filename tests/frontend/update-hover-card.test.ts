import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

// v1.0.58 update-card polish: the card header carries no decorative status
// icon, category labels render as section headings, and the titlebar button
// exposes no native title tooltip (the duplicate "new version" notice).
vi.mock('../../src/web/frontend/src/hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({
    update: {
      status: 'available',
      latest: '1.0.58',
      publishedAt: '2026-09-03T00:00:00.000Z',
      releaseNotes: {
        version: 'v1.0.58',
        publishedAt: '2026-09-03T00:00:00.000Z',
        summary: { zh: '更新体验优化。', en: 'A cleaner update experience.' },
        highlights: [
          { category: 'improved', zh: '更新弹框排版优化。', en: 'Cleaner card layout.' },
          { category: 'fixed', zh: '修复重复弹出提示。', en: 'Fixed duplicate notices.' },
        ],
      },
    },
    download: null,
    downloading: false,
    downloadProgress: null,
    restarting: false,
    check: vi.fn(async () => ({ status: 'available' })),
    startDownload: vi.fn(),
    restart: vi.fn(),
  }),
}));

import { UpdateDetailsProvider, UpdateHoverCard } from '../../src/web/frontend/src/components/update/UpdateDetails';
import { AppProvider } from '../../src/web/frontend/src/components/Layout/AppContext';
import { I18nProvider } from '../../src/web/frontend/src/i18n';

describe('update hover card layout (v1.0.58 polish)', () => {
  // The frontend's React lives in src/web/frontend/node_modules; resolve
  // from there instead of the repository root.
  const requireFromFrontend = createRequire(
    path.join(__dirname, '../../src/web/frontend/src/placeholder.js'),
  );

  beforeAll(() => {
    const g = globalThis as any;
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    g.window = globalThis;
    g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} });
  });

  const renderCard = () => {
    const React = requireFromFrontend('react');
    const { renderToString } = requireFromFrontend('react-dom/server');
    return renderToString(
      React.createElement(AppProvider, null,
        React.createElement(I18nProvider, null,
          React.createElement(UpdateDetailsProvider, null,
            React.createElement(UpdateHoverCard, { visible: true })))));
  };

  it('renders the header without the decorative download status icon', () => {
    const html = renderCard();
    expect(html).toContain('update-hover-card-header');
    expect(html).not.toContain('update-hover-card-status-icon');
    expect(html).not.toContain('lucide-arrow-down-to-line');
  });

  it('renders each category as a section heading with its accent-bar style', () => {
    const html = renderCard();
    expect(html).toContain('update-hover-card-group');
    expect(html).toMatch(/<h3>[^<]*(改进|Improved)/);
    expect(html).toMatch(/<h3>[^<]*(修复|Fixed)/);
    expect(html).toContain('更新弹框排版优化。');
  });

  it('shows the plain-language summary from the release notes', () => {
    const html = renderCard();
    expect(html).toContain('更新体验优化。');
    expect(html).toContain('1.0.58');
  });
});

describe('titlebar update button tooltip guard', () => {
  // The native title tooltip duplicated the hover card's "new version"
  // notice after the card opened (user report, v1.0.58). aria-label keeps
  // the button accessible; a title= attribute must not come back.
  it('exposes aria-label but no native title attribute', async () => {
    const source = await fs.promises.readFile(
      path.join(__dirname, '../../src/web/frontend/src/App.tsx'), 'utf8');
    expect(source).toContain('aria-label={title}');
    expect(source).not.toMatch(/title=\{title\}/);
  });
});
