import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

import { filterGroupEntries } from '../../src/web/frontend/src/lib/groupOrdering';
import VaultPickerModal from '../../src/web/frontend/src/components/shared/VaultPickerModal';
import { I18nProvider } from '../../src/web/frontend/src/i18n';

describe('vault picker group search', () => {
  const entries: Array<[string, number[]]> = [
    ['火山方舟 Agent Plan', [1]],
    ['Cloudflare', [2, 3]],
    ['阿里云百炼', [4]],
  ];

  it('keeps every group in canonical order for an empty query', () => {
    expect(filterGroupEntries(entries, '')).toEqual(entries);
    expect(filterGroupEntries(entries, '   ')).toEqual(entries);
  });

  it('matches English and Chinese group names without changing order', () => {
    expect(filterGroupEntries(entries, 'cloud')).toEqual([['Cloudflare', [2, 3]]]);
    expect(filterGroupEntries(entries, '火山')).toEqual([['火山方舟 Agent Plan', [1]]]);
    expect(filterGroupEntries(entries, '百炼')).toEqual([['阿里云百炼', [4]]]);
  });

  it('renders the dedicated group search affordance', () => {
    const requireFromFrontend = createRequire(
      path.join(__dirname, '../../src/web/frontend/src/placeholder.js'),
    );
    const globalAny = globalThis as any;
    globalAny.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalAny.window = globalThis;
    globalAny.matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });

    const React = requireFromFrontend('react');
    const { renderToString } = requireFromFrontend('react-dom/server');
    const html = renderToString(
      React.createElement(I18nProvider, null,
        React.createElement(VaultPickerModal, { selected: '', onSelect: () => {}, onClose: () => {} })),
    );

    expect(html).toContain('vault-picker-sidebar-filter');
    expect(html).toContain('vault-picker-sidebar-search-field');
    expect(html).toContain('搜索分组...');
  });
});
