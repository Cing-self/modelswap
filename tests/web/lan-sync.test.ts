import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Module from 'module';
import os from 'os';
import net from 'net';
import fs from 'fs-extra';
import path from 'path';

// Redirect ~/.okit before any module under test computes paths from homedir().
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-lan-test-'));
vi.spyOn(os, 'homedir').mockReturnValue(TMP_HOME);

const mockCore = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  appendLog: vi.fn(),
  resolveSyncKeys: vi.fn(),
  resolveVaultRefs: vi.fn(async (c: any) => c),
  testConnection: vi.fn(),
  syncPush: vi.fn(),
  syncPull: vi.fn(),
  peekRemote: vi.fn(),
  exportSyncCode: vi.fn(),
  importSyncCode: vi.fn(),
}));

const mockLanServer = vi.hoisted(() => ({
  DEFAULT_PORT: 3790,
  applyConfig: vi.fn(async () => ({ running: true })),
  startLanSyncServer: vi.fn(),
  stopLanSyncServer: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ running: true, port: 3790, error: null })),
  listLanAddresses: vi.fn(() => ['192.168.1.5']),
  buildConnectionCode: vi.fn((address: string, port: number, token: string) => `okit-lan://${address}:${port}/${token}`),
  getRecentPeers: vi.fn(() => []),
  getMachineIdentity: vi.fn(async () => ({ name: 'Test Machine', id: 'm-test' })),
  createPairingCode: vi.fn(() => ({ code: 'paircode1', expiresAt: Date.now() + 300_000 })),
  getPendingPairing: vi.fn(() => null),
}));

// The adapter requires the real listener via '../lan-sync-server'; route it to
// the exact instance this test imported so header tracking is observable.
let realLanServer: any = null;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === './cloud-sync-core') return mockCore;
  if (id === './lan-sync-server') return mockLanServer;
  if (id === '../lan-sync-server' && realLanServer) return realLanServer;
  return origRequire.apply(this, arguments);
};

// Real listener module (its own require of cloud-sync-core hits the mock).
const lanServer = await import('../../src/web/api/lan-sync-server.js');
realLanServer = lanServer;
// Real adapter — exercised against the live in-process listener.
const lanAdapter = await import('../../src/web/api/platform-adapters/lan.js');
// sync.js handlers get the mocked lan-sync-server module injected.
const syncHandlers = await import('../../src/web/api/sync.js');

const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

// Simulate config round-trips: saveConfig mutates the object loadConfig returns.
let currentConfig: any = {};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function holdPort(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const s = net.createServer();
    // Wildcard bind — a loopback-only squatter doesn't conflict with the
    // listener's 0.0.0.0 bind on macOS (SO_REUSEADDR semantics).
    s.listen(port, '0.0.0.0', () => resolve(s));
  });
}

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
}

let port: number;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  currentConfig = { sync: { machineId: 'm-test' } };
  mockCore.loadConfig.mockImplementation(async () => currentConfig);
  mockCore.saveConfig.mockImplementation(async (c: any) => { currentConfig = c; });
  mockCore.appendLog.mockResolvedValue(undefined);
  mockCore.resolveSyncKeys.mockResolvedValue({ userId: 'u1', encryptionKey: Buffer.alloc(32) });
  mockCore.peekRemote.mockResolvedValue(null);
  mockCore.syncPush.mockResolvedValue({ secrets: 0, platforms: ['lan'], platform: 'lan' });

  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  // Each test starts with an empty blob store (the module caches + persists
  // across restarts by design, which would leak between tests otherwise).
  await fs.remove(path.join(TMP_HOME, '.okit', 'sync', 'lan-blob.json'));
  const started = await lanServer.startLanSyncServer(port, TOKEN);
  expect(started.running).toBe(true);
});

afterEach(async () => {
  await lanServer.stopLanSyncServer();
});

afterAll(async () => {
  await fs.remove(TMP_HOME);
});

