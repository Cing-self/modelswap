// Auto-sync scheduler: debounced push after local changes, periodic pull check,
// and a startup pass (adopt remote first, then flush pending local changes).
// Gated per cycle by sync.autoSync + password + enabled platform from disk.
const core = require('./cloud-sync-core');

const PUSH_DEBOUNCE_MS = 10 * 1000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;
const MAX_PUSH_RETRIES = 3;
const RETRY_BACKOFF_MS = [10 * 1000, 30 * 1000, 60 * 1000];
const SECTIONS = ['secrets', 'agent', 'providers'];

let started = false;
let busy = false;
let pushTimer = null;
let pullTimer = null;
let startupTimer = null;

async function isEnabled() {
  const config = await core.loadConfig();
  const sync = config.sync || {};
  const platform = sync.platforms?.[sync.syncPlatform];
  return !!(sync.autoSync && sync.password && sync.syncPlatform && platform?.enabled);
}

// Serialize auto-push / auto-pull / manual push / manual pull. Returns
// { busy: true } instead of running when another operation is in flight.
async function runExclusive(action) {
  if (busy) return { busy: true };
  busy = true;
  try {
    return { busy: false, result: await action() };
  } catch (error) {
    return { busy: false, error };
  } finally {
    busy = false;
  }
}

function isBusy() {
  return busy;
}

async function persistLocalChanged(section) {
  const config = await core.loadConfig();
  config.sync = config.sync || {};
  config.sync.localChangedAt = {
    ...(config.sync.localChangedAt || {}),
    [section]: new Date().toISOString(),
  };
  await core.saveConfig(config);
}

// Called by mutation handlers after their own state is written.
function markDirty(section) {
  persistLocalChanged(section).catch(() => {});
  schedulePush();
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    autoPush().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
  if (typeof pushTimer.unref === 'function') pushTimer.unref();
}

async function autoPush(attempt = 1) {
  if (!(await isEnabled())) return { skipped: 'disabled' };

  const { busy: wasBusy, error, result } = await runExclusive(() => core.syncPush());
  if (wasBusy) {
    // A manual push/pull is running; retry after the debounce window.
    schedulePush();
    return { skipped: 'busy' };
  }
  if (error) {
    core.appendLog('auto-sync-push', 'scheduler', false, `attempt ${attempt}: ${error.message}`);
    if (attempt < MAX_PUSH_RETRIES) {
      const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      const timer = setTimeout(() => { autoPush(attempt + 1).catch(() => {}); }, delay);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return { error };
  }
  core.appendLog('auto-sync-push', 'scheduler', true, `${result.secrets} secrets`);
  return { result };
}

async function autoPullCheck() {
  if (!(await isEnabled())) return { skipped: 'disabled' };
  // Local changes go out first; pull again on the next cycle after they land.
  if (pushTimer) return { skipped: 'push-pending' };

  const { busy: wasBusy, error, result } = await runExclusive(async () => {
    const config = await core.loadConfig();
    const remote = await core.peekRemote();
    if (!remote) return { skipped: 'no-remote' };
    const last = config.sync?.lastRemote;
    if (last && remote.updatedAt === last.updatedAt && remote.machineId === last.machineId) {
      return { skipped: 'same-version' };
    }
    return { pulled: await core.syncPull() };
  });
  if (wasBusy) return { skipped: 'busy' };
  if (error) {
    core.appendLog('auto-sync-pull', 'scheduler', false, error.message);
    return { error };
  }
  if (result?.pulled) {
    core.appendLog('auto-sync-pull', 'scheduler', true,
      `+${result.pulled.added} ~${result.pulled.updated}`);
  }
  return result;
}

// Local sections changed since the last successful sync (also covers a pending
// debounce that died with the process). A null lastSyncAt means never synced:
// seed the remote baseline with a push.
function hasPendingLocalChanges(sync) {
  if (!sync.lastSyncAt) return true;
  return SECTIONS.some(s => (sync.localChangedAt?.[s] || '') > sync.lastSyncAt);
}

// Startup / enable-time pass: adopt remote state first (union merge, config
// guards protect newer local edits), then flush anything still pending.
async function syncNow() {
  if (!(await isEnabled())) return;
  await autoPullCheck();
  const config = await core.loadConfig();
  if (hasPendingLocalChanges(config.sync || {})) {
    await autoPush();
  }
}

function startAutoSync() {
  if (started) return;
  started = true;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    syncNow().catch(() => {});
  }, STARTUP_DELAY_MS);
  pullTimer = setInterval(() => { autoPullCheck().catch(() => {}); }, PULL_INTERVAL_MS);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();
  if (typeof pullTimer.unref === 'function') pullTimer.unref();
}

function stopAutoSync() {
  started = false;
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}

module.exports = { markDirty, runExclusive, isBusy, syncNow, startAutoSync, stopAutoSync, hasPendingLocalChanges };
