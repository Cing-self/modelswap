// Decides whether the commits since the last release change the shipped
// product. Shared by ci.yml (release-notes gate) and publish.yml (skip
// publishing): docs/chore-only diffs neither require notes nor publish.
//
// Skip list: repo docs, CI plumbing, tests, release notes themselves,
// gitignore, and root-level markdown — EXCEPT README.md, which npm packs,
// so changing it genuinely alters the published package page.
const { execSync } = require('child_process');

const SKIP = /^(docs\/|\.github\/|release-notes\/|tests\/|\.team\/|\.gitignore$|[^/]*\.md$)/;

function changedFiles() {
  let last = '';
  try {
    last = execSync('git rev-list -1 --grep="^chore(release):" HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // shallow clone or no release commit in history → unknown baseline
    return null;
  }
  if (!last) return null; // unknown baseline → treat as release-worthy
  return execSync(`git diff --name-only "${last}"..HEAD`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function isReleaseWorthy() {
  const files = changedFiles();
  if (files === null) return true; // can't prove it's chore-only → gate applies
  if (files.length === 0) return false;
  if (files.includes('README.md')) return true;
  return files.some((file) => !SKIP.test(file));
}

module.exports = { isReleaseWorthy };

if (require.main === module) {
  // Usage in workflows: node release-changes.js >> "$GITHUB_OUTPUT"
  console.log(`release=${isReleaseWorthy() ? 'true' : 'false'}`);
}
