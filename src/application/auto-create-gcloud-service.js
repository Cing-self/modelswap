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
const PROJECT_PREFERRED_PATTERN = /modelswap|gemini|aicore/i;
const RUN_TIMEOUT_MS = 90_000;

function createGcloudKeyService({ execFile }) {
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

  async function resolveProject() {
    const projects = await listProjects();
    const preferred = projects.find((id) => PROJECT_PREFERRED_PATTERN.test(id));
    if (preferred) return preferred;
    const suffix = Math.random().toString(36).slice(2, 8);
    return createProject(`modelswap-gemini-${suffix}`);
  }

  async function enableGeminiApi(project) {
    // Idempotent: enabling an already-enabled service succeeds.
    const r = await run(['services', 'enable', GEMINI_SERVICE, '--project', project]);
    if (!r.ok) {
      throw fail('GCLOUD_API_ENABLE_FAILED', `启用 Gemini API 失败：${r.stderr.trim() || `exit ${r.code}`}`);
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
    const project = await resolveProject();
    await enableGeminiApi(project);

    const r = await run([
      'services', 'api-keys', 'create',
      `--display-name=${tokenName}`,
      `--api-target=service=${GEMINI_SERVICE}`,
      '--project', project,
      '--format=json',
    ]);
    if (!r.ok) {
      throw fail('GCLOUD_CREATE_FAILED', `创建 API Key 失败：${r.stderr.trim() || `exit ${r.code}`}`);
    }
    let payload;
    try {
      payload = JSON.parse(r.stdout);
    } catch {
      throw fail('GCLOUD_CREATE_FAILED', 'gcloud 创建命令的输出无法解析（预期 JSON）。');
    }
    const keyString = payload.keyString;
    if (!keyString || !/^AIza/.test(keyString)) {
      throw fail('GCLOUD_CREATE_FAILED', 'gcloud 未返回 AIza 开头的明文 Key；请改用 --show-key-string 手动确认。');
    }
    return {
      value: keyString,
      name: payload.displayName || tokenName,
      // resource name like projects/p/locations/global/keys/<uid> — the uid is
      // what `api-keys delete` expects.
      id: (payload.name || '').split('/').pop() || payload.uid || '',
      project,
      account,
    };
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
