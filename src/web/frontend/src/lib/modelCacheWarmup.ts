type Listener = () => void;

let pending = false;
let started = false;
let inflight: Promise<unknown> | null = null;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

export function isModelCacheWarmupPending() {
  return pending;
}

export function subscribeModelCacheWarmup(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * One renderer lifetime owns one startup warmup request. Keeping this outside
 * App prevents route remounts and SSE-driven refreshes from issuing a second
 * discovery batch while the original request is still in flight.
 */
export function startModelCacheWarmup(request: () => Promise<unknown>) {
  if (inflight) return inflight;
  if (started) return Promise.resolve();
  started = true;
  pending = true;
  notify();
  inflight = Promise.resolve()
    .then(request)
    .catch(() => undefined)
    .finally(() => {
      pending = false;
      inflight = null;
      notify();
    });
  return inflight;
}

export function __resetModelCacheWarmupForTests() {
  pending = false;
  started = false;
  inflight = null;
  listeners.clear();
}
