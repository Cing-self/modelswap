// Google AI Studio key lifecycle via the official gcloud CLI.
//
// gcloud offers GA commands to create/delete GCP API keys restricted to the
// Gemini API (generativelanguage.googleapis.com); the free tier needs no
// billing account. Subprocess execution is injected for testability — the
// same pattern the Cloudflare service uses for its https transport.
//
// Structured error codes let the UI branch without string matching:
//   GCLOUD_NOT_INSTALLED / GCLOUD_NOT_AUTHED / GCLOUD_PROJECT_FAILED /
//   GCLOUD_API_ENABLE_FAILED / GCLOUD_CREATE_FAILED / GCLOUD_DELETE_FAILED

const GEMINI_SERVICE = 'generativelanguage.googleapis.com';
// Project preference order, learned from the 2026-09-03 POC: a freshly
// created no-billing project got auto-denied by Google's abuse heuristics
// within an hour (403 "Your project has been denied access"), while keys
// created in the account's EXISTING projects (incl. AI Studio's own
// gen-lang-client-*) kept working. So: reuse before create, and prefer the
// projects Google itself trusts most.
const PROJECT_PREFERRED_PATTERN = /gen-lang|modelswap|gemini|aicore/i;
const RUN_TIMEOUT_MS = 90_000;

