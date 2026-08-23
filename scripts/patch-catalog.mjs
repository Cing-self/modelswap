#!/usr/bin/env node
// Merge official-source research into the cross-platform model dataset.
//
// Inputs:  /tmp/catalog-research/*.json — files written by research agents:
//          { platforms: [{ platform, currency, webSearch?, models: [...] }] }
//          Every non-null model field is expected to carry source URLs.
// Output:  src/web/frontend/src/data/cross_platform_models.json, patched in
//          place (fields only ever FILLED when missing, never silently
//          overwritten — conflicts are reported instead).
//
// Usage: node scripts/patch-catalog.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const RESEARCH_DIR = "/tmp/catalog-research";
const DATASET = path.join(
  import.meta.dirname,
  "..",
  "src/web/frontend/src/data/cross_platform_models.json",
);

// Dataset prices are per-token strings; research reports per-million values.
function fmtPerToken(perMillion) {
  const v = perMillion / 1e6;
  if (!Number.isFinite(v) || v <= 0) return null;
  return v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function validPrice(p) {
  const n = Number(p);
  return Number.isFinite(n) && n > 0;
}

const files = existsSync(RESEARCH_DIR)
  ? readdirSync(RESEARCH_DIR).filter(f => f.endsWith(".json"))
  : [];
if (files.length === 0) {
  console.error(`No research files in ${RESEARCH_DIR}`);
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(DATASET, "utf-8"));

// Index dataset entries by platform for fast matching.
const byPlatform = new Map(); // platform -> [{ norm, entry, normLower, idLower }]
for (const [norm, entries] of Object.entries(dataset)) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (!byPlatform.has(entry.platform)) byPlatform.set(entry.platform, []);
    byPlatform.get(entry.platform).push({
      norm,
      entry,
      normLower: norm.toLowerCase(),
      idLower: String(entry.model_id || "").toLowerCase(),
    });
  }
}

const stats = [];

for (const file of files) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(path.join(RESEARCH_DIR, file), "utf-8"));
  } catch {
    console.log(`· skip ${file}: not valid JSON (agent scratch file)`);
    continue;
  }
  if (!payload || !Array.isArray(payload.platforms)) {
    console.log(`· skip ${file}: no platforms array (not a research output)`);
    continue;
  }
  for (const plat of payload.platforms || []) {
    const rows = byPlatform.get(plat.platform) || [];
    const s = {
      file, platform: plat.platform, currency: plat.currency || null,
      overwritePricing: plat.overwritePricing === true,
      researchModels: (plat.models || []).length, matched: 0,
      filled: { pricing: 0, context: 0, maxOut: 0, toolCall: 0, webSearch: 0, sources: 0 },
      conflicts: [], unmatched: [],
    };
    if (plat.currency) {
      for (const { entry } of rows) entry.currency = plat.currency;
    }
    for (const m of plat.models || []) {
      const target = rows.find(r => r.idLower === String(m.modelId || "").toLowerCase())
        || rows.find(r => r.normLower === String(m.norm || m.modelId || "").toLowerCase());
      if (!target) {
        s.unmatched.push(`${m.modelId || m.norm}`);
        continue;
      }
      s.matched++;
      const e = target.entry;
      const hasSource = Array.isArray(m.sources) && m.sources.length > 0;

      if (hasSource) {
        e.sources = [...new Set([...(e.sources || []), ...m.sources])];
        s.filled.sources++;
      }

      if (m.deprecated === true) {
        // Officially delisted: mark the entry and drop stale scraped prices —
        // keeping them would show dead prices the vendor no longer offers.
        e.deprecated = true;
        if (e.pricing) {
          delete e.pricing.prompt;
          delete e.pricing.completion;
          delete e.pricing.input_cache_read;
          delete e.pricing.input_cache_write;
        }
      }

      if (m.supportsToolCall === true || m.supportsToolCall === false) {
        e.supportsToolCall = m.supportsToolCall;
        s.filled.toolCall++;
      }
      if (m.supportsWebSearch === true || m.supportsWebSearch === false) {
        e.supportsWebSearch = m.supportsWebSearch;
        s.filled.webSearch++;
      }

      // Prices: fill only what is missing; report meaningful conflicts.
      if (!e.pricing) e.pricing = {};
      const pricePairs = [
        [m.inputPrice, "prompt"],
        [m.outputPrice, "completion"],
        [m.cacheReadPrice, "input_cache_read"],
      ];
      for (const [perM, key] of pricePairs) {
        if (!validPrice(perM)) continue;
        const perToken = fmtPerToken(perM);
        if (!perToken) continue;
        if (validPrice(e.pricing[key])) {
          const existing = Number(e.pricing[key]) * 1e6;
          const differs = Math.abs(existing - perM) / Math.max(existing, perM) > 0.005;
          if (hasSource && s.overwritePricing && differs) {
            e.pricing[key] = perToken; // official value replaces scraped value
            s.conflicts.push(`${m.modelId}.${key}: dataset=${existing.toFixed(4)}/M → research=${perM}/M (overwritten, sourced)`);
          } else if (hasSource && differs && Math.abs(existing - perM) / Math.max(existing, perM) > 0.05) {
            s.conflicts.push(`${m.modelId}.${key}: dataset=${existing.toFixed(4)}/M vs research=${perM}/M (kept dataset)`);
          }
        } else {
          if (!hasSource) continue; // never write unsourced values
          e.pricing[key] = perToken;
          s.filled.pricing++;
        }
      }

      if (m.context && (!e.context || e.context <= 1)) {
        if (hasSource) { e.context = m.context; s.filled.context++; }
      }
      if (m.maxOutputTokens && !e.top_provider?.max_completion_tokens) {
        if (hasSource) {
          if (!e.top_provider) e.top_provider = {};
          e.top_provider.max_completion_tokens = m.maxOutputTokens;
          s.filled.maxOut++;
        }
      }
    }
    stats.push(s);
  }
}

writeFileSync(DATASET, JSON.stringify(dataset, null, 1) + "\n");

console.log("— merge report ".padEnd(60, "—"));
for (const s of stats) {
  console.log(
    `[${s.platform}] currency=${s.currency} research=${s.researchModels} matched=${s.matched} ` +
    `filled: price=${s.filled.pricing} ctx=${s.filled.context} maxOut=${s.filled.maxOut} ` +
    `tools=${s.filled.toolCall} web=${s.filled.webSearch} src=${s.filled.sources}`,
  );
  for (const c of s.conflicts) console.log(`    ⚠ conflict ${c}`);
  if (s.unmatched.length) console.log(`    · unmatched: ${s.unmatched.join(", ")}`);
}
