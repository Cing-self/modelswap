// Machine-readable report envelope + sanitization + exit-code policy.
//
// Every page-derived string passes redactSecrets/sanitizeUrl/sanitizeTextSummary
// before it is stored, so a report can never carry an API key, cookie value,
// request header, password, or a URL query string. The report deliberately has
// no fields for cookies/headers/profile dumps — there is nothing to sanitize
// into existence.

import path from 'node:path';
import fs from 'node:fs/promises';
import { redactSecrets, sanitizeUrl, sanitizeTextSummary } from './safety.mjs';

export const REPORT_SCHEMA_VERSION = 1;
export const TOOL_NAME = 'provider-live-acceptance';

// Statuses that count as an accepted pass. waiting_for_user and
// blocked_prerequisite are HONEST non-passes: they must never be reported as
// platform acceptance.
export const PASS_STATUSES = new Set([
  'passed_login_gate',
  'passed_entry_found',
  'passed_console_reached',
  'passed',
  'passed_existing_reuse',
  'dry_run',
]);

const RESULT_FIELDS = new Set([
  'platform', 'label', 'mode', 'stage', 'status', 'reason',
  'loginUrl', 'page', 'screenshot', 'steps', 'testName', 'createdName',
  'delegateReport',
]);

export function sanitizePlatformResult(result) {
  const source = result || {};
  const out = {};
  for (const field of RESULT_FIELDS) {
    if (source[field] === undefined) continue;
    out[field] = source[field];
  }
  out.platform = String(out.platform || '').slice(0, 80);
  out.label = redactSecrets(out.label).slice(0, 120);
  out.status = String(out.status || 'failed').slice(0, 60);
  out.stage = String(out.stage || '').slice(0, 60);
  if (out.reason !== undefined) out.reason = redactSecrets(out.reason);
  if (out.loginUrl !== undefined) out.loginUrl = sanitizeUrl(out.loginUrl);
  if (out.testName !== undefined) out.testName = redactSecrets(out.testName).slice(0, 200);
  if (out.createdName !== undefined) out.createdName = redactSecrets(out.createdName).slice(0, 200);
  if (out.delegateReport !== undefined) out.delegateReport = sanitizeUrl(out.delegateReport) || redactSecrets(out.delegateReport).slice(0, 300);
  if (out.page) {
    out.page = {
      title: redactSecrets(out.page.title).slice(0, 120),
      buttonsSummary: sanitizeTextSummary(out.page.buttonsSummary),
      linksSummary: sanitizeTextSummary(out.page.linksSummary, { maxItems: 20 }),
      bodyChars: Number(out.page.bodyChars) || 0,
    };
  }
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((step) => ({
      step: redactSecrets(step?.step).slice(0, 60),
      detail: redactSecrets(step?.detail),
    })).slice(0, 40);
  }
  return out;
}

export function startReport({ mode, dryRun, checkout, requestedPlatforms, safety }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_NAME,
    mode,
    dryRun: Boolean(dryRun),
    startedAt: new Date().toISOString(),
    checkout: {
      revision: String(checkout?.revision || '').slice(0, 64),
      dirty: Boolean(checkout?.dirty),
    },
    safety: {
      readOnlyAtomsOnly: true,
      dailyProfileProtection: 'enforced',
      artifactRootOutsideGit: true,
      ...safety,
    },
    requestedPlatforms: (requestedPlatforms || []).map((id) => String(id).slice(0, 80)),
    platforms: [],
    results: [],
  };
}

export function finalizeReport(report) {
  report.platforms = report.results.map((result) => result.platform);
  report.endedAt = new Date().toISOString();
  const summary = {};
  for (const result of report.results) {
    summary[result.status] = (summary[result.status] || 0) + 1;
  }
  report.summary = summary;
  report.exitCode = exitCodeFromResults(report.results);
  return report;
}

// 1 = failed / cleanup_failed / rejected (real defects, redesign cases)
// 2 = waiting_for_user / blocked_prerequisite / not_run (honest non-passes)
// 0 = everything passed (or dry_run plan validation)
export function exitCodeFromResults(results) {
  let sawHonestBlock = false;
  for (const result of results || []) {
    const status = result?.status;
    if (['failed', 'cleanup_failed', 'rejected'].includes(status)) return 1;
    if (['waiting_for_user', 'blocked_prerequisite', 'not_run'].includes(status)) sawHonestBlock = true;
  }
  return sawHonestBlock ? 2 : 0;
}

export function reportFileName(report, stamp) {
  const mode = String(report.mode || 'unknown').replace(/[^a-z0-9-]/gi, '');
  return `${stamp.replace(/[:.]/g, '-')}-live-${mode}.json`;
}

export async function writeReportFile(rootDir, report, stamp) {
  const dir = path.join(rootDir, 'reports');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, reportFileName(report, stamp));
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}