describe('lan-sync-server listener', () => {
  it('rejects requests without or with a wrong token', async () => {
    const noAuth = await fetch(`${baseUrl}/ping`);
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/ping`, { headers: { Authorization: `Bearer ${OTHER_TOKEN}` } });
    expect(wrong.status).toBe(401);
  });

  it('answers ping with identity and the password-derived userId', async () => {
    currentConfig = { sync: { machineId: 'm1' } };
    const res = await fetch(`${baseUrl}/ping`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.version).toBe(1);
    expect(info.machineId).toBe('m1');
    expect(info.userId).toBe('u1');
    expect(typeof info.machineName).toBe('string');
  });

  it('stores and returns encrypted blobs, rejecting malformed ones', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${baseUrl}/blob`, { headers: auth })).status).toBe(404);

    const bad = await fetch(`${baseUrl}/blob`, { method: 'PUT', headers: auth, body: JSON.stringify({ foo: 'bar' }) });
    expect(bad.status).toBe(400);

    const blob = { nonce: 'aabb', ciphertext: 'ccdd', tag: 'eeff' };
    const put = await fetch(`${baseUrl}/blob`, { method: 'PUT', headers: auth, body: JSON.stringify(blob) });
    expect(put.status).toBe(200);

    const got = await fetch(`${baseUrl}/blob`, { headers: auth });
    expect(await got.json()).toEqual(blob);
  });

  it('persists the blob so a restart keeps serving it', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const blob = { nonce: '11', ciphertext: '22', tag: '33' };
    await fetch(`${baseUrl}/blob`, { method: 'PUT', headers: auth, body: JSON.stringify(blob) });
    await lanServer.stopLanSyncServer();
    const restarted = await lanServer.startLanSyncServer(port, TOKEN);
    expect(restarted.running).toBe(true);
    const got = await fetch(`${baseUrl}/blob`, { headers: auth });
    expect(await got.json()).toEqual(blob);
  });

  it('surfaces port conflicts instead of silently roaming', async () => {
    await lanServer.stopLanSyncServer();
    const squatter = await holdPort(port);
    try {
      const started = await lanServer.startLanSyncServer(port, TOKEN);
      expect(started.running).toBe(false);
      expect(started.error).toContain('占用');
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('lan platform adapter (against the live listener)', () => {
  const config = { baseUrl: 'will-be-set', token: TOKEN };

  it('tests the connection and reports the peer machine name', async () => {
    const message = await lanAdapter.testConnection({ ...config, baseUrl });
    expect(message).toContain('已连接');
  });

  it('returns null when the peer store is empty, then round-trips a blob', async () => {
    expect(await lanAdapter.pullSync({ ...config, baseUrl }, 'u1')).toBeNull();

    const blob = { nonce: 'a1', ciphertext: 'b2', tag: 'c3' };
    await lanAdapter.pushSync({ ...config, baseUrl }, 'u1', blob);
    expect(await lanAdapter.pullSync({ ...config, baseUrl }, 'u1')).toEqual(blob);
  });

  it('rejects an invalid token with a re-pair hint', async () => {
    await expect(lanAdapter.testConnection({ ...config, baseUrl, token: OTHER_TOKEN }))
      .rejects.toThrow('令牌无效');
  });
});

describe('sync.js LAN handlers', () => {
  it('handleLanEnable requires a sync password first', async () => {
    const res = mockRes();
    await syncHandlers.handleLanEnable({ body: {} } as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('同步密码');
  });

  it('handleLanEnable creates the loopback platform entry and turns on autoSync', async () => {
    currentConfig = { sync: { password: 'pw' } };
    const res = mockRes();
    await syncHandlers.handleLanEnable({ body: {} } as any, res);

    expect(res.statusCode).toBe(200);
    const sync = currentConfig.sync;
    expect(sync.lan.enabled).toBe(true);
    expect(sync.lan.token).toMatch(/^[0-9a-f]{64}$/);
    expect(sync.platforms.lan.baseUrl).toBe(`http://127.0.0.1:${sync.lan.port}`);
    expect(sync.platforms.lan.enabled).toBe(true);
    expect(sync.autoSync).toBe(true);
    expect(sync.syncPlatform).toBe('lan');
  });

  it('handleLanEnable never clobbers an existing remote peer entry', async () => {
    const remoteEntry = { baseUrl: 'http://192.168.1.9:3790', token: 'remote-token', enabled: true };
    currentConfig = { sync: { password: 'pw', platforms: { lan: remoteEntry } } };
    const res = mockRes();
    await syncHandlers.handleLanEnable({ body: {} } as any, res);

    expect(res.statusCode).toBe(200);
    expect(currentConfig.sync.platforms.lan).toEqual(remoteEntry);
    // The listener still comes up; it just isn't this machine's own platform.
    expect(mockLanServer.applyConfig).toHaveBeenCalled();
  });

  it('handleLanPair exchanges the pairing code for the persistent token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, token: 'exchanged-access-token', machineName: 'Peer Mac', machineId: 'peer-1', userId: 'u1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      currentConfig = { sync: { password: 'pw' } };
      const res = mockRes();
      const code = `okit-lan://192.168.1.5:3790/abc123def456?name=${encodeURIComponent('Peer Mac')}`;
      await syncHandlers.handleLanPair({ body: { code } } as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.peerName).toBe('Peer Mac');
      // The exchange endpoint is called with the short pairing code...
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://192.168.1.5:3790/pair');
      expect(JSON.parse(init.body).code).toBe('abc123def456');
      // ...and the SAVED token is the exchanged one, not the pairing code.
      expect(currentConfig.sync.platforms.lan).toEqual({ baseUrl: 'http://192.168.1.5:3790', token: 'exchanged-access-token', enabled: true });
      expect(currentConfig.sync.autoSync).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handleLanPair surfaces expired pairing codes as a 400', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: '配对码无效或已过期' }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      currentConfig = { sync: { password: 'pw' } };
      const res = mockRes();
      await syncHandlers.handleLanPair({ body: { code: `okit-lan://192.168.1.5:3790/stalecode` } } as any, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('配对码无效或已过期');
      expect(currentConfig.sync.platforms).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handleLanPair rejects a sync-password mismatch with a clear error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, token: 'exchanged-access-token', machineName: 'Peer', machineId: 'peer-1', userId: 'other-user' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      currentConfig = { sync: { password: 'pw' } };
      const res = mockRes();
      await syncHandlers.handleLanPair({ body: { code: `okit-lan://192.168.1.5:3790/${TOKEN}` } } as any, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('同步密码不一致');
      expect(currentConfig.sync.platforms).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handleLanPair surfaces unreachable peers as a 400 with guidance', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      currentConfig = { sync: { password: 'pw' } };
      const res = mockRes();
      await syncHandlers.handleLanPair({ body: { code: `okit-lan://192.168.1.5:3790/${TOKEN}` } } as any, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('无法连接对端');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handleLanPair rejects malformed codes before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = mockRes();
      await syncHandlers.handleLanPair({ body: { code: 'not-a-code' } } as any, res);
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('peer tracking (hub side)', () => {
  it('records machines that identify via x-okit-machine', async () => {
    await fetch(`${baseUrl}/ping`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-okit-machine': `${encodeURIComponent('MacBook Pro')}#peer-1` },
    });
    const peer = lanServer.getRecentPeers().find(p => p.id === 'peer-1');
    expect(peer).toBeTruthy();
    expect(peer!.name).toBe('MacBook Pro');
    expect(peer!.address).toBeTruthy();
    expect(peer!.online).toBe(true);
  });

  it('adapter requests carry this machine identity to the peer', async () => {
    await lanAdapter.pushSync({ baseUrl, token: TOKEN }, 'u1', { nonce: 'aa', ciphertext: 'bb', tag: 'cc' });
    const peer = lanServer.getRecentPeers().find(p => p.id === 'm-test');
    expect(peer).toBeTruthy();
    expect(peer!.online).toBe(true);
  });
});

describe('sync overview', () => {
  it('reports hub state and filters self from the device list', async () => {
    currentConfig = {
      sync: {
        machineId: 'm1', password: 'pw', autoSync: true,
        lastSyncAt: '2026-08-19T10:00:00.000Z',
        lan: { enabled: true, token: 't'.repeat(64) },
        platforms: { lan: { baseUrl: 'http://127.0.0.1:3790', token: 'x', enabled: true }, webdav: { enabled: true } },
      },
    };
    mockLanServer.getRecentPeers.mockReturnValue([
      { id: 'm1', name: 'Self', address: '127.0.0.1', lastSeen: Date.now(), online: true },
      { id: 'peer-9', name: 'Other Mac', address: '192.168.1.9', lastSeen: Date.now(), online: true },
    ]);
    mockLanServer.getPendingPairing.mockReturnValue({ code: 'pc123', expiresAt: Date.now() + 300_000 });
    const res = mockRes();
    await syncHandlers.handleSyncOverview({} as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.machine.role).toBe('hub');
    expect(res.body.devices.map((d: any) => d.id)).toEqual(['peer-9']);
    expect(res.body.devices[0].lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.cloudPlatforms).toEqual(['webdav']);
    expect(res.body.peer).toBeNull();
    // Codes come from the active pairing session and embed the short code,
    // never the persistent access token.
    expect(res.body.lan.codes.length).toBeGreaterThan(0);
    expect(res.body.lan.codes[0].code).toContain('pc123');
    expect(res.body.lan.codes[0].code).not.toContain('t'.repeat(64));
  });

  it('probes the remote hub when configured as a spoke', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, machineName: 'Hub Mac', machineId: 'hub-1', userId: 'u1', hasBlob: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      mockLanServer.getRecentPeers.mockReturnValue([]);
      currentConfig = {
        sync: {
          machineId: 'm2', password: 'pw',
          platforms: { lan: { baseUrl: 'http://192.168.1.5:3790', token: TOKEN, enabled: true } },
        },
      };
      const res = mockRes();
      await syncHandlers.handleSyncOverview({} as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.machine.role).toBe('spoke');
      expect(res.body.peer.online).toBe(true);
      expect(res.body.peer.name).toBe('Hub Mac');
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('pairing exchange (listener /pair)', () => {
  it('exchanges a fresh code for the access token, single-use', async () => {
    const session = lanServer.createPairingCode();
    const res = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: session.code }),
    });
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.token).toBe(TOKEN);
    expect(info.userId).toBe('u1');
    expect(info.machineId).toBe('m-test');

    // Single use: the redeemed code never works again.
    const again = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: session.code }),
    });
    expect(again.status).toBe(401);
  });

  it('rejects wrong codes without requiring a Bearer token', async () => {
    lanServer.createPairingCode();
    const res = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrongcode' }),
    });
    expect(res.status).toBe(401);
  });

  it('generating a new code invalidates the previous session', async () => {
    const first = lanServer.createPairingCode();
    lanServer.createPairingCode();
    const res = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: first.code }),
    });
    expect(res.status).toBe(401);
  });
});

