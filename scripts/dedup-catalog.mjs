#!/usr/bin/env node
// Dedupe the cross-platform model dataset: one row per (platform, model).
//
// The Aug-9 scrape left duplicates of several kinds:
//  - spelling dupes:   "ZHIPU/GLM-5.2" vs "glm-5.2" (same model, prefixed id)
//  - dated snapshots:  "deepseek-v4-flash-0731" vs "deepseek-v4-flash"
//    (sometimes filed under their own norm, so dedup must be global per
//    platform, not per norm group)
//  - billing variants: "openai/gpt-5.5:batch" / ":free" (same model, tier)
// Genuinely different SKUs sharing a name (thinking vs instruct) are kept.
//
// Winner within (platform, base): id equal to norm > bare id > non-dated >
// newer snapshot date > priced > more sources > shorter id.
// Usage: node scripts/dedup-catalog.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATASET = path.join(
  import.meta.dirname,
  "..",
  "src/web/frontend/src/data/cross_platform_models.json",
);

const VARIANT_SUFFIX = /:(batch|free)$/;
const DATED_SUFFIX = /-(\d{4,8})$/;

function lastSegment(id) {
  const parts = String(id).split("/");
  return parts[parts.length - 1].toLowerCase();
}

function snapshotDate(id) {
  const m = lastSegment(id).replace(VARIANT_SUFFIX, "").match(DATED_SUFFIX);
  return m ? Number(m[1]) : 0;
}

function baseId(id) {
  return lastSegment(id).replace(VARIANT_SUFFIX, "").replace(DATED_SUFFIX, "");
}

function score(entry, norm) {
  const id = String(entry.model_id || "");
  const last = lastSegment(id);
  let s = 0;
  if (last === norm.toLowerCase()) s += 100; // canonical spelling wins
  if (id.toLowerCase() === norm.toLowerCase()) s += 30; // bare id beats aliases
  if (VARIANT_SUFFIX.test(last)) s -= 50;    // :batch/:free are billing modes
  s += snapshotDate(id) / 1e6;               // newer snapshot survives
  if (Number(entry.pricing?.prompt) > 0) s += 5;
  s += Math.min((entry.sources || []).length, 5);
  s -= Math.min(id.length, 20) / 100;
  return s;
}

const data = JSON.parse(readFileSync(DATASET, "utf-8"));

// Global pass: group every live entry by (platform, base) regardless of norm.
const groups = new Map();
const owner = new Map(); // entry object -> its norm
for (const [norm, entries] of Object.entries(data)) {
  if (!Array.isArray(entries)) continue;
  for (const e of entries) {
    const key = `${e.platform}\u0000${baseId(e.model_id)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ norm, entry: e });
    owner.set(e, norm);
  }
}

const losers = new Set();
const report = [];
for (const [key, group] of groups) {
  if (group.length < 2) continue;
  const ranked = [...group].sort(
    (a, b) => score(b.entry, b.norm) - score(a.entry, a.norm),
  );
  for (const { norm, entry } of ranked.slice(1)) {
    losers.add(entry);
    report.push(
      `${norm} [${entry.platform}] dropped "${entry.model_id}" (kept "${ranked[0].entry.model_id}" under ${ranked[0].norm})`,
    );
  }
}

for (const norm of Object.keys(data)) {
  if (!Array.isArray(data[norm])) continue;
  data[norm] = data[norm].filter(e => !losers.has(e));
  if (data[norm].length === 0) delete data[norm]; // ghost norm cleanup
}

writeFileSync(DATASET, JSON.stringify(data, null, 1) + "\n");
console.log(`dropped ${losers.size} duplicate entries`);
for (const line of report.slice(0, 150)) console.log("  " + line);
if (report.length > 150) console.log(`  … and ${report.length - 150} more`);
