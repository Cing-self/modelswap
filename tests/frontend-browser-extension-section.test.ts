// The frontend owns React under src/web/frontend; root Vitest intentionally
// has no duplicate React dependency.
import React from '../src/web/frontend/node_modules/react/index.js';
import { renderToStaticMarkup } from '../src/web/frontend/node_modules/react-dom/server.node.js';
import { describe, expect, it } from 'vitest';
import en from '../src/web/frontend/src/i18n/en';
import {
  ExtensionConnectionCard,
  shouldCollapseExtensionInstallSteps,
  type ExtensionConnectionState,
} from '../src/web/frontend/src/components/settings/BrowserExtensionSection';

const t = (key: string) => (en as Record<string, string>)[key] || key;

function renderCard(state: ExtensionConnectionState, installStepsExpanded = false) {
  return renderToStaticMarkup(React.createElement(ExtensionConnectionCard, {
    state,
    detail: { version: '2.4.0', protocol: 'bridge-v3' },
    installStepsExpanded,
    onRefresh: () => {},
    onReveal: () => {},
    onToggleInstallSteps: () => {},
    t,
  }));
}

describe('BrowserExtensionSection connection/install hierarchy', () => {
  it('renders connected facts and maintenance actions without installation details', () => {
    const markup = renderCard('connected');
    expect(markup).toContain('Connected');
    expect(markup).toContain('v2.4.0');
    expect(markup).toContain('bridge-v3');
    expect(markup).toContain('Refresh connection status');
    expect(markup).toContain('Open extension folder');
    expect(markup).toContain('settings-extension-reveal-button');
    expect(markup).not.toContain('chrome://extensions');
    expect(markup).not.toContain('~/.modelswap/extension');
    expect(markup).not.toContain('View installation steps');
  });

  it('keeps disconnected installation details folded until the disclosure is expanded', () => {
    const folded = renderCard('disconnected');
    expect(folded).toContain('Not connected');
    expect(folded).toContain('Automatic key creation and browser sign-in usage queries are unavailable.');
    expect(folded).toContain('settings-system-download');
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain('chrome://extensions');

    const expanded = renderCard('disconnected', true);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('chrome://extensions');
    expect(expanded).toContain('~/.modelswap/extension');
    expect(expanded).toContain('class="settings-extension-code"');
  });

  it('keeps recovery actions available when status cannot be confirmed and closes details on connection', () => {
    const unavailable = renderCard('unavailable');
    expect(unavailable).toContain('Unable to confirm connection status right now');
    expect(unavailable).toContain('Refresh connection status');
    expect(unavailable).toContain('Open extension folder');
    expect(unavailable).not.toContain('Not connected');
    expect(unavailable).not.toContain('disabled');

    expect(shouldCollapseExtensionInstallSteps('connected')).toBe(true);
    expect(shouldCollapseExtensionInstallSteps('disconnected')).toBe(false);
    expect(shouldCollapseExtensionInstallSteps('unavailable')).toBe(false);
  });
});
