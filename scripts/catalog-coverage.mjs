#!/usr/bin/env node
// Per-platform field coverage report for the cross-platform model dataset.
// Usage: node scripts/catalog-coverage.mjs

import { readFileSync } from "node:fs";
import path from "node:path";

const DATASET = path.join(
  import.meta.dirname,
  "..",
  "src/web/frontend/src/data/cross_platform_models.json",
);
const data = JSON.parse(readFileSync(DATASET, "utf-8"));

const platforms = new Map();
for (const entries of Object.values(data)) {
  if (!Array.isArray(entries)) continue;
  for (const e of entries) {
    if (!platforms.has(e.platform)) {
      platforms.set(e.platform, { total: 0, price: 0, ctx: 0, maxOut: 0, cur: 0, tools: 0, web: 0, src: 0 });
    }
    const s = platforms.get(e.platform);
    s.total++;
    const p = e.pricing || {};
    if (Number(p.prompt) > 0 && Number(p.completion) > 0) s.price++;
    if (e.context > 1) s.ctx++;
    if (e.top_provider?.max_completion_tokens > 0) s.maxOut++;
    if (e.currency) s.cur++;
    if (e.supportsToolCall === true || e.supportsToolCall === false) s.tools++;
    if (e.supportsWebSearch === true || e.supportsWebSearch === false) s.web++;
    if (Array.isArray(e.sources) && e.sources.length > 0) s.src++;
  }
}

const pct = (a, b) => (b === 0 ? "  0%" : String(Math.round((a / b) * 100)).padStart(3) + "%");
console.log(`platform            total  price  ctx  maxOut  curr  tools   web   src`);
for (const [plat, s] of [...platforms.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(
    `${plat.padEnd(18)} ${String(s.total).padStart(5)}  ${pct(s.price, s.total)} ${pct(s.ctx, s.total)}  ${pct(s.maxOut, s.total)}  ${pct(s.cur, s.total)} ${pct(s.tools, s.total)} ${pct(s.web, s.total)} ${pct(s.src, s.total)}`,
  );
}
const all = [...platforms.values()].reduce((acc, s) => {
  for (const k of Object.keys(s)) acc[k] = (acc[k] || 0) + s[k];
  return acc;
}, {});
const grand = [...platforms.values()].reduce((n, s) => n + s.total, 0);
console.log("—".repeat(72));
console.log(`TOTAL               ${String(grand).padStart(5)}  ${pct(all.price, grand)} ${pct(all.ctx, grand)}  ${pct(all.maxOut, grand)}  ${pct(all.cur, grand)} ${pct(all.tools, grand)} ${pct(all.web, grand)} ${pct(all.src, grand)}`);
