const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { listVault, setVault, deleteVault, exportVault, importVault, getVaultValue, testApiKey, migrateGroups } = require('./api/vault');
const { autoCreateKey, autoCreateRunStatus, resumeAutoCreateRun, deleteAutoCreateKey, recoverLatestZaiGlobalKey, cdpStatus, listAutoCreatePlatforms, openVerificationLoginTabs } = require('./api/auto-create');
const { getLogs } = require('./api/logs');
const { getSettings, updateSettings, testPlatformConnection, getPresets, getOnboarding, dismissOnboarding, resetOnboarding } = require('./api/settings');
const { checkWrangler, listStores, listStoreSecrets, syncToCloudflare } = require('./api/cloudflare-sync');
const { handlePush, handlePull, handleStatus, handleExportCode, handleImportCode, handleLanStatus, handleLanEnable, handleLanDisable, handleLanRegenerate, handleLanPairingPeek, handleLanPairingCreate, handleLanPair, handleSyncOverview } = require('./api/sync');
const { listProviders, getModelData, refreshModelData, refreshDemoProviderModels, getAdaptersList, createProvider, updateProvider, deleteProvider, switchProvider, configureAgentProvider, removeAgentProvider, setAgentProviderEnabled, getAgentConfigFiles, saveAgentConfigFile, getTierMaps, setTierMap, launchAgent, getAuthStatus, verifyProviderAuth, triggerOAuthLogin, fetchModels, warmupMissingModels, exportProviderCode, importProviderCode } = require('./api/providers');
const { getUsage, getSupportedUsageProviders, openXiaomiLogin, closeXiaomiLoginWindow } = require('./api/usage');
const { createGrokProxyHandler } = require('./api/grok-proxy');
const { listSnapshotsHandler, snapshotDetailHandler, restoreSnapshotHandler } = require('./api/snapshots');
const { issueExtensionToken, isExtensionOrigin } = require('./api/ws-extension');
const { getUpdateCheck, downloadUpdate, getUpdateDownloadStatus } = require('./api/update-check');
const { subscribeUiEvents } = require('./api/ui-events');
const { sendApiError } = require('../application/error-normalization');
const { agentConfigPresence } = require('../application/provider-service');

