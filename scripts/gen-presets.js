#!/usr/bin/env node
// Codegen: extract provider presets + metadata from the compiled TS output
// and write a JSON file for the frontend to import.
//
// This script runs AFTER `tsc` (so dist/ is fresh) and BEFORE the frontend
// build. It reads:
//   dist/providers/presets.js   → PRESET_PROVIDERS
//   dist/providers/metadata.js  → PROVIDER_GROUPS, PROVIDER_FAMILIES,
//                                  RETIRED_PRESET_PROVIDER_IDS,
//                                  PRESET_BASE_URL_MIGRATIONS,
//                                  PRESET_ENDPOINT_BASE_URL_MIGRATIONS
//
// Output: src/web/frontend/src/data/providers-generated.json
//
// The frontend imports this JSON instead of defining its own copy of the data.

'use strict';

const fs = require('fs-extra');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_PROVIDERS = path.join(ROOT, 'dist', 'providers');
const OUT_JSON = path.join(ROOT, 'src', 'web', 'frontend', 'src', 'data', 'providers-generated.json');

function mapToObj(map) {
  if (!map || typeof map.entries !== 'function') return {};
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

function setToArr(set) {
  if (!set || typeof Array.from !== 'function') return [];
  return Array.from(set);
}

async function main() {
  // Require the compiled modules.
  // If dist/ doesn't exist yet (e.g. first build), error out clearly.
  const presetsPath = path.join(DIST_PROVIDERS, 'presets.js');
  const metadataPath = path.join(DIST_PROVIDERS, 'metadata.js');
  const platformsPath = path.join(DIST_PROVIDERS, 'platforms.js');

  if (!await fs.pathExists(presetsPath)) {
    console.error('[gen-presets] Error: dist/providers/presets.js not found. Run `tsc` first.');
    process.exit(1);
  }

  // Invalidate require cache in case of repeated runs.
  delete require.cache[require.resolve(presetsPath)];
  if (await fs.pathExists(metadataPath)) delete require.cache[require.resolve(metadataPath)];

  const { PRESET_PROVIDERS } = require(presetsPath);
  const { buildPlatforms } = require(platformsPath);

  let groups = [];
  let families = [];
  let retired = [];
  let baseUrlMigrations = {};
  let endpointUrlMigrations = {};

  if (await fs.pathExists(metadataPath)) {
    const meta = require(metadataPath);
    groups = meta.PROVIDER_GROUPS || [];
    families = meta.PROVIDER_FAMILIES || [];
    retired = setToArr(meta.RETIRED_PRESET_PROVIDER_IDS);
    baseUrlMigrations = mapToObj(meta.PRESET_BASE_URL_MIGRATIONS);
    endpointUrlMigrations = mapToObj(meta.PRESET_ENDPOINT_BASE_URL_MIGRATIONS);
  }

  const output = {
    presets: PRESET_PROVIDERS,
    platforms: buildPlatforms(PRESET_PROVIDERS),
    groups,
    families,
    retired,
    baseUrlMigrations,
    endpointUrlMigrations,
  };

  await fs.ensureDir(path.dirname(OUT_JSON));
  await fs.writeFile(OUT_JSON, JSON.stringify(output, null, 2));

  console.log(`[gen-presets] Wrote ${PRESET_PROVIDERS.length} presets, ${output.platforms.length} platforms → ${path.relative(ROOT, OUT_JSON)}`);
}

main().catch(err => {
  console.error('[gen-presets] Fatal:', err);
  process.exit(1);
});
