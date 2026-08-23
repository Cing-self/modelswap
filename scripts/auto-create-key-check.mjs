#!/usr/bin/env node

/**
 * Destructive-but-scoped auto-create smoke test.
 *
 * Each run uses a unique OKIT_AUTOCHECK_* name, creates one credential through
 * the same HTTP route as the UI, then revokes/deletes that exact credential.
 * Subscription flows that deliberately copy an existing key are verified but
 * are never deleted. Reports contain status and redacted errors only.
 *
 * Status contract:
 *   passed                 create + read + delete + row disappearance
 *   passed_existing_reuse  existing subscription key read/copy only
 *   waiting_for_user       login/CAPTCHA/MFA/security challenge
 *   blocked_prerequisite   missing dedicated test credential or entitlement
 *   failed                 an automation/provider implementation problem
 *   cleanup_failed         created, but deletion was not confirmed
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AUTO_CREATE_PLATFORMS } = require('../src/web/api/auto-create.js');

const BASE_URL = process.env.OKIT_AUTO_CREATE_BASE_URL || 'http://127.0.0.1:3780';
const REPORT_DIR = process.env.OKIT_AUTO_CREATE_REPORT_DIR
  || path.join(os.homedir(), '.okit', 'auto-create-check');
const cliArgs = process.argv.slice(2);
const args = new Set(cliArgs.filter(value => value.startsWith('--')));
const cleanupOptionIndex = cliArgs.indexOf('--cleanup');
const cleanupReportPath = cleanupOptionIndex >= 0 ? cliArgs[cleanupOptionIndex + 1] : '';
const requestedPlatforms = cliArgs.filter((value, index) => (
  !value.startsWith('--')
  && !(cleanupOptionIndex >= 0 && index === cleanupOptionIndex + 1)
));
const selectedPlatforms = requestedPlatforms.length
  ? AUTO_CREATE_PLATFORMS.filter(platform => requestedPlatforms.includes(platform.id))
  : AUTO_CREATE_PLATFORMS;

function redact(value) {
  return String(value || '')
    .replace(/(?:sk|xai|tp|bce-v3)[-_/.A-Za-z0-9]{12,}/g, '[REDACTED]')
    .replace(/AKLT[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .slice(0, 600);
}

function testName(platformId, stamp) {
  return `OKIT_AUTOCHECK_${platformId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_${stamp}`;
}

function failureMessage(status, payload) {
  return redact(payload?.error || payload?.message || `HTTP ${status}`);
}

function classifyCreateFailure(platform, status, payload) {
  const message = String(payload?.error || payload?.message || '').toLowerCase();
  if (/验证码|安全验证|身份验证|短信|微信扫码|滑块|拼图|captcha|turnstile|mfa|security verification/.test(message)) {
    return 'waiting_for_user';
  }
  if (payload?.loginRequired || status === 401 || /需要登录|请登录|未登录|login required|sign in/.test(message)) {
    return 'waiting_for_user';
  }
  if (/扩展未连接|chrome 扩展|extension.*not connected|cdp unavailable/.test(message)) {
    return 'blocked_prerequisite';
  }
  if (/未找到.*(?:创建|密钥|key|api key|操作).*(?:按钮|入口)|没有(?:创建|密钥|key).*入口|无(?:创建|密钥|key).*入口|no (?:create|key|api key).*button/.test(message)) {
    return 'blocked_prerequisite';
  }
  if (platform.id === 'cloudflare' && /parent token|父级/.test(message)) {
    return 'blocked_prerequisite';
  }
  if (platform.reuseExistingMaskedKey && /没有显示|没有可复制|无可复制|existing.*key|订阅 key|subscription key|token plan/.test(message)) {
    return 'blocked_prerequisite';
  }
  if (/权限|permission|billing|账单|费用中心|套餐尚未|套餐未开通|未开通/.test(message)) {
    return 'blocked_prerequisite';
  }
  return 'failed';
}

async function request(route, body) {
  const response = await fetch(new URL(route, BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, payload };
}

async function getJson(route) {
  const response = await fetch(new URL(route, BASE_URL));
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, payload };
}

function checkoutState() {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { revision, dirty: Boolean(dirty) };
  } catch (error) {
    return { revision: '', dirty: true, error: redact(error.message || error) };
  }
}

async function runOne(platform, stamp) {
  const name = testName(platform.id, stamp);
  const result = {
    id: platform.id,
    label: platform.label,
    mode: platform.mode,
    testName: name,
    status: 'not_run',
    cleanup: 'not_started',
  };

  const parentToken = process.env.OKIT_AUTOCHECK_CLOUDFLARE_PARENT_TOKEN || '';
  if (platform.id === 'cloudflare' && !parentToken) {
    result.status = 'blocked_prerequisite';
    result.reason = '缺少 OKIT_AUTOCHECK_CLOUDFLARE_PARENT_TOKEN；不会复用生产 Vault Token';
    return result;
  }

  let create;
  try {
    create = await request('/api/vault/auto-create', {
      platform: platform.id,
      tokenName: name,
      ...(platform.id === 'cloudflare' ? { parentToken } : {}),
    });
  } catch (error) {
    result.status = 'failed';
    result.reason = `创建请求失败：${redact(error.message || error)}`;
    return result;
  }
  if (create.status !== 200 || !create.payload?.success) {
    result.status = classifyCreateFailure(platform, create.status, create.payload);
    result.reason = `创建未完成（HTTP ${create.status}）：${failureMessage(create.status, create.payload)}`;
    if (create.payload?.runId) result.runId = String(create.payload.runId).slice(0, 80);
    return result;
  }
  result.createdName = String(create.payload.name || name).slice(0, 200);

  // These flows intentionally copy an already-existing subscription key. The
  // returned value was not created by this run, so deleting it would violate
  // the test's cleanup boundary and could break the user's subscription.
  if (platform.reuseExistingMaskedKey) {
    result.status = 'passed_existing_reuse';
    result.cleanup = 'not_applicable_existing_key';
    return result;
  }

  let cleanup;
  try {
    cleanup = await request('/api/vault/auto-create/delete', {
      platform: platform.id,
      createdName: result.createdName,
      ...(platform.id === 'cloudflare'
        ? { parentToken, tokenId: create.payload.id }
        : {}),
    });
  } catch (error) {
    result.status = 'cleanup_failed';
    result.cleanup = 'failed';
    result.reason = `删除请求失败：${redact(error.message || error)}`;
    return result;
  }
  if (cleanup.status !== 200 || !cleanup.payload?.success) {
    const cleanupStatus = classifyCreateFailure(platform, cleanup.status, cleanup.payload);
    result.status = cleanupStatus === 'waiting_for_user' ? 'waiting_for_user' : 'cleanup_failed';
    result.cleanup = cleanupStatus === 'waiting_for_user' ? 'waiting_for_user' : 'failed';
    result.reason = `删除失败（HTTP ${cleanup.status}）：${redact(cleanup.payload?.error || 'unknown error')}`;
    if (cleanup.payload?.runId) result.runId = String(cleanup.payload.runId).slice(0, 80);
    return result;
  }
  result.status = 'passed';
  result.cleanup = 'deleted';
  return result;
}

async function runCleanupOne(platform, target) {
  const result = {
    id: platform.id,
    label: platform.label,
    mode: platform.mode,
    testName: target.testName,
    createdName: target.createdName,
    status: 'not_run',
    cleanup: 'not_started',
    sourceStatus: target.status,
  };
  let cleanup;
  try {
    cleanup = await request('/api/vault/auto-create/delete', {
      platform: platform.id,
      createdName: target.createdName,
    });
  } catch (error) {
    result.status = 'cleanup_failed';
    result.cleanup = 'failed';
    result.reason = `删除请求失败：${redact(error.message || error)}`;
    return result;
  }
  if (cleanup.status !== 200 || !cleanup.payload?.success) {
    const cleanupStatus = classifyCreateFailure(platform, cleanup.status, cleanup.payload);
    result.status = cleanupStatus === 'waiting_for_user' ? 'waiting_for_user' : 'cleanup_failed';
    result.cleanup = cleanupStatus === 'waiting_for_user' ? 'waiting_for_user' : 'failed';
    result.reason = `删除失败（HTTP ${cleanup.status}）：${redact(cleanup.payload?.error || 'unknown error')}`;
    if (cleanup.payload?.runId) result.runId = String(cleanup.payload.runId).slice(0, 80);
    return result;
  }
  result.status = 'passed';
  result.cleanup = 'deleted';
  return result;
}

async function readCleanupTargets(reportPath) {
  if (!reportPath || reportPath.startsWith('--')) {
    throw new Error('--cleanup 需要提供一个报告 JSON 路径');
  }
  const source = JSON.parse(await fs.readFile(path.resolve(reportPath), 'utf8'));
  const targets = (source.results || [])
    .filter(result => ['cleanup_failed', 'waiting_for_user'].includes(result.status) && result.createdName)
    .map(result => ({
      id: result.id,
      testName: result.testName,
      createdName: result.createdName,
      status: result.status,
    }));
  if (!targets.length) throw new Error(`报告没有可清理的孤儿测试密钥：${reportPath}`);
  return { source, targets };
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  if (args.has('--list')) {
    for (const platform of AUTO_CREATE_PLATFORMS) {
      console.log(`${platform.id}\t${platform.label}\t${platform.mode}`);
    }
    return;
  }
  const cleanupMode = args.has('--cleanup');
  const cleanupData = cleanupMode ? await readCleanupTargets(cleanupReportPath) : null;
  const cleanupTargets = cleanupData?.targets || [];
  const cleanupPlatforms = cleanupTargets.map(target => AUTO_CREATE_PLATFORMS.find(platform => platform.id === target.id));
  if (cleanupPlatforms.some(platform => !platform)) {
    const unknown = cleanupTargets.find(target => !AUTO_CREATE_PLATFORMS.some(platform => platform.id === target.id));
    throw new Error(`报告中的平台当前不受支持：${unknown?.id || 'unknown'}`);
  }
  const activePlatforms = cleanupMode ? cleanupPlatforms : selectedPlatforms;
  const report = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    checkout: { cwd: process.cwd(), ...checkoutState() },
    mode: cleanupMode ? 'cleanup' : 'create-check',
    sourceReport: cleanupMode ? path.resolve(cleanupReportPath) : undefined,
    requestedPlatforms: cleanupMode ? cleanupTargets.map(target => target.id) : requestedPlatforms,
    platforms: activePlatforms.map(platform => platform.id),
    results: [],
  };

  if (!activePlatforms.length) throw new Error(cleanupMode ? '报告没有可清理的测试密钥' : '没有匹配到测试平台');
  if (args.has('--dry-run')) {
    report.results = cleanupMode
      ? cleanupTargets.map(target => ({ ...target, status: 'dry_run' }))
      : activePlatforms.map(platform => ({ id: platform.id, label: platform.label, status: 'dry_run' }));
  } else {
    if (report.checkout.dirty) {
      const reason = report.checkout.error
        ? `无法确认 checkout 状态：${report.checkout.error}`
        : `检测 checkout 存在未提交修改；为避免每天执行未知代码，本轮未开始${cleanupMode ? '清理' : '创建'}`;
      report.results = cleanupMode
        ? cleanupTargets.map(target => ({ ...target, status: 'blocked_prerequisite', cleanup: 'not_started', reason }))
        : activePlatforms.map(platform => ({
          id: platform.id,
          label: platform.label,
          mode: platform.mode,
          testName: testName(platform.id, stamp),
          status: 'blocked_prerequisite',
          cleanup: 'not_started',
          reason,
        }));
    } else {
      const health = await getJson('/api/vault/cdp-status').catch(error => ({ status: 0, payload: { error: error.message } }));
      if (!health.payload?.available && activePlatforms.some(platform => platform.mode === 'browser')) {
        const reason = `Chrome 扩展未连接（${redact(health.payload?.error || 'cdp unavailable')}），本轮未开始${cleanupMode ? '清理' : '创建'}`;
        report.results = cleanupMode
          ? cleanupTargets.map(target => ({ ...target, status: 'blocked_prerequisite', cleanup: 'not_started', reason }))
          : activePlatforms.map(platform => ({
            id: platform.id,
            label: platform.label,
            mode: platform.mode,
            testName: testName(platform.id, stamp),
            status: platform.mode === 'browser' ? 'blocked_prerequisite' : 'not_run',
            cleanup: 'not_started',
            reason,
          }));
      } else if (cleanupMode) {
        for (let index = 0; index < cleanupTargets.length; index += 1) {
          const target = cleanupTargets[index];
          const platform = cleanupPlatforms[index];
          const result = await runCleanupOne(platform, target);
          report.results.push(result);
          console.log(`${result.status}\t${platform.id}\t${target.createdName}${result.reason ? `\t${result.reason}` : ''}`);
          if (result.status !== 'passed') {
            for (const remaining of cleanupTargets.slice(index + 1)) {
              report.results.push({ ...remaining, status: 'not_run', reason: result.status === 'waiting_for_user' ? '前一个测试密钥等待人工安全验证，已停止清理' : '前一个测试密钥清理失败，已停止清理' });
            }
            break;
          }
        }
      } else {
        for (const platform of activePlatforms) {
          const result = await runOne(platform, stamp);
          report.results.push(result);
          console.log(`${result.status}\t${platform.id}${result.reason ? `\t${result.reason}` : ''}`);
          // Never create another provider key after a cleanup failure. This keeps
          // one unresolved credential visible and prevents an orphan-key cascade.
          if (result.status === 'cleanup_failed' || (result.status === 'waiting_for_user' && result.cleanup === 'waiting_for_user')) {
            for (const remaining of activePlatforms.slice(report.results.length)) {
              report.results.push({ id: remaining.id, label: remaining.label, status: 'not_run', reason: result.status === 'waiting_for_user' ? '前一个测试密钥等待人工安全验证，已停止批量创建' : '前一个测试密钥删除失败，已停止批量创建' });
            }
            break;
          }
        }
      }
    }
  }
  report.endedAt = new Date().toISOString();
  report.summary = report.results.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report\t${reportPath}`);
  const failed = report.results.some(result => !['passed', 'passed_existing_reuse', 'dry_run'].includes(result.status));
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(`fatal\t${redact(error.message || error)}`);
  process.exitCode = 1;
});