describe('pairing code creation (sync handler)', () => {
  it('requires LAN sync to be enabled', async () => {
    currentConfig = { sync: { lan: { enabled: false } } };
    const res = mockRes();
    await syncHandlers.handleLanPairingCreate({} as any, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns expiring connection codes for every candidate address', async () => {
    currentConfig = { sync: { lan: { enabled: true, token: 't'.repeat(64) } } };
    const res = mockRes();
    await syncHandlers.handleLanPairingCreate({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.codes[0].code).toContain('paircode1');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('peeks the active session without generating a new one', async () => {
    currentConfig = { sync: { lan: { enabled: true, token: 't'.repeat(64) } } };
    mockLanServer.getPendingPairing.mockReturnValue({ code: 'peek1', expiresAt: Date.now() + 60_000 });
    const active = mockRes();
    await syncHandlers.handleLanPairingPeek({} as any, active);
    expect(active.statusCode).toBe(200);
    expect(active.body.active).toBe(true);
    expect(active.body.codes[0].code).toContain('peek1');

    // No active session (redeemed or expired) → inactive, no codes.
    mockLanServer.getPendingPairing.mockReturnValue(null);
    const idle = mockRes();
    await syncHandlers.handleLanPairingPeek({} as any, idle);
    expect(idle.body).toEqual({ active: false });
  });
});
