// Acceptance session binding (P0): make the dedicated test Chrome's extension
// connection PROVABLE before create-cleanup may delegate any create/delete.
//
// The product extension and the product server cannot be modified, so the
// binding works through a per-session patched COPY of the extension:
//
//   1. provider-live-chrome.mjs --with-extension generates a one-time session
//      id, writes a launch record (profile dir, debug port, pid, extension
//      copy dir) under ~/.okit/provider-live-acceptance/sessions/, and loads a
//      patched extension copy that reports {sessionId, wsUrl, wsState} to a
//      local witness endpoint whenever its server WS is open.
//   2. create-cleanup preflight starts the witness, re-validates the launch
//      record (profile inside the acceptance root, patched copy intact,
//      dedicated Chrome alive) and waits for a FRESH matching heartbeat.
//   3. No proof → refuse (unverified_extension_identity, exit 1). An ordinary
//      unpatched extension (e.g. the daily Chrome's) never reports, so its
//      presence alone can never authorize delegation.
//
// Residual-risk note (documented in docs/testing): a concurrently running
// daily extension could still evict the dedicated one after a verified
// heartbeat (single-slot server). The freshness window plus immediate
// delegation bound that race; it is not eliminated.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { assertSafeProfileDir } from './safety.mjs';

export const DEFAULT_WITNESS_PORT = Number(process.env.OKIT_LIVE_WITNESS_PORT || 9341);
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function newSessionId() {
  return crypto.randomUUID();
}

export function isValidSessionId(sessionId) {
  return SESSION_ID_PATTERN.test(String(sessionId || ''));
}

export function sessionsDirFor(root) {
  return path.join(root, 'sessions');
}

// ─── Launch records ─────────────────────────────────────────────────

export async function writeLaunchRecord({
  root, sessionId, profileDir, debugPort, witnessPort, pid, extensionCopyDir,
  now = () => new Date(),
}) {
  if (!isValidSessionId(sessionId)) throw new Error(`非法会话标识：${sessionId}`);
  const dir = sessionsDirFor(root);
  await fsp.mkdir(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    tool: 'provider-live-acceptance',
    sessionId,
    profileDir,
    debugPort,
    witnessPort,
    pid,
    extensionCopyDir,
    createdAt: now().toISOString(),
  };
  const file = path.join(dir, `${sessionId}.json`);
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { file, record };
}

export async function readLaunchRecord({ root, sessionId }) {
  if (!isValidSessionId(sessionId)) return null;
  try {
    const raw = await fsp.readFile(path.join(sessionsDirFor(root), `${sessionId}.json`), 'utf8');
    const record = JSON.parse(raw);
    return record?.sessionId === sessionId ? record : null;
  } catch {
    return null;
  }
}

export async function findNewestLaunchRecord({ root, maxAgeMs = SESSION_MAX_AGE_MS, now = () => new Date() }) {
  let entries = [];
  try {
    entries = await fsp.readdir(sessionsDirFor(root));
  } catch {
    return null;
  }
  const records = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const sessionId = name.slice(0, -'.json'.length);
    const record = await readLaunchRecord({ root, sessionId });
    if (record) records.push(record);
  }
  const fresh = records.filter((record) => now().getTime() - Date.parse(record.createdAt) <= maxAgeMs);
  fresh.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return fresh[0] || null;
}

/** Pure-ish structural validation. Every check is reported so the refusal
 *  reason names exactly which proof is missing. */
