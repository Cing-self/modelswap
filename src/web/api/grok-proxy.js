'use strict';
const http = require('http');
const https = require('https');

// Local sanitizing proxy for Grok Build custom models.
//
// Grok's tool schemas use JSON Schema union types such as
// `"type": ["integer", "null"]` (Rust Option<T>). Most OpenAI-compatible
// endpoints accept that, but ERNIE-family models on Qianfan reject it with
// `parameters format error [not a valid jsonSchema]`. The proxy rewrites
// union types to a single type before forwarding to the upstream endpoint.
//
// Grok points at the proxy via base_url:
//   http://127.0.0.1:3780/api/grok-proxy/<encodeURIComponent(upstreamBase)>
// and issues `POST <base_url>/chat/completions`. Express mounts this handler
// at `/api/grok-proxy/:enc`, so req.url is the remainder (`/chat/completions`).

const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Rewrite `"type": [..]` arrays to a single non-null type, in place.
function sanitizeToolParameters(node) {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeToolParameters(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.type)) {
    node.type = node.type.find((t) => t !== 'null') || 'string';
  }
  for (const value of Object.values(node)) sanitizeToolParameters(value);
}

function createGrokProxyHandler() {
  return (req, res) => {
    const enc = req.params && req.params.enc;
    if (!enc) {
      return res.status(400).json({ error: 'missing upstream target' });
    }
    let upstream;
    try {
      upstream = decodeURIComponent(enc);
    } catch {
      return res.status(400).json({ error: 'invalid upstream target' });
    }
    if (!/^https?:\/\//i.test(upstream)) {
      return res.status(400).json({ error: 'invalid upstream target' });
    }

    const target = upstream + req.url;
    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        if (!res.headersSent) res.status(413).json({ error: 'request body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      let body = raw;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];

      if (raw.length > 0 && String(req.headers['content-type'] || '').includes('application/json')) {
        try {
          const parsed = JSON.parse(raw.toString('utf-8'));
          if (parsed && Array.isArray(parsed.tools)) {
            for (const tool of parsed.tools) {
              if (tool && tool.function && tool.function.parameters) {
                sanitizeToolParameters(tool.function.parameters);
              }
            }
            body = Buffer.from(JSON.stringify(parsed), 'utf-8');
          }
        } catch {
          // Not JSON or unparseable: forward verbatim.
        }
      }

      headers['content-length'] = body.length;
      const transport = target.startsWith('https:') ? https : http;
      const upReq = transport.request(target, { method: req.method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
      upReq.on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({ error: `grok proxy upstream error: ${err.message}` });
        } else {
          res.destroy();
        }
      });
      upReq.end(body);
    });
  };
}

module.exports = { createGrokProxyHandler, sanitizeToolParameters };