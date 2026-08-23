import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import express from 'express';
import { createGrokProxyHandler, sanitizeToolParameters } from '../../src/web/api/grok-proxy.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as net.AddressInfo).port);
  }));
}

describe('sanitizeToolParameters', () => {
  it('rewrites union types to a single non-null type', () => {
    const params = { type: 'object', properties: { timeout: { type: ['integer', 'null'] } } };
    sanitizeToolParameters(params);
    expect((params.properties.timeout as any).type).toBe('integer');
  });

  it('walks nested arrays and objects', () => {
    const params = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: ['string', 'null'] } },
        nested: { anyOf: [{ type: ['boolean', 'null'] }, { type: 'string' }] },
      },
    };
    sanitizeToolParameters(params);
    expect((params.properties.items as any).items.type).toBe('string');
    expect((params.properties.nested as any).anyOf[0].type).toBe('boolean');
  });

  it('leaves single-type schemas untouched', () => {
    const params = { type: 'object', properties: { command: { type: 'string' } } };
    const snapshot = JSON.stringify(params);
    sanitizeToolParameters(params);
    expect(JSON.stringify(params)).toBe(snapshot);
  });

  it('handles non-object inputs', () => {
    expect(() => sanitizeToolParameters(null as any)).not.toThrow();
    expect(() => sanitizeToolParameters('x' as any)).not.toThrow();
  });
});

describe('grok proxy handler', () => {
  let upstream: http.Server | null = null;
  let proxy: http.Server | null = null;
  let sseUpstream: http.Server | null = null;
  let upstreamPort = 0;
  let proxyPort = 0;
  let lastRequest: { method: string; url: string; body: string } | null = null;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastRequest = { method: req.method || '', url: req.url || '', body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: body }));
      });
    });
    upstreamPort = await listen(upstream);

    const app = express();
    app.use('/api/grok-proxy/:enc', createGrokProxyHandler());
    proxy = http.createServer(app);
    proxyPort = await listen(proxy);
  });

  it('forwards chat completions and sanitizes tool schemas', async () => {
    const enc = encodeURIComponent(`http://127.0.0.1:${upstreamPort}`);
    const body = {
      model: 'ernie-5.1',
      stream: false,
      tools: [
        { type: 'function', function: { name: 'run_terminal_command', parameters: { type: 'object', properties: { timeout: { type: ['integer', 'null'] } } } } },
      ],
    };
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(lastRequest!.method).toBe('POST');
    expect(lastRequest!.url).toBe('/chat/completions');
    const sent = JSON.parse(lastRequest!.body);
    expect(sent.tools[0].function.parameters.properties.timeout.type).toBe('integer');
  });

  it('passes through request bodies without tools verbatim', async () => {
    const enc = encodeURIComponent(`http://127.0.0.1:${upstreamPort}`);
    const body = { model: 'ernie-5.1', messages: [{ role: 'user', content: 'hi' }] };
    await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(JSON.parse(lastRequest!.body)).toEqual(body);
  });

  it('passes through non-JSON bodies', async () => {
    const enc = encodeURIComponent(`http://127.0.0.1:${upstreamPort}`);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/some/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'plain-text-body',
    });
    expect(res.status).toBe(200);
    expect(lastRequest!.body).toBe('plain-text-body');
  });

  it('streams SSE responses through unchanged', async () => {
    sseUpstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"a":1}\n\n');
      res.end('data: [DONE]\n\n');
    });
    const port = await listen(sseUpstream);
    const enc = encodeURIComponent(`http://127.0.0.1:${port}`);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('data: [DONE]');
  });

  it('rejects non-http targets', async () => {
    const enc = encodeURIComponent('file:///etc/passwd');
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/x`, { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const dead = http.createServer(() => {});
    const port = await listen(dead);
    dead.close();
    const enc = encodeURIComponent(`http://127.0.0.1:${port}`);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/grok-proxy/${enc}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    expect(res.status).toBe(502);
  });

  afterAll(async () => {
    // Consume any unconsumed response bodies so the sockets can close, then
    // forcibly shut the listeners down (incl. keep-alive connections) so the
    // test process exits cleanly.
    const close = (s: http.Server | null) =>
      new Promise<void>((resolve) => {
        if (!s) return resolve();
        s.close(() => resolve());
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      });
    await close(upstream);
    await close(proxy);
    await close(sseUpstream);
  });
});
