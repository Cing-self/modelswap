/**
 * Update check + guided download (Plan A).
 *
 * GET  /api/update-check    → compares the running version against the latest
 *                             GitHub Release and returns asset URLs.
 * POST /api/update-download → starts a streamed Release-asset download to
 *                             ~/Downloads; GET /api/update-download/:id
 *                             exposes its progress. URLs are restricted to
 *                             this repo's releases and macOS opens the DMG.
 *
 * Shared by the desktop app, the web console, and (via the same endpoint
 * semantics) the CLI — one source of truth for "what is the latest version".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { exec } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const GITHUB_REPO = 'Cing-self/okit';
const LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
// Only Release asset URLs from this repo may be downloaded — the endpoint must
// never become an arbitrary-URL downloader (SSRF).
const ASSET_URL_PREFIX = `https://github.com/${GITHUB_REPO}/releases/download/`;

// 60s memory cache — GitHub's anonymous API quota is 60 req/h per IP.
const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

// Downloads happen in the local server process so the installer can be saved
// and opened without browser download permissions. Keep small, short-lived job
// records so the UI can poll real byte progress rather than waiting on one
// long-lived HTTP request with no feedback.
const DOWNLOAD_JOB_TTL_MS = 10 * 60 * 1000;
const downloadJobs = new Map();

/** Numeric dotted-version compare (<0 / 0 / >0). */
function compareVersions(a, b) {
  const norm = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const va = norm(a);
  const vb = norm(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function githubHeaders() {
  const headers = { 'User-Agent': 'okit-update-check', Accept: 'application/vnd.github+json' };
  const token = process.env.OKIT_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchLatestRelease() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const res = await fetch(LATEST_URL, { headers: githubHeaders() });
  if (res.status === 404) return { none: true }; // no releases published yet
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const release = await res.json();
  const data = {
    tag: release.tag_name || '',
    htmlUrl: release.html_url || '',
    assets: (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
  cache = { at: Date.now(), data };
  return data;
}

function pickAssets(assets) {
  const find = (pred) => assets.find(pred) || null;
  return {
    // Desktop installer (arm64 dmg built by electron-builder in CI).
    dmg: find((a) => a.name.endsWith('.dmg')),
  };
}

function downloadTarget(url) {
  if (typeof url !== 'string' || !url.startsWith(ASSET_URL_PREFIX)) {
    throw new Error('仅允许下载本仓库 Release 资产');
  }
  const fileName = path.basename(new URL(url).pathname); // basename = no traversal
  if (!/^[\w.-]+$/.test(fileName)) {
    throw new Error(`非法资产名: ${fileName}`);
  }
  return { fileName, dest: path.join(os.homedir(), 'Downloads', fileName) };
}

function publicDownloadJob(job) {
  return {
    id: job.id,
    status: job.status,
    received: job.received,
    total: job.total,
    error: job.error,
    path: job.status === 'completed' ? job.dest : undefined,
    opened: job.status === 'completed' ? job.opened : undefined,
  };
}

function expireDownloadJob(id) {
  const timer = setTimeout(() => downloadJobs.delete(id), DOWNLOAD_JOB_TTL_MS);
  timer.unref?.();
}

async function runDownload(job) {
  const tempPath = `${job.dest}.part-${job.id}`;
  try {
    job.status = 'downloading';
    const dl = await fetch(job.url, { headers: { 'User-Agent': 'okit-update-check' } });
    if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
    if (!dl.body) throw new Error('下载响应没有文件内容');

    const contentLength = Number(dl.headers.get('content-length'));
    job.total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        job.received += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(dl.body), progress, fs.createWriteStream(tempPath));
    fs.renameSync(tempPath, job.dest);

    job.status = 'completed';
    job.opened = process.platform === 'darwin' && job.openInstaller !== false;
    if (job.opened) {
      exec(`open ${JSON.stringify(job.dest)}`, () => { /* opener failures don't change download success */ });
    }
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort temporary-file cleanup */ }
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    expireDownloadJob(job.id);
  }
}

async function getUpdateCheck(req, res) {
  try {
    // From src/web/api (or dist/web/api) the package root is three levels up.
    const currentVersion = require('../../../package.json').version;
    const latest = await fetchLatestRelease();
    if (latest.none) {
      return res.json({ upToDate: true, currentVersion, latestVersion: null, reason: 'no-releases' });
    }
    const latestVersion = String(latest.tag || '').replace(/^v/, '');
    const upToDate = !latestVersion || compareVersions(latestVersion, currentVersion) <= 0;
    res.json({
      upToDate,
      currentVersion,
      latestVersion,
      tag: latest.tag,
      releaseUrl: latest.htmlUrl,
      assets: pickAssets(latest.assets),
    });
  } catch (error) {
    res.status(502).json({ error: `更新检查失败: ${error.message}` });
  }
}

/**
 * Start a whitelisted Release-asset download. The caller polls the job status
 * so a slow network never holds its request open or hides progress.
 */
async function downloadUpdate(req, res) {
  try {
    const { url, open = true } = req.body || {};
    const { fileName, dest } = downloadTarget(url);
    // The desktop app installs silently (mount → swap → relaunch), so it asks
    // us NOT to pop the DMG drag-window — that affordance is for browser
    // consoles where no in-app installer exists.
    const job = { id: randomUUID(), url, fileName, dest, status: 'queued', received: 0, total: null, error: null, opened: false, openInstaller: open !== false };
    downloadJobs.set(job.id, job);
    void runDownload(job);
    res.status(202).json(publicDownloadJob(job));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === '仅允许下载本仓库 Release 资产' ? 403 : 400;
    res.status(status).json({ error: message });
  }
}

function getUpdateDownloadStatus(req, res) {
  const job = downloadJobs.get(req.params.downloadId);
  if (!job) return res.status(404).json({ error: '下载任务不存在或已过期' });
  res.json(publicDownloadJob(job));
}

module.exports = { getUpdateCheck, downloadUpdate, getUpdateDownloadStatus, compareVersions, pickAssets, downloadTarget };