function createGcloudKeyService({ execFile, fetchJson }) {
  const env = { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };

  function run(args, opts = {}) {
    return new Promise((resolve) => {
      execFile('gcloud', args, { env, encoding: 'utf-8', timeout: RUN_TIMEOUT_MS, ...opts }, (error, stdout, stderr) => {
        // gcloud prints progress to stderr; only stdout carries data.
        resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function version() {
    const r = await run(['--version']);
    if (!r.ok && (r.code === 127 || r.code === 'ENOENT' || /not found/i.test(r.stderr))) return null;
    if (!r.ok) return null;
    return r.stdout.trim();
  }

  async function activeAccount() {
    const r = await run(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
    if (!r.ok) return null;
    return r.stdout.trim() || null;
  }

  async function listProjects() {
    const r = await run(['projects', 'list', '--format=json']);
    if (!r.ok) return [];
    try {
      const rows = JSON.parse(r.stdout);
      return Array.isArray(rows) ? rows.filter((row) => row.projectId).map((row) => row.projectId) : [];
    } catch {
      return [];
    }
  }

  async function createProject(name) {
    const r = await run(['projects', 'create', name]);
    if (!r.ok) {
      throw fail('GCLOUD_PROJECT_FAILED', `创建 GCP 项目失败：${r.stderr.trim() || `exit ${r.code}`}（可用 gcloud projects create 手动创建后重试）`);
    }
    return name;
  }

  // Project candidates: existing AI-Studio-style / modelswap / gemini /
  // aicore projects first (Google trusts them), a freshly created project
  // only as the last resort — new no-billing projects are the ones Google
  // tends to auto-deny. Unrelated projects are never touched.
  async function resolveProjectCandidates() {
    const projects = await listProjects();
    const preferred = projects.filter((id) => PROJECT_PREFERRED_PATTERN.test(id));
    const suffix = Math.random().toString(36).slice(2, 8);
    return [...preferred, `@create:modelswap-gemini-${suffix}`];
  }

  async function resolveProject() {
    return (await resolveProjectCandidates())[0];
  }

  async function enableGeminiApi(project) {
    // Idempotent: enabling an already-enabled service succeeds.
    const r = await run(['services', 'enable', GEMINI_SERVICE, '--project', project]);
    if (!r.ok) {
      throw fail('GCLOUD_API_ENABLE_FAILED', `启用 Gemini API 失败：${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }

  // Verify a freshly created key with a minimal real generation. Listing
  // models alone is NOT enough — a denied project still lists models while
  // generation returns 403 (observed on the banned POC project).
  async function verifyKey(keyString) {
    if (!fetchJson) return { ok: true };
    try {
      const data = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=' + encodeURIComponent(keyString), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'OK' }] }] }),
        timeoutMs: 60_000,
      });
      return { ok: Boolean(data && data.candidates), error: data && data.error };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  }

  async function createKey({ tokenName }) {
    const gcloudVersion = await version();
    if (!gcloudVersion) {
      throw fail('GCLOUD_NOT_INSTALLED', '未检测到 gcloud CLI。请先安装：brew install --cask google-cloud-sdk（或使用官方 installer），安装后重试。');
    }
    const account = await activeAccount();
    if (!account) {
      throw fail('GCLOUD_NOT_AUTHED', 'gcloud 尚未登录。请在终端运行 gcloud auth login 完成 Google 账号授权（一次性，浏览器登录后长期有效），然后重试。');
    }
    const candidates = await resolveProjectCandidates();
    const failures = [];
    for (const candidate of candidates) {
      const project = candidate.startsWith('@create:') ? await createProject(candidate.slice('@create:'.length)) : candidate;
      try {
        await enableGeminiApi(project);
        const r = await run([
          'services', 'api-keys', 'create',
          `--display-name=${tokenName}`,
          `--api-target=service=${GEMINI_SERVICE}`,
          '--project', project,
          '--format=json',
        ]);
        if (!r.ok) {
          failures.push(`${project}: ${r.stderr.trim() || `exit ${r.code}`}`);
          continue;
        }
        let payload;
        try {
          payload = JSON.parse(r.stdout);
        } catch {
          failures.push(`${project}: gcloud 输出无法解析`);
          continue;
        }
        const keyString = payload.keyString || (payload.response && payload.response.keyString);
        if (!keyString || !/^AIza/.test(keyString)) {
          failures.push(`${project}: 未返回 AIza 明文 Key`);
          continue;
        }
        const verification = await verifyKey(keyString);
        if (!verification.ok) {
          // Most likely a project-level deny (fresh no-billing projects get
          // auto-flagged). Try the next candidate project instead.
          failures.push(`${project}: Key 验证失败（${(verification.error && (verification.error.status || verification.error.message)) || '未知'}）`);
          await deleteKey({ keyUid: (payload.name || payload.response?.name || '').split('/').pop(), project }).catch(() => {});
          continue;
        }
        return {
          value: keyString,
          name: (payload.displayName || (payload.response && payload.response.displayName)) || tokenName,
          // resource name like projects/p/locations/global/keys/<uid> — the uid is
          // what `api-keys delete` expects.
          id: ((payload.name || (payload.response && payload.response.name) || '')).split('/').pop() || payload.uid || '',
          project,
          account,
        };
      } catch (error) {
        failures.push(`${project}: ${error.message}`);
      }
    }
    throw fail('GCLOUD_CREATE_FAILED', `所有候选项目均创建失败：${failures.join('；')}。若为"project denied"：Google 会对全新且未绑定付款方式的项目的生成请求做自动限制，建议先在 AI Studio 网页生成一次 Key（会自动创建可信项目）后再用本功能复用该项目。`);
  }

  async function deleteKey({ keyUid, project }) {
    if (!keyUid || !project) {
      throw fail('GCLOUD_DELETE_FAILED', 'Google AI Studio 删除 Key 需要 keyUid 与 project。');
    }
    const r = await run(['services', 'api-keys', 'delete', keyUid, '--project', project]);
    if (!r.ok) {
      throw fail('GCLOUD_DELETE_FAILED', `删除 API Key 失败：${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return true;
  }

  // Probe for the UI: what step is the user missing?
  async function status() {
    const gcloudVersion = await version();
    if (!gcloudVersion) {
      return { installed: false, account: null, project: null, hint: 'install' };
    }
    const account = await activeAccount();
    if (!account) {
      return { installed: true, account: null, project: null, hint: 'login' };
    }
    const projects = await listProjects();
    const project = projects.find((id) => PROJECT_PREFERRED_PATTERN.test(id)) || projects[0] || null;
    return { installed: true, account, project, hint: 'ready' };
  }

  return { createKey, deleteKey, status };
}

module.exports = { createGcloudKeyService };
