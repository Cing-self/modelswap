// Release-notes gate used by ci.yml: the next version's reviewed notes are
// required ONLY when the diff since the last release touches the shipped
// product. Chore/docs-only merges (gitignore, tests, repo docs, internal
// notes) skip this gate and skip publishing entirely — see release-changes.js.
const { execFileSync } = require('child_process');
const path = require('path');
const { isReleaseWorthy } = require('./release-changes');

if (!isReleaseWorthy()) {
  console.log('No release-worthy changes since the last release — release-notes gate skipped.');
  process.exit(0);
}

const { version } = require(path.resolve('package.json'));
const [major, minor, patch] = version.split('.').map(Number);
if (![major, minor, patch].every(Number.isInteger)) {
  throw new Error(`Invalid package version: ${version}`);
}

const next = `v${major}.${minor}.${patch + 1}`;
console.log(`Release-worthy changes detected — validating notes for ${next}`);
execFileSync(process.execPath, [path.join(__dirname, 'release-notes.js'), 'validate', next], {
  cwd: path.resolve(path.dirname(__filename), '../..'),
  stdio: 'inherit',
});
