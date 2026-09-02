import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// GET /api/extension/token is the first hop of the extension WebSocket auth.
// Chrome ~150+ extension service workers with host_permissions for the target
// fetch WITHOUT an Origin header (the request bypasses CORS) — a bare request
// must succeed or the extension can never connect (symptom: “扩展未连接”).
//
// server.js pulls in the vault/providers stack, which crosses the TS boundary
// (src/web/api/*.js → src/vault/*.ts), so boot it in a ts-node child process
// the same way provider-flow.test.ts does.
const PROBE = `
  const path = require('path');
  process.env.HOME = process.argv[1];
  const { createServer } = require(path.join(process.argv[2], 'src/web/server.js'));
  const app = createServer(0);
  const server = app.listen(0, '127.0.0.1', async () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const get = async (origin) => {
      const headers = {};
      if (origin !== undefined) headers.Origin = origin;
      const res = await fetch(base + '/api/extension/token', { headers });
      const body = await res.json();
      return { status: res.status, cors: res.headers.get('access-control-allow-origin'), token: body.token || null };
    };
    const results = {
      extensionOrigin: await get('chrome-extension://abcdef123456'),
      missingOrigin: await get(undefined),
      webOrigins: [],
    };
    for (const origin of ['https://evil.example.com', 'http://localhost:3780', 'null']) {
      results.webOrigins.push({ origin, status: (await get(origin)).status });
    }
    server.close(() => { console.log('RESULT' + JSON.stringify(results)); process.exit(0); });
  });
`;

describe('GET /api/extension/token origin gate', () => {
  it('serves extension + bare requests, rejects web-page origins', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-token-endpoint-'));
    const root = path.resolve(__dirname, '../..');
    const stdout = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE, home, root],
      { cwd: root, encoding: 'utf8', timeout: 60000 },
    );
    const result = JSON.parse(stdout.slice(stdout.indexOf('RESULT') + 'RESULT'.length));

    expect(result.extensionOrigin.status).toBe(200);
    expect(result.extensionOrigin.cors).toBe('chrome-extension://abcdef123456');
    expect(result.extensionOrigin.token).toMatch(/^[0-9a-f]{64}$/);

    // The regression this test guards: Chrome 151 extension SWs send no Origin.
    expect(result.missingOrigin.status).toBe(200);
    expect(result.missingOrigin.token).toMatch(/^[0-9a-f]{64}$/);

    for (const { origin, status } of result.webOrigins) {
      expect(status, `origin ${origin} should be rejected`).toBe(403);
    }
  }, 90000);
});
