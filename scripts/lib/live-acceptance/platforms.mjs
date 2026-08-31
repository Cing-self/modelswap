// Platform catalogue for the live-acceptance tool.
//
// Single source of truth: the product registry in src/web/api/auto-create.js.
// There is deliberately NO copied platform list here — adding a platform to
// AUTO_CREATE_PLATFORMS makes it appear in this tool on the next run.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Requiring the API module pulls the same registry the web UI serves, with
// every strategy config attached (urls, createTexts, masked prefixes...).
const registry = require('../../../src/web/api/auto-create.js');

function browserUrl(platform, verificationUrls) {
  // zhipu / volcengine / volcengine-agent / minimax keep their URLs in
  // SPECIAL_PLATFORM_URLS; BROWSER_LOGIN_VERIFICATION_PLATFORMS already
  // resolves them, so reuse that mapping instead of duplicating the URLs.
  return platform.url || verificationUrls.get(platform.id) || null;
}

export function listAllPlatforms() {
  return registry.AUTO_CREATE_PLATFORMS.map((platform) => ({
    id: platform.id,
    label: platform.label,
    mode: platform.mode,
  }));
}

export function loadBrowserPlatforms() {
  const verificationUrls = new Map(
    registry.BROWSER_LOGIN_VERIFICATION_PLATFORMS.map((platform) => [platform.id, platform.url]),
  );
  return registry.AUTO_CREATE_PLATFORMS
    .filter((platform) => platform.mode === 'browser')
    .map((platform) => ({
      id: platform.id,
      label: platform.label,
      url: browserUrl(platform, verificationUrls),
      // Expected safe entries for auth-verify. These texts are looked for on
      // the page WITHOUT clicking; they are the "console is alive and its
      // create/plan entry is where we think it is" signal.
      expectedTexts: [
        ...(platform.createTexts || []),
        ...(platform.preNavigationTexts || []),
        ...(platform.formEntryTexts || []),
      ],
      maskedPrefix: platform.existingMaskedKeyPrefix || '',
      reuseOnly: Boolean(platform.reuseExistingMaskedKey),
      loginRequiredOnPublicRoot: Boolean(platform.loginRequiredOnPublicRoot),
    }))
    .filter((platform) => platform.url);
}

// zhipu's create texts live beside the strategy in the API module; they are
// already exported there, so reuse them rather than redefining the phrases.
export function extraExpectedTexts(platformId) {
  if (platformId === 'zhipu') return [...registry.ZHIPU_CREATE_TEXTS];
  return [];
}

export function loadPlatformById(platformId) {
  return registry.AUTO_CREATE_PLATFORMS.find((platform) => platform.id === platformId) || null;
}
