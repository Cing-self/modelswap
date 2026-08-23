/**
 * Update check + guided download (Plan A).
 *
 * GET  /api/update-check    → compares the running version against the latest
 *                             GitHub Release and returns asset URLs.
 * POST /api/update-download → downloads a Release asset to ~/Downloads (URL
 *                             whitelisted to this repo's releases) and opens
 *                             it on macOS.
 *
 * Shared by the desktop app, the web console, and (via the same endpoint
 * semantics) the CLI — one source of truth for "what is the latest version".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const GITHUB_REPO = 'Cing-self/okit';
const LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
// Only Release asset URLs from this repo may be downloaded — the endpoint must
// never become an arbitrary-URL downloader (SSRF).
const ASSET_URL_PREFIX = `https://github.com/${GITHUB_REPO}/releases/download/`;

// 60s memory cache — GitHub's anonymous API quota is 60 req/h per IP.
const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

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
 * Stream a whitelisted Release asset to ~/Downloads and (macOS) open it.
 * Synchronous-by-nature: the frontend shows a loading state; dmg downloads
 * typically finish well within the request window on a local server.
 */
async function downloadUpdate(req, res) {
  try {
    const { url } = req.body || {};
    if (typeof url !== 'string' || !url.startsWith(ASSET_URL_PREFIX)) {
      return res.status(403).json({ error: '仅允许下载本仓库 Release 资产' });
    }
    const fileName = path.basename(new URL(url).pathname); // basename = no traversal
    if (!/^[\w.-]+$/.test(fileName)) {
      return res.status(400).json({ error: `非法资产名: ${fileName}` });
    }
    const dest = path.join(os.homedir(), 'Downloads', fileName);

    const dl = await fetch(url, { headers: { 'User-Agent': 'okit-update-check' } });
    if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
    const buffer = Buffer.from(await dl.arrayBuffer());
    fs.writeFileSync(dest, buffer);

    if (process.platform === 'darwin') {
      exec(`open ${JSON.stringify(dest)}`, () => { /* opener failures don't fail the download */ });
    }
    res.json({ success: true, path: dest, size: buffer.length, opened: process.platform === 'darwin' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = { getUpdateCheck, downloadUpdate, compareVersions, pickAssets };
