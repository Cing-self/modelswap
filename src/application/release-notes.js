/**
 * The reviewed release-notes contract shared by the GitHub publisher and the
 * desktop update check.  Keep this dependency-free: it runs in CI, the local
 * web server, and the packaged CommonJS runtime.
 */

const CATEGORIES = new Set(['new', 'improved', 'fixed']);

function versionTag(value) {
  const clean = String(value || '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(clean) ? `v${clean}` : null;
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateReleaseNotes(input, expectedVersion) {
  const errors = [];
  const expectedTag = expectedVersion ? versionTag(expectedVersion) : null;
  const version = versionTag(input?.version);
  if (!version) errors.push('version must be a semantic vX.Y.Z value');
  if (expectedVersion && !expectedTag) errors.push('expected version must be a semantic vX.Y.Z value');
  if (version && expectedTag && version !== expectedTag) errors.push(`version ${version} does not match ${expectedTag}`);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(readText(input?.publishedAt))) errors.push('publishedAt must be an ISO date');
  if (!readText(input?.summary?.zh) || !readText(input?.summary?.en)) errors.push('summary must include zh and en text');
  if (!Array.isArray(input?.highlights) || input.highlights.length < 3 || input.highlights.length > 6) {
    errors.push('highlights must contain 3 to 6 items');
  } else {
    input.highlights.forEach((item, index) => {
      if (!CATEGORIES.has(item?.category)) errors.push(`highlight ${index + 1} has an invalid category`);
      if (!readText(item?.zh) || !readText(item?.en)) errors.push(`highlight ${index + 1} must include zh and en text`);
    });
  }
  if (input?.releaseUrl && !/^https:\/\/github\.com\/Cing-self\/okit\/releases\/tag\/v\d+\.\d+\.\d+$/.test(input.releaseUrl)) {
    errors.push('releaseUrl must be this repository\'s versioned GitHub Release URL');
  }
  return { valid: errors.length === 0, errors, version };
}

function normalizedReleaseNotes(input, expectedVersion) {
  const result = validateReleaseNotes(input, expectedVersion);
  if (!result.valid) return null;
  return {
    version: result.version,
    publishedAt: input.publishedAt,
    summary: { zh: input.summary.zh.trim(), en: input.summary.en.trim() },
    highlights: input.highlights.map(item => ({ category: item.category, zh: item.zh.trim(), en: item.en.trim() })),
    ...(input.releaseUrl ? { releaseUrl: input.releaseUrl } : {}),
  };
}

function renderReleaseBody(notes) {
  const normalized = normalizedReleaseNotes(notes, notes?.version);
  if (!normalized) throw new Error('Cannot render invalid release notes');
  const labels = {
    zh: { new: '新增', improved: '改进', fixed: '修复' },
    en: { new: 'New', improved: 'Improved', fixed: 'Fixed' },
  };
  const renderLocale = (locale, heading) => {
    const lines = [`## ${heading}`, '', normalized.summary[locale], ''];
    for (const category of ['new', 'improved', 'fixed']) {
      const items = normalized.highlights.filter(item => item.category === category);
      if (!items.length) continue;
      lines.push(`### ${labels[locale][category]}`);
      lines.push(...items.map(item => `- ${item[locale]}`), '');
    }
    return lines.join('\n').trim();
  };
  return [`# OKIT ${normalized.version}`, '', renderLocale('zh', '中文'), '', renderLocale('en', 'English')].join('\n');
}

module.exports = { validateReleaseNotes, normalizedReleaseNotes, renderReleaseBody, versionTag };
