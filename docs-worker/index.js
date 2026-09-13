// docs.modelswap.app worker — static manual + the in-app feedback endpoint.
// Asset requests fall through to env.ASSETS; /api/feedback creates a GitHub
// issue server-side so app users never need a GitHub account.
const GITHUB_REPO = 'Cing-self/modelswap';
const ISSUE_LABEL = 'from-app';

const RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 5 };
const hits = new Map(); // best-effort per-isolate rate limiting

function corsHeaders(origin) {
  const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    || origin === 'https://docs.modelswap.app';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://docs.modelswap.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function tooFast(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(ts => now - ts < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // bound memory on long-lived isolates
  return recent.length > RATE_LIMIT.max;
}

async function createIssue(token, title, body) {
  const create = labels => fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'modelswap-feedback',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  let res = await create([ISSUE_LABEL]);
  if (res.status === 422) {
    // Labels that do not exist yet can be rejected; retry without them.
    res = await create([]);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

async function handleFeedback(request, env) {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const kind = payload.kind === 'feature' ? 'feature' : 'bug';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (title.length < 3 || title.length > 140) return json({ error: 'title must be 3-140 characters' }, 400, cors);
  if (body.length < 5 || body.length > 20000) return json({ error: 'body must be 5-20000 characters' }, 400, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (tooFast(ip)) return json({ error: 'too many submissions, try again later' }, 429, cors);

  if (!env.FEEDBACK_GITHUB_TOKEN) {
    return json({ error: 'feedback is not configured yet' }, 503, cors);
  }
  try {
    const issue = await createIssue(env.FEEDBACK_GITHUB_TOKEN, `[${kind === 'bug' ? 'Bug' : 'Feature'}] ${title}`, body);
    return json({ url: issue.html_url, number: issue.number }, 200, cors);
  } catch (error) {
    return json({ error: error.message || 'failed to create issue' }, 502, cors);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/feedback') return handleFeedback(request, env);
    return env.ASSETS.fetch(request);
  },
};