function createServer(port = 3780) {
  const app = express();
  let requestSequence = 0;

  // A local correlation id is enough to connect a safe operator log with the
  // request that failed. It deliberately never incorporates request content.
  app.use((req, res, next) => {
    res.locals.requestId = `api-${++requestSequence}`;
    next();
  });

  // Grok Build tool-schema sanitizing proxy. Must be mounted before
  // express.json(): the proxy reads the raw request body itself, and a
  // JSON body-parser would consume the stream first (and cap its size).
  app.use('/api/grok-proxy/:enc', createGrokProxyHandler());

  // Middleware
  app.use(express.json());
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { maxAge: 0, etag: false, lastModified: false, setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  } }));

  // API Routes
  app.get('/api/events', subscribeUiEvents);
  app.get('/api/logs', getLogs);
  app.get('/api/vault', listVault);
  app.get('/api/vault/list', listVault);
  app.post('/api/vault', setVault);
  app.delete('/api/vault', deleteVault);
  app.get('/api/vault/export', exportVault);
  app.post('/api/vault/import', importVault);
  app.get('/api/vault/value', getVaultValue);
  // Agent-config key reconciliation: scan plaintext keys in agent configs,
  // import them into the vault on request.
  const { scanAgentKeys, importAgentKeys } = require('./api/key-import');
  app.get('/api/vault/scan-agent-keys', scanAgentKeys);
  app.post('/api/vault/import-agent-keys', importAgentKeys);
  app.post('/api/vault/test-key', testApiKey);
  app.post('/api/vault/migrate-groups', migrateGroups);
  app.post('/api/vault/auto-create', autoCreateKey);
  app.get('/api/vault/auto-create/status/:runId', autoCreateRunStatus);
  app.post('/api/vault/auto-create/resume/:runId', resumeAutoCreateRun);
  app.post('/api/vault/auto-create/delete', deleteAutoCreateKey);
  app.post('/api/vault/auto-create/recover-zai-latest', async (_req, res) => {
    try {
      const result = await recoverLatestZaiGlobalKey();
      res.json({ success: true, platform: 'zai-global', name: result.name, valueLength: result.valueLength });
      require('./api/sync-scheduler').markDirty('secrets');
    } catch (error) {
      sendApiError(res, error, res.locals.requestId);
    }
  });
  app.get('/api/vault/auto-create/platforms', listAutoCreatePlatforms);
  app.post('/api/vault/auto-create/open-login-tabs', openVerificationLoginTabs);
  app.get('/api/vault/cdp-status', cdpStatus);

  // Lightweight health-check endpoint for the Chrome extension.
  // The extension probes /ping before each WebSocket attempt so that
  // ERR_CONNECTION_REFUSED (uncatchable on new WebSocket()) stays out of
  // the extension console. No auth/header required.
  app.get('/ping', (_req, res) => res.json({ ok: true }));

  // One-time WebSocket auth token for the Chrome extension. Only browser-
  // extension origins get CORS headers, so an ordinary web page cannot read a
  // token even if it can reach this endpoint — and without a token the WS
  // channel at /ws/extension stays closed to it.
  //
  // A MISSING Origin header is also valid: since Chrome ~150, fetch() from an
  // extension service worker with host_permissions for the target URL bypasses
  // CORS entirely, and such requests carry no Origin header — rejecting them
  // (as Chrome 151 was) leaves the extension unable to obtain a token at all.
  // Web pages remain locked out: readable CORS fetches always attach a web
  // Origin (rejected below), and no-cors fetches / sendBeacon / <img> / tab
  // navigations that omit Origin cannot read the response body from script.
  app.get('/api/extension/token', (req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !isExtensionOrigin(origin)) {
      return res.status(403).json({ error: 'Forbidden: extension origins only' });
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.json({ token: issueExtensionToken(), ttlSeconds: 120 });
  });

  // Browser-console counterpart to Electron's shell.showItemInFolder(). The
  // local server is loopback-only, and this keeps the diagnostic action useful
  // on macOS, Windows, and Linux instead of making it a Finder-only affordance.
  app.post('/api/extension/reveal', async (_req, res) => {
    const dir = path.resolve(__dirname, '../../extension');
    try {
      if (!await fs.pathExists(dir)) {
        return res.status(404).json({ error: '未找到扩展目录' });
      }
      const command = process.platform === 'darwin'
        ? ['open', [dir]]
        : process.platform === 'win32'
          ? ['explorer.exe', [dir]]
          : ['xdg-open', [dir]];
      const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
      child.unref();
      res.json({ success: true, dir });
    } catch (error) {
      sendApiError(res, error, res.locals.requestId);
    }
  });

  // Update check + guided download (desktop dmg / release assets). Shared by
  // the desktop app, the web console, and mirrors the CLI's upgrade source.
  app.get('/api/update-check', getUpdateCheck);
  app.post('/api/update-download', downloadUpdate);
  app.get('/api/update-download/:downloadId', getUpdateDownloadStatus);

  // Diagnostics summary for support requests: real port, runtime, extension
  // link state, per-agent config presence, and the most recent failed
  // operations. Everything redacts secrets; keys never leave this machine.
  app.get('/api/diagnostics', (_req, res) => {
    try {
      const wsExt = require('./api/ws-extension');
      const { recentFailures } = require('./api/logs');
      const { augmentedPath } = require('./api/agent-path');
      res.json({
        version: require('../../package.json').version,
        port: runtimePort,
        nodeVersion: process.version,
        platform: `${process.platform} ${os.release()} ${os.arch}`,
        // The server process's own PATH (GUI launches get launchd's minimal
        // default) plus what detection actually resolves with — the pair
        // explains "agent shows not installed" reports at a glance.
        env: {
          processPath: process.env.PATH || '',
          detectionPath: augmentedPath(),
        },
        extension: {
          connected: wsExt.isExtensionConnected(),
          version: wsExt.getExtensionVersion(),
          protocol: wsExt.getExtensionProtocol(),
        },
        // This is an application read, not an HTTP controller invocation.
        // Calling ./api/providers here passed no Express response to the
        // controller adapter and turned diagnostics into an async crash.
        agents: agentConfigPresence(),
        recentFailures: recentFailures(5),
      });
    } catch (error) {
      sendApiError(res, error, res.locals.requestId);
    }
  });

  // Cloudflare sync routes
  app.get('/api/cloudflare/check', checkWrangler);
  app.get('/api/cloudflare/stores', listStores);
  app.get('/api/cloudflare/store-secrets', listStoreSecrets);
  app.post('/api/cloudflare/sync', syncToCloudflare);

  // Settings routes
  app.get('/api/settings', getSettings);
  app.post('/api/settings', updateSettings);
  app.post('/api/settings/test', testPlatformConnection);
  app.get('/api/settings/presets', getPresets);
  app.get('/api/settings/onboarding', getOnboarding);
  app.post('/api/settings/onboarding/dismiss', dismissOnboarding);
  app.post('/api/settings/onboarding/reset', resetOnboarding);

  // Sync routes
  app.post('/api/sync/push', handlePush);
  app.post('/api/sync/pull', handlePull);
  app.get('/api/sync/status', handleStatus);
  app.get('/api/sync/overview', handleSyncOverview);
  app.post('/api/sync/code/export', handleExportCode);
  app.post('/api/sync/code/import', handleImportCode);
  // LAN peer sync (dedicated listener on its own port, token-authenticated)
  app.get('/api/sync/lan/status', handleLanStatus);
  app.post('/api/sync/lan/enable', handleLanEnable);
  app.post('/api/sync/lan/disable', handleLanDisable);
  app.post('/api/sync/lan/regenerate', handleLanRegenerate);
  app.get('/api/sync/lan/pairing', handleLanPairingPeek);
  app.post('/api/sync/lan/pairing', handleLanPairingCreate);
  app.post('/api/sync/lan/pair', handleLanPair);

  // Provider routes
  app.get('/api/providers', listProviders);
  app.get('/api/demo/model-data', getModelData);
  app.post('/api/demo/model-data/refresh', refreshModelData);
  app.post('/api/demo/model-data/providers/:id/refresh', refreshDemoProviderModels);
  app.get('/api/providers/adapters', getAdaptersList);
  app.post('/api/providers', createProvider);
  // One Agent-site record owns its selected models and drives both the native
  // Agent config and the home-page card. There is no separate "home" list.
  app.put('/api/providers/agents/:agentId/sites/:providerId', configureAgentProvider);
  app.delete('/api/providers/agents/:agentId/sites/:providerId', removeAgentProvider);
  app.post('/api/providers/agents/:agentId/sites/:providerId/enabled', setAgentProviderEnabled);
  app.get('/api/providers/agents/:agentId/config-files', getAgentConfigFiles);
  app.put('/api/providers/agents/:agentId/config-files', saveAgentConfigFile);
  app.get('/api/providers/tier-maps', getTierMaps);
  app.put('/api/providers/tier-maps/:providerId', setTierMap);
  app.put('/api/providers/:id', updateProvider);
  app.delete('/api/providers/:id', deleteProvider);
  app.post('/api/providers/switch', switchProvider);
  app.post('/api/providers/launch', launchAgent);
  app.get('/api/providers/auth', getAuthStatus);
  app.post('/api/providers/:id/verify-auth', verifyProviderAuth);
  app.post('/api/providers/auth/login', triggerOAuthLogin);
  app.post('/api/providers/fetch-models', fetchModels);
  app.post('/api/providers/warmup-missing-models', warmupMissingModels);
  app.post('/api/providers/export-code', exportProviderCode);
  app.post('/api/providers/import-code', importProviderCode);

  // Snapshot routes (pre-switch config snapshots)
  app.get('/api/snapshots', listSnapshotsHandler);
  app.get('/api/snapshots/detail', snapshotDetailHandler);
  app.post('/api/snapshots/restore', restoreSnapshotHandler);

  // Usage / quota routes
  app.get('/api/usage/supported', getSupportedUsageProviders);
  app.post('/api/usage/:providerId/login', openXiaomiLogin);
  app.post('/api/usage/:providerId/close-window', closeXiaomiLoginWindow);
  app.get('/api/usage/:providerId', getUsage);

  // Controllers can be legacy callback handlers, async functions, or a
  // shared Promise adapter. Express 5 forwards any rejected value here;
  // normalize it once so a `throw undefined` cannot terminate the service.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return sendApiError(res, error, res.locals?.requestId);
  });

  // SPA fallback
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Pass the public directory as `root` instead of sending one absolute
    // path. The `send` package treats dot-prefixed segments in an absolute
    // workspace path (for example `.codex`) as hidden files and returns 404.
    res.sendFile('index.html', { root: publicDir });
  });

  return app;
}

