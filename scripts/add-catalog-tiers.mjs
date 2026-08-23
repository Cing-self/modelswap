#!/usr/bin/env node
// Attach tiered/time-of-day pricing to catalog entries.
//
// Vendors price some models differently by request length, output length,
// or time of day (DeepSeek peak/off-peak). The main price columns keep the
// standard tier; this script adds `pricingTiers` (+ `pricingTierKind`) so the
// page can show a hover chip with the full breakdown. All numbers come from
// the 2026-08-17 official-source research (see research file notes).
// Usage: node scripts/add-catalog-tiers.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATASET = path.join(
  import.meta.dirname,
  "..",
  "src/web/frontend/src/data/cross_platform_models.json",
);

const DS_SRC = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const BM_SRC = "https://bigmodel.cn/pricing";
const ALI_SRC = "https://help.aliyun.com/zh/model-studio/model-pricing";
const VOLC_SRC = "https://www.volcengine.com/docs/82379/1544106";
const QF_SRC = "https://cloud.baidu.com/doc/qianfan-shop/wmh4sv6ya";
const MM_SRC = "https://platform.minimaxi.com/docs/guides/pricing-paygo";
const OAI_SRC = "https://developers.openai.com/api/docs/pricing";
const GG_SRC = "https://ai.google.dev/gemini-api/docs/pricing";

