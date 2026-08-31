// Resumable auto-create lifecycle. Browser work is injected so state changes
// are independently testable and never depend on Express request objects.
function createAutoCreateRunService(deps) {
  const { randomId, now, setTimer, clearTimer, resultTtlMs, verificationTimeoutMs,
    extensionConnected, createBrowserKey, isAssetData, classifyLimit, detectLogin,
    focusBrowser, sleep, detectVerification } = deps;
  const runs = new Map();
  const stamp = () => now().toISOString();
  const expire = run => {
    clearTimer(run.expiryTimer);
    run.expiryTimer = setTimer(() => { if (runs.get(run.id) === run) runs.delete(run.id); }, resultTtlMs);
  };
  const mark = (run, status, details = {}) => {
    run.status = status;
    run.updatedAt = stamp();
    Object.assign(run, details);
    if (['succeeded', 'failed', 'login_required'].includes(status)) expire(run);
  };
  const create = ({ platformConfig, tokenName }) => {
    const run = { id: randomId(), platformConfig, platform: platformConfig.id,
      platformLabel: platformConfig.label || platformConfig.id, tokenName,
      status: 'running', createdAt: stamp(), updatedAt: stamp(), verification: null, resumeAvailable: false };
    runs.set(run.id, run);
    return run;
  };
  const serialize = run => {
    const base = { success: !['failed', 'login_required'].includes(run.status), runId: run.id,
      status: run.status, platform: run.platform, platformLabel: run.platformLabel };
    if (run.status === 'verification_required') return { ...base, pending: true, verificationRequired: true,
      browserFocused: Boolean(run.browserFocused), verification: run.verification };
    if (run.status === 'running') return { ...base, pending: true };
    if (run.status === 'succeeded') return { ...base, ...run.result };
    if (run.status === 'login_required') return { ...base, success: false, loginRequired: true,
      browserFocused: Boolean(run.browserFocused), loginUrl: run.loginUrl, error: run.error };
    return { ...base, success: false, ...(run.errorKind ? { errorKind: run.errorKind } : {}), error: run.error || '自动创建失败' };
  };
  const pauseForVerification = async ({ run, platform, stage }) => {
    if (!run) throw new Error(`${platform.label || platform.id} 当前页面停在安全验证/验证码，自动化未提交创建。请先完成官方验证后重试`);
    while (true) {
      let resolveResume; let rejectResume;
      const resumed = new Promise((resolve, reject) => { resolveResume = resolve; rejectResume = reject; });
      run.resumeResolve = resolveResume; run.resumeReject = rejectResume; run.resumeAvailable = true;
      run.verification = { stage, platformId: platform.id, platformLabel: platform.label || platform.id,
        message: `${platform.label || platform.id} 需要完成页面上的安全验证。请在自动化浏览器窗口完成验证后，回到 OKIT 点击“验证完成，继续”。` };
      mark(run, 'verification_required');
      run.browserFocused = await focusBrowser().catch(() => false);
      const timeout = setTimer(() => rejectResume(new Error(`${platform.label || platform.id} 安全验证等待超时，任务已停止；未提交新的密钥`)), verificationTimeoutMs);
      try { await resumed; } finally { clearTimer(timeout); run.resumeResolve = null; run.resumeReject = null; run.resumeAvailable = false; }
      mark(run, 'running', { verification: null });
      await sleep(400);
      if (!(await detectVerification(platform))) return;
    }
  };
  const execute = async run => {
    const platform = run.platformConfig;
    try {
      if (!extensionConnected()) throw new Error('OKIT 浏览器扩展未连接');
      const result = await createBrowserKey(platform, run.tokenName, run);
      if (isAssetData(result.value)) throw new Error('Extracted asset data, not API key.');
      mark(run, 'succeeded', { result: { value: result.value, name: result.name, platform: platform.id,
        ...(result.reusedExisting ? { reusedExisting: true, sourceKey: result.sourceKey } : {}),
        ...(platform.readyAfterMs ? { readyAfterMs: platform.readyAfterMs } : {}) }, error: null, verification: null });
    } catch (error) {
      const message = error?.message || String(error);
      if (/not connected|disconnected|timed out/i.test(message)) return mark(run, 'failed', { error: message });
      const limit = classifyLimit(message, platform.label || platform.id, platform.keyLimits);
      if (limit) return mark(run, 'failed', { error: limit, errorKind: 'platform_key_limit' });
      const login = await detectLogin(platform).catch(() => ({ loginRequired: false }));
      if (/login|sign in|未登录|需要登录|登录/i.test(message) || login.loginRequired) {
        const browserFocused = await focusBrowser().catch(() => false);
        return mark(run, 'login_required', { loginRequired: true, browserFocused, loginUrl: login.url || platform.url,
          error: browserFocused ? `需要登录 ${platform.label || platform.id}。已将自动化浏览器窗口置前，请完成登录后重新开始。` : `需要登录 ${platform.label || platform.id}。请在自动化浏览器窗口完成登录后重新开始。` });
      }
      mark(run, 'failed', { error: `${platform.id} auto-create failed: ${message}` });
    }
  };
  const status = id => {
    const run = runs.get(id);
    if (!run) throw Object.assign(new Error('自动创建任务不存在或已过期'), { status: 404 });
    return serialize(run);
  };
  const resume = id => {
    const run = runs.get(id);
    if (!run) throw Object.assign(new Error('自动创建任务不存在或已过期'), { status: 404 });
    if (run.status !== 'verification_required' || typeof run.resumeResolve !== 'function') throw Object.assign(new Error('当前任务没有等待验证码验证'), { status: 409 });
    run.resumeResolve();
    return { success: true, runId: run.id, status: 'running' };
  };
  return { create, execute, status, resume, pauseForVerification, serialize, runs };
}
module.exports = { createAutoCreateRunService };