// Actual listening port (may differ from the default 3780 after fallback).
// Recorded so /api/diagnostics can report the real port.
let runtimePort = null;

function startServer(port = 3780, onStarted) {
  const { setupWebSocket, sendToExtension, isExtensionConnected } = require('./api/ws-extension');
  const app = createServer(port);

  const server = require('http').createServer(app);

  server.listen(port, '127.0.0.1', () => {
    runtimePort = port;
    // Attach WebSocket only after the HTTP port is bound successfully.
    // WebSocketServer forwards errors from its HTTP server; attaching it
    // before listen() turns EADDRINUSE into an uncaught WebSocket error and
    // prevents the fallback-port retry below from completing.
    setupWebSocket(server);
    console.log(`\n  MODELSWAP Web UI is running at http://localhost:${port}`);
    console.log(`  Press Ctrl+C to stop\n`);
    // Auto-sync scheduler: debounced push + periodic pull check.
    require('./api/sync-scheduler').startAutoSync();
    // Update watcher: fixed 15-minute silent latest-release refresh that
    // broadcasts 'update-available' over /api/events once per new version.
    require('./api/update-check').startUpdateWatcher();
    // LAN peer sync listener: separate port, only if enabled in config.
    require('./api/lan-sync-server').applyConfig().catch((err) => {
      console.error('LAN sync listener startup failed:', err.message);
    });
    if (onStarted) onStarted(port);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.log(`  Port ${port} in use, trying ${nextPort}...`);
      startServer(nextPort, onStarted);
    } else {
      throw err;
    }
  });

  return app;
}

module.exports = { createServer, startServer };
