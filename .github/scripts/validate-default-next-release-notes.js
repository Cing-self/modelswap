#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const { version } = require(path.join(root, 'package.json'));
const [major, minor, patch] = version.split('.').map(Number);

if (![major, minor, patch].every(Number.isInteger)) {
  throw new Error(`Invalid package version: ${version}`);
}

const next = `v${major}.${minor}.${patch + 1}`;
execFileSync(process.execPath, [path.join(__dirname, 'release-notes.js'), 'validate', next], {
  cwd: root,
  stdio: 'inherit',
});
