// Local UI data-change stream. This is intentionally separate from the
// Chrome-extension WebSocket, whose origin and token checks do not apply to
// the same-origin desktop UI.
const clients = new Set();
let pendingSections = new Set();
let flushTimer = null;

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function flushPending() {
  flushTimer = null;
  if (pendingSections.size === 0) return;
  const data = { type: 'data-changed', sections: [...pendingSections] };
  pendingSections = new Set();
  for (const res of [...clients]) {
    try { writeEvent(res, 'data-changed', data); } catch { clients.delete(res); }
  }
}

// Coalesce a sync pull's many writes (or a burst of UI mutations) into one
// event. Consumers only need to re-fetch their current read model once.
function publishDataChanged(sections) {
  for (const section of sections || []) pendingSections.add(section);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushPending, 300);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function subscribeUiEvents(req, res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  clients.add(res);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { cleanup(); }
  }, 25_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  req.on('close', cleanup);
}

module.exports = { subscribeUiEvents, publishDataChanged };