export async function validateLaunchRecord(record, {
  root, platform = process.platform, home, maxAgeMs = SESSION_MAX_AGE_MS,
  now = () => new Date(), existsSync = fs.existsSync, readFileSync = fs.readFileSync,
  isPidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
}) {
  const checks = {};
  const fail = (reason) => ({ ok: false, reason, checks });
  if (!record || !isValidSessionId(record.sessionId)) return fail('会话记录缺失或会话标识非法');
  if (typeof record.profileDir !== 'string' || typeof record.extensionCopyDir !== 'string') {
    return fail('会话记录字段不完整');
  }
  try {
    assertSafeProfileDir({ root, dir: record.profileDir, platform, home });
    checks.profileInsideRoot = true;
  } catch (error) {
    checks.profileInsideRoot = false;
    return fail(`会话记录的 profile 目录未通过隔离校验：${error.message}`);
  }
  if (!Number.isInteger(record.debugPort) || record.debugPort < 1024 || record.debugPort > 65535) {
    return fail('会话记录的调试端口非法');
  }
  const ageMs = now().getTime() - Date.parse(record.createdAt);
  if (!(ageMs >= 0 && ageMs <= maxAgeMs)) {
    return fail(`会话记录已过期（创建于 ${record.createdAt}，上限 ${Math.round(maxAgeMs / 3600000)} 小时）`);
  }
  if (!existsSync(path.join(record.extensionCopyDir, 'manifest.json'))) {
    return fail(`会话的验收扩展副本缺失：${record.extensionCopyDir}`);
  }
  const patchedBackground = path.join(record.extensionCopyDir, 'dist', 'background.js');
  if (!existsSync(patchedBackground)) {
    return fail(`验收扩展副本缺少 dist/background.js：${patchedBackground}`);
  }
  let backgroundSource = '';
  try {
    backgroundSource = readFileSync(patchedBackground, 'utf8');
  } catch {
    return fail(`无法读取验收扩展副本的 background.js：${patchedBackground}`);
  }
  if (!backgroundSource.includes(record.sessionId) || !backgroundSource.includes('reportAcceptance')) {
    return fail('验收扩展副本未包含本会话的补丁标记——副本可能被替换或未打补丁');
  }
  checks.pidAlive = isPidAlive(record.pid);
  return { ok: true, checks, record };
}

// ─── Patched extension copy ─────────────────────────────────────────

const PATCH_ANCHORS = {
  hello: "            protocol: 'atomic-v2',\n        }));",
  authOk: "        if (msg?.type === 'auth-ok')\n            return; // handshake ack — not a command",
  keepalive: "                ws.send(JSON.stringify({ type: 'keepalive', ts: Date.now() }));",
};

function acceptancePrelude(sessionId, witnessPort) {
  return [
    '// OKIT provider live-acceptance session build (generated; do not edit).',
    `globalThis.__OKIT_ACCEPTANCE__ = { sessionId: ${JSON.stringify(sessionId)}, witness: ${JSON.stringify(`http://127.0.0.1:${witnessPort}/acceptance`)} };`,
    'async function reportAcceptance(kind) {',
    '    try {',
    '        const cfg = globalThis.__OKIT_ACCEPTANCE__;',
    '        if (!cfg) return;',
    '        await fetch(cfg.witness, {',
    '            method: \'POST\',',
    '            headers: { \'content-type\': \'application/json\' },',
    '            body: JSON.stringify({ type: kind, sessionId: cfg.sessionId, wsUrl: ws?.url || null, wsState: ws?.readyState ?? null, ts: Date.now() }),',
    '        });',
    '    }',
    '    catch { /* witness offline is fine */ }',
    '}',
    '',
  ].join('\n');
}

/** Applies the three one-shot patches to a copied background.js source.
 *  Exported for tests; every anchor must occur exactly once or we fail
 *  closed — a rebuilt/reformatted extension must never load half-patched. */
export function patchExtensionBackgroundSource(source, { sessionId, witnessPort }) {
  if (!source || typeof source !== 'string') throw new Error('background.js 源码缺失');
  if (source.includes('reportAcceptance')) throw new Error('background.js 已包含验收补丁（不得重复打补丁）');
  const counts = Object.fromEntries(Object.entries(PATCH_ANCHORS).map(([name, anchor]) => {
    const count = source.split(anchor).length - 1;
    return [name, count];
  }));
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 1) {
      throw new Error(`验收补丁锚点 ${name} 出现 ${count} 次（要求恰好 1 次）——扩展产物格式已变化，拒绝加载半补丁副本`);
    }
  }
  let patched = `${acceptancePrelude(sessionId, witnessPort)}\n${source}`;
  patched = patched.replace(PATCH_ANCHORS.hello,
    "            protocol: 'atomic-v2',\n            acceptanceSession: globalThis.__OKIT_ACCEPTANCE__.sessionId,\n        }));");
  patched = patched.replace(PATCH_ANCHORS.authOk,
    '        if (msg?.type === \'auth-ok\') {\n            void reportAcceptance(\'acceptance-hello\');\n            return; // handshake ack — not a command\n        }');
  patched = patched.replace(PATCH_ANCHORS.keepalive,
    `${PATCH_ANCHORS.keepalive}\n                void reportAcceptance('acceptance-heartbeat');`);
  return { patched, counts };
}

