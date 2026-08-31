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
const { normalizedReleaseNotes } = require('../../application/release-notes');

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
    publishedAt: release.published_at || null,
    assets: (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
  cache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// Update watcher: keeps a long-running desktop app aware of new releases.
//
// A fixed 15-minute cadence (only the startup PHASE is randomized, so a fleet
// of instances never synchronizes on one boundary) refreshes the latest
// release, bypassing the endpoint's 60s cache. GitHub rate limits (403/429)
// switch to exponential backoff capped at 2h; network failures only warn and
// keep the previous data. Each successful refresh stores the response ETag
// and the next request sends If-None-Match, so an unchanged release costs a
// bodyless 304 instead of quota. The FIRST result only establishes a
// baseline; afterwards a tag that differs from the already-seen one AND is
// newer than the running version publishes 'update-available' over the SSE
// event stream exactly once per change.
const WATCH_INTERVAL_MS = 15 * 60 * 1000;
const WATCH_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000;
let latestEtag = null;
const watcher = { started: false, timer: null, deps: null, hasBaseline: false, lastSeenTag: null, backoffMs: null };

function defaultWatcherDeps() {
  return {
    fetchImpl: (url, init) => fetch(url, init),
    now: () => Date.now(),
    random: Math.random,
    intervalMs: WATCH_INTERVAL_MS,
    publish: (sections) => require('./ui-events').publishDataChanged(sections),
    logger: console,
    currentVersion: () => require('../../../package.json').version,
  };
}

function watcherSchedule(deps, delayMs) {
  watcher.timer = setTimeout(() => { void watcherTick(deps); }, delayMs);
  watcher.timer.unref?.();
}

async function watcherTick(deps) {
  let nextDelayMs = deps.intervalMs;
  try {
    const headers = githubHeaders();
    if (latestEtag) headers['If-None-Match'] = latestEtag;
    const res = await deps.fetchImpl(LATEST_URL, { headers });
    if (res.status === 304) {
      // Unchanged release: keep cache and baseline as-is. A 304 still proves
      // the quota is fine, so any pending backoff is released.
      watcher.backoffMs = null;
      // A 304 after a restart is a valid observation: the etag (and the
      // shared cache) survived the restart but the baseline flag did not.
      // Re-establish the baseline from the cached release so the NEXT new
      // tag is detected — otherwise it would be swallowed as "first sight".
      // Baseline establishment never broadcasts for an existing release.
      if (!watcher.hasBaseline && cache.data) {
        watcher.hasBaseline = true;
        watcher.lastSeenTag = cache.data.none ? null : (cache.data.tag || null);
      }
    } else if (res.status === 403 || res.status === 429) {
      watcher.backoffMs = watcher.backoffMs
        ? Math.min(watcher.backoffMs * 2, WATCH_BACKOFF_CAP_MS)
        : deps.intervalMs * 2;
      nextDelayMs = watcher.backoffMs;
      deps.logger.warn(`[update-watcher] GitHub rate-limited (HTTP ${res.status}); next refresh in ${Math.round(nextDelayMs / 60000)} min`);
    } else if (res.status === 404) {
      // No releases published: a valid, empty result — baseline it.
      watcher.backoffMs = null;
      if (!watcher.hasBaseline) watcher.hasBaseline = true;
      watcher.lastSeenTag = null;
    } else if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`);
    } else {
      watcher.backoffMs = null;
      const release = await res.json();
      latestEtag = res.headers.get('etag') || latestEtag;
      const data = {
        tag: release.tag_name || '',
        htmlUrl: release.html_url || '',
        publishedAt: release.published_at || null,
        assets: (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      };
      // Share the fresh result with /api/update-check so the UI's follow-up
      // check after the SSE event hits a warm, consistent cache.
      cache = { at: deps.now(), data };
      const tag = data.tag || null;
      if (!watcher.hasBaseline) {
        watcher.hasBaseline = true;
        watcher.lastSeenTag = tag;
      } else if (tag !== watcher.lastSeenTag) {
        watcher.lastSeenTag = tag;
        if (tag && compareVersions(tag, deps.currentVersion()) > 0) {
          deps.publish(['update-available']);
        }
      }
    }
  } catch (error) {
    // Transient network failure: warn, keep the previous data and baseline,
    // and retry on the normal cadence.
    deps.logger.warn(`[update-watcher] latest-release refresh failed: ${error.message}`);
  }
  if (watcher.started) watcherSchedule(deps, nextDelayMs);
}

/**
 * Start the periodic latest-release watcher. Idempotent: a second call while
 * running returns false and schedules nothing extra. Dependency injection is
 * for tests only (time, randomness, HTTP, publishing, logging).
 */
function startUpdateWatcher(deps = {}) {
  if (watcher.started) return false;
  const merged = { ...defaultWatcherDeps(), ...deps };
  watcher.started = true;
  watcher.deps = merged;
  watcher.hasBaseline = false;
  watcher.lastSeenTag = null;
  watcher.backoffMs = null;
  // Random startup phase only — the steady-state cadence stays exactly one
  // interval so the "next 15-minute cycle" convergence bound holds.
  watcherSchedule(merged, Math.max(0, Math.floor(merged.random() * merged.intervalMs)));
  return true;
}

/** Stop the watcher and clear its timer. Returns false when not running. */
function stopUpdateWatcher() {
  if (!watcher.started) return false;
  watcher.started = false;
  if (watcher.timer) clearTimeout(watcher.timer);
  watcher.timer = null;
  return true;
}

async function fetchReleaseNotes(assets, tag) {
  const asset = assets.find(item => item.name === 'release-notes.json');
  if (!asset?.url || !asset.url.startsWith(ASSET_URL_PREFIX)) return null;
  try {
    const response = await fetch(asset.url, { headers: githubHeaders() });
    if (!response.ok) return null;
    return normalizedReleaseNotes(await response.json(), tag);
  } catch {
    // A release can still be installed when its optional structured notes
    // asset is unavailable; the UI presents a neutral missing-notes state.
    return null;
  }
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
    const releaseNotes = await fetchReleaseNotes(latest.assets, latest.tag);
    res.json({
      upToDate,
      currentVersion,
      latestVersion,
      tag: latest.tag,
      releaseUrl: latest.htmlUrl,
      publishedAt: releaseNotes?.publishedAt || latest.publishedAt,
      releaseNotes,
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

module.exports = { getUpdateCheck, downloadUpdate, getUpdateDownloadStatus, compareVersions, pickAssets, downloadTarget, fetchReleaseNotes, startUpdateWatcher, stopUpdateWatcher };
