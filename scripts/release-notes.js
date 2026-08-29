#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { validateReleaseNotes, normalizedReleaseNotes, renderReleaseBody, versionTag } = require('../src/application/release-notes');

const root = path.resolve(__dirname, '..');
const [command, rawVersion, output] = process.argv.slice(2);
const version = versionTag(rawVersion);

if (!['validate', 'render', 'copy'].includes(command) || !version) {
  console.error('Usage: node scripts/release-notes.js <validate|render|copy> <vX.Y.Z> [output-file]');
  process.exit(1);
}

const source = path.join(root, 'release-notes', `${version}.json`);
let input;
try { input = JSON.parse(fs.readFileSync(source, 'utf8')); } catch (error) {
  console.error(`Release notes not available for ${version}: ${error.message}`);
  process.exit(1);
}
const validation = validateReleaseNotes(input, version);
if (!validation.valid) {
  console.error(`Invalid release notes for ${version}:\n- ${validation.errors.join('\n- ')}`);
  process.exit(1);
}

if (command === 'validate') {
  console.log(`Validated reviewed release notes for ${version}.`);
  process.exit(0);
}
if (!output) {
  console.error(`${command} requires an output file`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
if (command === 'render') fs.writeFileSync(output, `${renderReleaseBody(input)}\n`);
else fs.writeFileSync(output, `${JSON.stringify(normalizedReleaseNotes(input, version), null, 2)}\n`);