async function copyDirEntries(src, dest, entries) {
  for (const entry of entries) {
    await fsp.cp(path.join(src, entry), path.join(dest, entry), { recursive: true, force: true });
  }
}

/** Materialize a patched acceptance copy of the product extension. Copies
 *  only runtime files (manifest, icons, dist, html) — never node_modules or
 *  sources — then applies the session patches. */
export async function buildAcceptanceExtensionCopy({
  sourceDir, destDir, sessionId, witnessPort = DEFAULT_WITNESS_PORT, now = () => new Date(),
}) {
  if (!isValidSessionId(sessionId)) throw new Error(`非法会话标识：${sessionId}`);
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new Error(`扩展源目录缺少 manifest.json：${sourceDir}`);
  }
  if (!fs.existsSync(path.join(sourceDir, 'dist', 'background.js'))) {
    throw new Error(`扩展源目录缺少 dist/background.js（构建产物被 git 忽略，先运行 npm run build-extension）：${sourceDir}`);
  }
  await fsp.mkdir(destDir, { recursive: true });
  const topEntries = await fsp.readdir(sourceDir);
  const copyList = topEntries.filter((entry) => (
    entry === 'manifest.json' || entry === 'icons' || entry === 'dist' || /\.html$/.test(entry)
  ));
  await copyDirEntries(sourceDir, destDir, copyList);
  const backgroundPath = path.join(destDir, 'dist', 'background.js');
  const original = await fsp.readFile(backgroundPath, 'utf8');
  const { patched, counts } = patchExtensionBackgroundSource(original, { sessionId, witnessPort });
  await fsp.writeFile(backgroundPath, patched, 'utf8');
  const marker = {
    schemaVersion: 1,
    kind: 'provider-live-acceptance-extension-copy',
    sessionId,
    witnessPort,
    createdAt: now().toISOString(),
    patched: counts,
  };
  await fsp.writeFile(path.join(destDir, 'OKIT_ACCEPTANCE_SESSION.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return { copyDir: destDir, patched: counts, marker };
}

// ─── Witness service ────────────────────────────────────────────────

const MAX_REPORT_BODY = 4096;

/** Minimal localhost HTTP witness. Accepts POST /acceptance* reports from the
 *  patched extension and keeps the latest report per session (plus a small
 *  ring buffer). Everything else 404s. */
export function createWitness({
  port = 0, host = '127.0.0.1', httpImpl = http, now = () => Date.now(),
} = {}) {
  const latest = new Map(); // sessionId -> report (with receivedAt from our clock)
  const ring = [];
  const server = httpImpl.createServer((req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/acceptance')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > MAX_REPORT_BODY) {
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const report = JSON.parse(body || '{}');
        if (typeof report.sessionId === 'string' && report.sessionId.length <= 64) {
          const stored = { ...report, receivedAt: now() };
          latest.set(report.sessionId, stored);
          ring.push(stored);
          if (ring.length > 32) ring.shift();
        }
      } catch {
        // malformed reports are ignored
      }
      res.writeHead(204).end();
    });
  });
  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return { port: server.address().port };
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
    lastReport(sessionId) {
      return latest.get(sessionId) || null;
    },
    recentReports() {
      return [...ring];
    },
  };
}

export function parsePortFromWsUrl(wsUrl) {
  const match = /:\/\/[^/:]+:(\d+)(?:\/|$)/.exec(String(wsUrl || ''));
  return match ? Number(match[1]) : null;
}

/** Wait for a report that proves the patched extension of THIS session is
 *  currently connected (wsState OPEN) to the expected server port, and was
 *  received within the freshness window. Returns null on timeout. */
export async function awaitFreshWitnessReport({
  witness, sessionId, expectWsPort, maxWaitMs = 45000, pollMs = 500,
  freshnessMs = 15000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + maxWaitMs;
  for (;;) {
    const report = witness.lastReport(sessionId);
    if (report) {
      const fresh = now() - report.receivedAt <= freshnessMs;
      const open = report.wsState === 1;
      const port = parsePortFromWsUrl(report.wsUrl);
      if (fresh && open && port === expectWsPort) return report;
    }
    if (now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
