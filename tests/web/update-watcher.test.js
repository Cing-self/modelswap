import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The watcher keeps module-level state (etag, cache, baseline). Reset modules
// before each case so tests are order-independent and hermetic.
let mod;
function load() {
  vi.resetModules();
  return import('../../src/web/api/update-check.js');
}

const INTERVAL = 15 * 60 * 1000;
const CAP = 2 * 60 * 60 * 1000;

function githubResponse({ status = 200, tag, etag } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'etag' ? etag ?? null : null) },
    json: async () => ({ tag_name: tag, html_url: 'https://x', published_at: null, assets: [] }),
  };
}

/**
 * Fixed-convention harness: random() = 0, so the startup phase timer fires at
 * t≈0 and `advance(1)` performs the BASELINE tick; every later
 * `advance(INTERVAL)` performs exactly one steady-state tick.
 */
function makeHarness(mod, { responses, currentVersion = '1.0.37', random = () => 0 } = {}) {
  const requests = [];
  const published = [];
  const warnings = [];
  let cursor = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init?.headers || {} });
    const item = responses[Math.min(cursor++, responses.length - 1)];
    const resolved = typeof item === 'function' ? item(requests.length) : item;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  const started = mod.startUpdateWatcher({
    fetchImpl,
    now: () => Date.now(),
    random,
    intervalMs: INTERVAL,
    publish: (sections) => published.push(sections),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    currentVersion: () => currentVersion,
  });
  return { started, requests, published, warnings, fetchImpl };
}

const baselineTick = () => vi.advanceTimersByTimeAsync(1);
const nextTick = () => vi.advanceTimersByTimeAsync(INTERVAL);

