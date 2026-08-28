#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RUNTIME_MODULES = [
  'application/agent-config-service.js',
  'application/auto-create-run-service.js',
  'application/provider-service.js',
  'application/usage-provider-registry.js',
  'infrastructure/sync-config-store.js',
  'infrastructure/sync-crypto.js',
  'infrastructure/sync-platform-service.js',
];
const ENTRY_POINTS = [
  'web/server.js',
  'commands/provider.js',
  'web/api/auto-create.js',
  'web/api/providers.js',
  'web/api/usage.js',
  'web/api/cloud-sync-core.js',
  'web/api/sync.js',
];

function assertRuntimeFiles() {
  for (const modulePath of RUNTIME_MODULES) {
    const file = path.join(DIST, modulePath);
    if (!fs.existsSync(file)) throw new Error(`Missing packaged runtime module: dist/${modulePath}`);
  }
}

function makeIsolatedPackage() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-runtime-closure-'));
  fs.cpSync(DIST, path.join(sandbox, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(sandbox, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandbox, 'node_modules'), 'junction');
  // macOS commonly reports /private/var for modules created under /var.
  return fs.realpathSync(sandbox);
}

function requestHealthCheck(server) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const request = http.get({ host: '127.0.0.1', port: address.port, path: '/ping' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200 || body !== '{"ok":true}') {
          reject(new Error(`Unexpected /ping response: ${response.statusCode} ${body}`));
          return;
        }
        resolve();
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Timed out waiting for /ping')));
    request.on('error', reject);
  });
}

async function verifyIsolatedRuntime() {
  const sandbox = makeIsolatedPackage();
  const sandboxDist = path.join(sandbox, 'dist');
  const originalLoad = Module._load;
  const relativeRequests = [];

  Module._load = function trackRelativeRuntimeRequest(request, parent, isMain) {
    if (request.startsWith('.') && parent?.filename?.startsWith(sandboxDist)) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (typeof resolved !== 'string' || !resolved.startsWith(sandbox)) {
        throw new Error(`Packaged runtime escaped its isolated package: ${parent.filename} -> ${request} (${resolved})`);
      }
      relativeRequests.push({ parent: parent.filename, request, resolved });
    }
    return originalLoad.apply(this, arguments);
  };

  let server;
  try {
    for (const entryPoint of ENTRY_POINTS) require(path.join(sandboxDist, entryPoint));
    const { createServer } = require(path.join(sandboxDist, 'web/server.js'));
    server = createServer().listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    await requestHealthCheck(server);
    if (relativeRequests.length === 0) throw new Error('No packaged relative runtime requires were observed');
  } finally {
    Module._load = originalLoad;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  assertRuntimeFiles();
  await verifyIsolatedRuntime();
  console.log('Verified packaged runtime closure and /ping health check.');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