// kind: "time" = 分时（峰谷）; "length" = 分档（按输入/输出长度）
const TIERS = [
  // DeepSeek 官方：2026-08-17 起峰谷分时（峰=9-12/14-18 点，谷=半价）
  { platform: "deepseek", id: "deepseek-v4-flash", kind: "time", source: DS_SRC, tiers: [
    { label: "峰时（9-12 / 14-18 点）", input: 3, output: 9, cacheRead: 0.1 },
    { label: "谷时（其余时段，半价）", input: 1.5, output: 4.5, cacheRead: 0.05 },
  ]},
  { platform: "deepseek", id: "deepseek-v4-pro", kind: "time", source: DS_SRC, tiers: [
    { label: "峰时（9-12 / 14-18 点）", input: 9, output: 27, cacheRead: 0.3 },
    { label: "谷时（其余时段，半价）", input: 4.5, output: 13.5, cacheRead: 0.15 },
  ]},
  // 百炼托管的 DeepSeek：忙闲分时
  { platform: "dashscope", id: "deepseek-v4-flash", kind: "time", source: ALI_SRC, tiers: [
    { label: "忙时", input: 3, output: 9, cacheRead: 0.3 },
    { label: "闲时", input: 1.5, output: 4.5, cacheRead: 0.15 },
  ]},
  { platform: "dashscope", id: "deepseek-v4-pro", kind: "time", source: ALI_SRC, tiers: [
    { label: "忙时", input: 9, output: 27 },
    { label: "闲时", input: 4.5, output: 13.5 },
  ]},
  // 智谱国内：输入/输出长度分档（表内取常用档）
  { platform: "zai", id: "glm-5.1", kind: "length", source: BM_SRC, tiers: [
    { label: "输入 [0, 32K)", input: 6, output: 24, cacheRead: 1.3 },
    { label: "输入 [32K+)", input: 8, output: 28, cacheRead: 2 },
  ]},
  { platform: "zai", id: "glm-5-turbo", kind: "length", source: BM_SRC, tiers: [
    { label: "输入 [0, 32K)", input: 5, output: 22, cacheRead: 1.2 },
    { label: "输入 [32K+)", input: 7, output: 26, cacheRead: 1.8 },
  ]},
  { platform: "zai", id: "glm-5", kind: "length", source: BM_SRC, tiers: [
    { label: "输入 [0, 32K)", input: 4, output: 18, cacheRead: 1 },
    { label: "输入 [32K+)", input: 6, output: 22, cacheRead: 1.5 },
  ]},
  { platform: "zai", id: "glm-4.7", kind: "length", source: BM_SRC, tiers: [
    { label: "输入 [0,32K) 且输出 <0.2K", input: 2, output: 8, cacheRead: 0.4 },
    { label: "输入 [0,32K) 且输出 ≥0.2K", input: 3, output: 14, cacheRead: 0.6 },
    { label: "输入 (32K, 200K]", input: 4, output: 16, cacheRead: 0.8 },
  ]},
  { platform: "zai", id: "glm-4.5-air", kind: "length", source: BM_SRC, tiers: [
    { label: "输入 [0,32K) 且输出 <0.2K", input: 0.8, output: 2, cacheRead: 0.16 },
    { label: "输入 [0,32K) 且输出 ≥0.2K", input: 0.8, output: 6, cacheRead: 0.16 },
    { label: "输入 (32K, 128K]", input: 1.2, output: 8, cacheRead: 0.24 },
  ]},
  // 百炼 / Qwen 平台：长度阶梯
  { platform: "dashscope", id: "qwen3-max", kind: "length", source: ALI_SRC, tiers: [
    { label: "≤32K", input: 6, output: 24 },
    { label: "32K-128K", input: 10, output: 40 },
    { label: "128K-256K", input: 15, output: 60 },
  ]},
  { platform: "dashscope", id: "qwen-plus", kind: "length", source: ALI_SRC, tiers: [
    { label: "≤128K（思考输出 ¥8）", input: 0.8, output: 2 },
    { label: "128K-256K（思考输出 ¥24）", input: 2.4, output: 20 },
    { label: "256K-1M（思考输出 ¥64）", input: 4.8, output: 48 },
  ]},
  { platform: "qwen", id: "qwen-plus", kind: "length", source: ALI_SRC, tiers: [
    { label: "≤128K（思考输出 ¥8）", input: 0.8, output: 2 },
    { label: "128K-256K（思考输出 ¥24）", input: 2.4, output: 20 },
    { label: "256K-1M（思考输出 ¥64）", input: 4.8, output: 48 },
  ]},
  { platform: "qwen", id: "qwen3.5-plus-20260420", kind: "length", source: ALI_SRC, tiers: [
    { label: "≤128K", input: 0.8, output: 4.8 },
    { label: "128K-256K", input: 2, output: 12 },
    { label: "256K-1M", input: 4, output: 24 },
  ]},
  // 火山方舟：分段计价
  { platform: "volcengine", id: "glm-4.7", kind: "length", source: VOLC_SRC, tiers: [
    { label: "输入 [0,32k) 且输出 ≤0.2M", input: 2, output: 8, cacheRead: 0.4 },
    { label: "输入 [0,32k) 且输出 >0.2M", input: 3, output: 14, cacheRead: 0.6 },
    { label: "输入 (32k,200k]", input: 4, output: 16, cacheRead: 0.8 },
  ]},
  { platform: "volcengine", id: "doubao-seed-2-0-pro-260215", kind: "length", source: VOLC_SRC, tiers: [
    { label: "(32k, 128k]", input: 4.8, output: 24, cacheRead: 0.96 },
    { label: "(128k, 256k]", input: 9.6, output: 48, cacheRead: 1.92 },
  ]},
  { platform: "volcengine", id: "doubao-seed-2-0-lite-260428", kind: "length", source: VOLC_SRC, tiers: [
    { label: "(32k, 128k]", input: 0.9, output: 5.4, cacheRead: 0.18 },
    { label: "(128k, 256k]", input: 1.8, output: 10.8, cacheRead: 0.36 },
  ]},
  { platform: "volcengine", id: "doubao-seed-2-0-mini-260428", kind: "length", source: VOLC_SRC, tiers: [
    { label: "(32k, 128k]", input: 0.4, output: 4, cacheRead: 0.08 },
    { label: "(128k, 256k]", input: 0.8, output: 8, cacheRead: 0.16 },
  ]},
  // 百度千帆
  { platform: "qianfan", id: "deepseek-v3.2", kind: "length", source: QF_SRC, tiers: [
    { label: "(32k, 128k]", input: 4, output: 6, cacheRead: 0.4 },
  ]},
  // MiniMax M3：≤512K 永久五折
  { platform: "minimax", id: "minimax-m3", kind: "length", source: MM_SRC, tiers: [
    { label: "≤512K（永久五折价）", input: 2.1, output: 8.4, cacheRead: 0.42 },
    { label: ">512K", input: 4.2, output: 16.8, cacheRead: 0.84 },
  ]},
  // OpenAI 长上下文档
  { platform: "openai", id: "gpt-5.5", kind: "length", source: OAI_SRC, tiers: [
    { label: "标准（<272K prompt）", input: 5, output: 30, cacheRead: 0.5 },
    { label: "长上下文（>272K）", input: 10, output: 45, cacheRead: 1 },
    { label: "flex / batch", input: 2.5, output: 15 },
  ]},
  // Gemini 长上下文档
  { platform: "google", id: "gemini-2.5-pro", kind: "length", source: GG_SRC, tiers: [
    { label: "prompt ≤200K", input: 1.25, output: 10, cacheRead: 0.125 },
    { label: "prompt >200K（全部 token 按此档）", input: 2.5, output: 15, cacheRead: 0.25 },
  ]},
];

const data = JSON.parse(readFileSync(DATASET, "utf-8"));
let applied = 0;
const missing = [];

for (const spec of TIERS) {
  let target = null;
  for (const entries of Object.values(data)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e.platform !== spec.platform) continue;
      const last = String(e.model_id).split("/").pop().toLowerCase();
      if (last === spec.id.toLowerCase()) { target = e; break; }
    }
    if (target) break;
  }
  if (!target) { missing.push(`${spec.platform}/${spec.id}`); continue; }
  target.pricingTiers = spec.tiers;
  target.pricingTierKind = spec.kind;
  target.sources = [...new Set([...(target.sources || []), spec.source])];
  applied++;
}

writeFileSync(DATASET, JSON.stringify(data, null, 1) + "\n");
console.log(`applied tiers to ${applied}/${TIERS.length} entries`);
if (missing.length) console.log("missing:\n  " + missing.join("\n  "));