describe('update watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return load().then((m) => { mod = m; });
  });
  afterEach(() => {
    mod?.stopUpdateWatcher?.();
    vi.useRealTimers();
  });

  it('randomizes only the startup phase and baselines the first result without broadcasting', async () => {
    const h = makeHarness(mod, {
      responses: [githubResponse({ tag: 'v1.0.37', etag: 'W/"a"' })],
      random: () => 0.5,
    });
    expect(h.started).toBe(true);

    // Half the interval: the randomized phase. Nothing fires before it.
    await vi.advanceTimersByTimeAsync(INTERVAL / 2 - 1);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);

    // First result (even one equal to the running version) is baseline only.
    expect(h.published).toHaveLength(0);

    // Steady state is a FIXED interval — no per-round jitter.
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(2);
    expect(h.published).toHaveLength(0);
  });

  it('broadcasts update-available exactly once when a newer tag appears', async () => {
    let tag = 'v1.0.37';
    const h = makeHarness(mod, { responses: [() => githubResponse({ tag, etag: 'W/"a"' })] });
    await baselineTick(); // baseline v1.0.37
    expect(h.published).toHaveLength(0);

    tag = 'v1.0.38';
    await nextTick(); // observed change
    expect(h.published).toEqual([['update-available']]);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3); // unchanged afterwards
    expect(h.published).toHaveLength(1);
  });

  it('does not broadcast a changed tag that is not newer, but still tracks it', async () => {
    let tag = 'v1.0.37';
    const h = makeHarness(mod, { responses: [() => githubResponse({ tag })] });
    await baselineTick(); // baseline v1.0.37

    tag = 'v1.0.36'; // changed but LOWER than the running version
    await nextTick();
    expect(h.published).toHaveLength(0);

    tag = 'v1.0.39'; // a genuinely newer release after the dip
    await nextTick();
    expect(h.published).toEqual([['update-available']]);
  });

  it('stores the etag, sends If-None-Match, and stays silent on 304', async () => {
    let status = 200;
    let etag = 'W/"a"';
    const h = makeHarness(mod, {
      responses: [() => githubResponse({ status, tag: 'v1.0.37', etag })],
    });
    await baselineTick();
    expect(h.requests[0].headers['If-None-Match']).toBeUndefined();

    status = 304; // GitHub 304 keeps the SAME etag — nothing changed at all
    await nextTick();
    expect(h.requests[1].headers['If-None-Match']).toBe('W/"a"');
    expect(h.published).toHaveLength(0);

    status = 200; etag = 'W/"c"'; // a changed release arrives with a new etag
    await nextTick();
    expect(h.requests[2].headers['If-None-Match']).toBe('W/"a"'); // old etag sent
    await nextTick();
    expect(h.requests[3].headers['If-None-Match']).toBe('W/"c"'); // refreshed
    expect(h.published).toHaveLength(0); // v1.0.37 is not newer than itself
  });

  it('warns on network failure, keeps the old data, and keeps ticking', async () => {
    let fail = false;
    let tag = 'v1.0.37';
    const h = makeHarness(mod, {
      responses: [() => (fail ? new Error('boom') : githubResponse({ tag }))],
    });
    await baselineTick(); // baseline ok

    fail = true;
    await nextTick();
    expect(h.warnings.join('\n')).toContain('boom');
    expect(h.published).toHaveLength(0);

    fail = false;
    tag = 'v1.0.38';
    await nextTick(); // watcher survived the failure
    expect(h.published).toEqual([['update-available']]);
  });

  it('backs off exponentially on 403/429 up to the 2h cap and recovers on success', async () => {
    let status = 200;
    let tag = 'v1.0.37';
    const h = makeHarness(mod, {
      responses: [() => githubResponse({ status, tag })],
    });
    await baselineTick();
    expect(h.requests).toHaveLength(1);

    status = 403;
    await nextTick(); // first rate-limited hit → backoff 2× = 30 min
    expect(h.requests).toHaveLength(2);
    expect(h.warnings.join('\n')).toContain('rate-limited');

    status = 429; // 429 counts the same as 403 → backoff 4× = 60 min
    await nextTick(); // 15 min into the 30-min backoff: nothing yet
    expect(h.requests).toHaveLength(2);
    await nextTick(); // 30 min reached → second hit
    expect(h.requests).toHaveLength(3);

    status = 403; // third hit → backoff caps at 2h (not 4h)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(CAP - INTERVAL); // inside the capped wait
    expect(h.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(INTERVAL); // capped delay elapsed → fourth hit
    expect(h.requests).toHaveLength(5);

    // Quota recovers → success after one more capped wait, and the new
    // version broadcasts; the cadence then returns to the fixed interval.
    status = 200;
    tag = 'v1.0.38';
    await vi.advanceTimersByTimeAsync(CAP);
    expect(h.requests).toHaveLength(6);
    expect(h.published).toEqual([['update-available']]);
  });

  it('a 304 right after stop/start re-baselines from the cache so the next new tag broadcasts exactly once', async () => {
    // QA P0-1 exact sequence: 200 (baseline v1.0.37 + etag) → stop → start →
    // 304 (release unchanged, etag survived the restart) → 200 v1.0.38.
    let status = 200;
    let tag = 'v1.0.37';
    let etag = 'W/"a"';
    const h = makeHarness(mod, {
      responses: [() => githubResponse({ status, tag, etag })],
    });
    await baselineTick(); // 1. first tick: 200, baseline v1.0.37, etag stored
    expect(h.requests).toHaveLength(1);
    expect(h.published).toHaveLength(0);

    mod.stopUpdateWatcher(); // 2.
    mod.startUpdateWatcher({ // 3. restart: hasBaseline resets, latestEtag survives
      fetchImpl: h.fetchImpl,
      now: () => Date.now(),
      random: () => 0,
      intervalMs: INTERVAL,
      publish: (sections) => h.published.push(sections),
      logger: { warn: () => {} },
      currentVersion: () => '1.0.37',
    });

    status = 304; // 4. first restart tick: unchanged release → 304
    await baselineTick();
    expect(h.requests).toHaveLength(2);
    expect(h.published).toHaveLength(0); // no broadcast for the existing release

    status = 200; tag = 'v1.0.38'; etag = 'W/"b"'; // 5. the new release lands
    await nextTick();
    expect(h.published).toEqual([['update-available']]); // EXACTLY once

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(h.published).toHaveLength(1);
  });

  it('start is idempotent, stop halts scheduling, and a restart re-baselines', async () => {
    const h = makeHarness(mod, {
      responses: [githubResponse({ tag: 'v1.0.38' })], // newer than running 1.0.37
    });
    expect(mod.startUpdateWatcher({ fetchImpl: h.fetchImpl })).toBe(false); // already running

    await baselineTick();
    expect(h.requests).toHaveLength(1);
    expect(h.published).toHaveLength(0); // baseline, even though newer

    expect(mod.stopUpdateWatcher()).toBe(true);
    expect(mod.stopUpdateWatcher()).toBe(false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(h.requests).toHaveLength(1); // stopped: no further requests

    // Restart re-baselines: the still-newer v1.0.38 must not broadcast.
    mod.startUpdateWatcher({
      fetchImpl: h.fetchImpl,
      now: () => Date.now(),
      random: () => 0,
      intervalMs: INTERVAL,
      publish: (sections) => h.published.push(sections),
      logger: { warn: () => {} },
      currentVersion: () => '1.0.37',
    });
    await baselineTick();
    expect(h.requests).toHaveLength(2);
    expect(h.published).toHaveLength(0);
  });
});
