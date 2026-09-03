import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAutoCreatePlatforms } from '../../src/application/auto-create-platforms.js';
import { createGcloudKeyService } from '../../src/application/auto-create-gcloud-service.js';

// gcloud runs on the user's machine; CI runners never install it. All paths
// are exercised through a scripted fake execFile.
function fakeExec(script) {
  const fn = (cmd, args, opts, cb) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected gcloud call: ${args.join(' ')}`);
    if (step instanceof Error) return cb(step, '', step.message);
    const [stdout, stderr = ''] = Array.isArray(step) ? step : [step];
    cb(null, stdout, stderr);
  };
  return vi.fn(fn);
}

const PLATFORMS = createAutoCreatePlatforms({
  ZHIPU_URL: 'https://open.bigmodel.cn/usercenter/apikeys',
  VOLC_URL: 'https://console.volcengine.com/ark',
  VOLC_AGENT_PLAN_URL: 'https://console.volcengine.com/ark',
  MINIMAX_URL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
});

describe('google-aistudio 平台目录', () => {
  it('自动创建入口暂时下线：目录不注册 cli 条目', () => {
    // v1.0.57 起 google-aistudio 不再出现在自动创建目录（服务代码保留，
    // 恢复时重新加回 auto-create-platforms.js 条目即可）。
    expect(PLATFORMS.AUTO_CREATE_PLATFORM_MAP.get('google-aistudio')).toBeFalsy();
    expect(PLATFORMS.getBrowserPlatformUrl('google-aistudio')).toBeFalsy();
  });
});

describe('gcloud key service', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('未安装 gcloud → GCLOUD_NOT_INSTALLED（附安装指引）', async () => {
    const exec = fakeExec([new Error('not found')]);
    const svc = createGcloudKeyService({ execFile: exec });
    await expect(svc.createKey({ tokenName: 'modelswap' })).rejects.toMatchObject({
      code: 'GCLOUD_NOT_INSTALLED',
      message: expect.stringContaining('brew install --cask google-cloud-sdk'),
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('已安装但未登录 → GCLOUD_NOT_AUTHED（提示 gcloud auth login）', async () => {
    const exec = fakeExec([['Google Cloud SDK 583.0.0'], ['']]);
    const svc = createGcloudKeyService({ execFile: exec });
    await expect(svc.createKey({ tokenName: 'modelswap' })).rejects.toMatchObject({
      code: 'GCLOUD_NOT_AUTHED',
      message: expect.stringContaining('gcloud auth login'),
    });
  });

  it('登录但无匹配项目 → 新建 modelswap-gemini-* 项目后创建成功（含验证）', async () => {
    const created = [];
    const exec = vi.fn((cmd, args, opts, cb) => {
      const joined = args.join(' ');
      if (joined.startsWith('--version')) return cb(null, 'Google Cloud SDK 583.0.0\n');
      if (joined.startsWith('auth list')) return cb(null, 'user@example.com\n');
      if (joined.startsWith('projects list')) return cb(null, JSON.stringify([{ projectId: 'other-project' }]));
      if (joined.startsWith('projects create')) { created.push(args[args.length - 1]); return cb(null, ''); }
      if (joined.startsWith('services enable')) return cb(null, '');
      if (joined.startsWith('services api-keys create')) {
        return cb(null, JSON.stringify({
          response: {
            keyString: 'AIzaSyA-test-key-1234567890abcdefghijklmnop',
            displayName: 'modelswap',
            name: 'projects/modelswap-gemini-abc123/locations/global/keys/12345',
          },
        }));
      }
      if (joined.startsWith('services api-keys delete')) return cb(null, '');
      throw new Error('unexpected: ' + joined);
    });
    const verified = [];
    const svc = createGcloudKeyService({
      execFile: exec,
      fetchJson: async (url) => { verified.push(url); return { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }; },
    });
    const result = await svc.createKey({ tokenName: 'modelswap' });
    expect(created[0]).toMatch(/^modelswap-gemini-/);
    expect(result.value).toMatch(/^AIza/);
    expect(result.id).toBe('12345');
    expect(result.project).toBe(created[0]);
    // 建 key 后立即真实验证（generateContent，而非 models list）
    expect(verified[0]).toContain(':generateContent?key=');
    // api-keys create 必须带 --api-target 限定 Gemini API
    const createCall = exec.mock.calls.find(([, args]) => args.join(' ').startsWith('services api-keys create'));
    expect(createCall[1].join(' ')).toContain('--api-target=service=generativelanguage.googleapis.com');
  });

  it('验证失败（项目被拒）→ 删除坏 key 并换下一个候选项目重试成功', async () => {
    const deleted = [];
    const createCount = { n: 0 };
    const exec = vi.fn((cmd, args, opts, cb) => {
      const joined = args.join(' ');
      if (joined.startsWith('--version')) return cb(null, 'v');
      if (joined.startsWith('auth list')) return cb(null, 'user@example.com\n');
      if (joined.startsWith('projects list')) return cb(null, JSON.stringify([{ projectId: 'modelswap-fresh' }, { projectId: 'gen-lang-client-1' }, { projectId: 'unrelated-prod' }]));
      if (joined.startsWith('services enable')) return cb(null, '');
      if (joined.startsWith('services api-keys create')) {
        createCount.n += 1;
        const project = args[args.length - 2];
        const uid = createCount.n === 1 ? 'bad-1' : 'good-2';
        return cb(null, JSON.stringify({ response: {
          keyString: createCount.n === 1 ? 'AIzaSyBAD-key-0000000000000000000000000' : 'AIzaSyGOOD-key-111111111111111111111111',
          displayName: 'k',
          name: `projects/${project}/locations/global/keys/${uid}`,
        } }));
      }
      if (joined.startsWith('services api-keys delete')) { deleted.push(args[3]); return cb(null, ''); }
      throw new Error('unexpected: ' + joined);
    });
    const verifyResults = [{ error: { status: 'PERMISSION_DENIED', message: 'Your project has been denied access.' } }, { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }];
    const svc = createGcloudKeyService({
      execFile: exec,
      fetchJson: async () => verifyResults.shift(),
    });
    const result = await svc.createKey({ tokenName: 'k' });
    expect(result.project).toBe('gen-lang-client-1');
    expect(result.id).toBe('good-2');
    // 无关项目绝不被碰
    const touched = exec.mock.calls.filter(([, args]) => args.join(' ').includes('unrelated-prod'));
    expect(touched).toHaveLength(0);
    expect(deleted).toEqual(['bad-1']);
  });

  it('已有 modelswap/gemini 项目 → 复用不新建', async () => {
    let projectCreated = false;
    const exec = vi.fn((cmd, args, opts, cb) => {
      const joined = args.join(' ');
      if (joined.startsWith('--version')) return cb(null, 'v');
      if (joined.startsWith('auth list')) return cb(null, 'user@example.com\n');
      if (joined.startsWith('projects list')) return cb(null, JSON.stringify([{ projectId: 'gen-lang-client-123' }, { projectId: 'zzz' }]));
      if (joined.startsWith('projects create')) { projectCreated = true; return cb(null, ''); }
      if (joined.startsWith('services enable')) return cb(null, '');
      if (joined.startsWith('services api-keys create')) {
        return cb(null, JSON.stringify({ keyString: 'AIzaSyB-test', displayName: 'k', name: 'projects/gemini-test/locations/global/keys/99' }));
      }
      throw new Error('unexpected: ' + joined);
    });
    const svc = createGcloudKeyService({ execFile: exec });
    const result = await svc.createKey({ tokenName: 'k' });
    expect(projectCreated).toBe(false);
    expect(result.project).toBe('gen-lang-client-123');
  });

  it('deleteKey 用 uid + project 调 api-keys delete', async () => {
    const exec = vi.fn((_cmd, args, _opts, cb) => {
      expect(args.join(' ')).toBe('services api-keys delete 99 --project gemini-test');
      cb(null, '');
    });
    const svc = createGcloudKeyService({ execFile: exec });
    await expect(svc.deleteKey({ keyUid: '99', project: 'gemini-test' })).resolves.toBe(true);
    await expect(svc.deleteKey({})).rejects.toMatchObject({ code: 'GCLOUD_DELETE_FAILED' });
  });

  it('status：未安装/未登录/就绪 三态', async () => {
    const notInstalled = createGcloudKeyService({ execFile: fakeExec([new Error('enoent')]) });
    await expect(notInstalled.status()).resolves.toMatchObject({ installed: false, hint: 'install' });

    const notAuthed = createGcloudKeyService({ execFile: fakeExec([['v'], ['']]) });
    await expect(notAuthed.status()).resolves.toMatchObject({ installed: true, hint: 'login' });

    const ready = createGcloudKeyService({ execFile: fakeExec([['v'], ['user@example.com\n'], [JSON.stringify([{ projectId: 'gemini-test' }])]]) });
    await expect(ready.status()).resolves.toMatchObject({ installed: true, account: 'user@example.com', project: 'gemini-test', hint: 'ready' });
  });
});
