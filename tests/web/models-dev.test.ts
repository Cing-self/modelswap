import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const modelsDev = require('../../src/web/api/models-dev.js');
const { __testing } = modelsDev;

afterEach(() => __testing.resetTestHooks());

describe('models.dev directory resolution', () => {
  const catalog = __testing.indexCatalog({
    opencode: {
      api: 'https://opencode.ai/zen/v1',
      models: { 'hy3-free': { limit: { context: 190000, output: 64000 } } },
    },
    'opencode-go': {
      api: 'https://opencode.ai/zen/go/v1',
      models: { 'go-model': { limit: { context: 262144, output: 32768 } } },
    },
  });

  it('uses the explicit catalog id when two products share one API host', () => {
    expect(__testing.resolveCatalogKey(catalog, {
      id: 'opencode-zen',
      modelCatalogId: 'opencode',
      baseUrl: 'https://opencode.ai/zen/v1',
    })).toBe('opencode');
    expect(__testing.resolveCatalogKey(catalog, {
      id: 'opencode-go',
      modelCatalogId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    })).toBe('opencode-go');
  });

  it('prefers explicit live API limits and modalities over directory metadata', () => {
    const metadata = __testing.metadataFromCatalog(
      'hy3-free',
      {
        limit: { context: 190000, output: 64000 },
        modalities: { input: ['text'], output: ['text'] },
      },
      '2026-08-27T00:00:00.000Z',
      'remote',
      {
        id: 'hy3-free',
        remote: {
          context: 200000,
          output: 32000,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    );

    expect(metadata).toMatchObject({
      context: 200000,
      output: 32000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      source: 'remote',
      confidence: 'high',
    });
  });

  it('deduplicates concurrent refreshes and atomically publishes one generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswap-models-dev-'));
    const cachePath = path.join(root, 'models-dev.json');
    let calls = 0;
    __testing.setTestHooks({
      cachePath,
      fetchJson: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-chat': { limit: { context: 128000 } } } } };
      },
    });

    const [a, b, c] = await Promise.all([
      modelsDev.refreshCatalog(), modelsDev.refreshCatalog(), modelsDev.loadCatalog({ force: true }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(modelsDev.getCatalogState()).toMatchObject({ generation: 1, status: 'fresh', lastError: null });
    const disk = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    expect(disk).toMatchObject({ version: 2, generation: 1, status: 'fresh' });
    expect(disk.data.deepseek.models['deepseek-chat']).toBeDefined();
  });

  it('keeps last-good data and provenance when a forced refresh fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswap-models-dev-'));
    const cachePath = path.join(root, 'models-dev.json');
    __testing.setTestHooks({
      cachePath,
      fetchJson: async () => ({ deepseek: { api: 'https://api.deepseek.com', models: { stable: {} } } }),
    });
    await modelsDev.refreshCatalog();
    const before = modelsDev.getCatalogState();
    let failedCalls = 0;
    __testing.setTestHooks({ cachePath, fetchJson: async () => { failedCalls += 1; throw new Error('offline'); } });

    await expect(modelsDev.refreshCatalog()).rejects.toThrow('offline');
    const after = modelsDev.getCatalogState();
    expect(after.generation).toBe(before.generation);
    expect(after.sourceFetchedAt).toBe(before.sourceFetchedAt);
    expect(after).toMatchObject({ status: 'stale', lastError: 'offline' });
    const disk = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    expect(disk.data.deepseek.models.stable).toBeDefined();
    expect(disk).toMatchObject({ generation: before.generation, sourceFetchedAt: before.sourceFetchedAt, status: 'stale', lastError: 'offline' });
    const lastGood = await modelsDev.loadCatalog();
    expect(lastGood.providers.deepseek.models.stable).toBeDefined();
    expect(failedCalls).toBe(1);
  });

  it('quarantines a corrupt cache before rebuilding from the source', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelswap-models-dev-'));
    const cachePath = path.join(root, 'models-dev.json');
    await fs.writeFile(cachePath, '{not-json', 'utf8');
    __testing.setTestHooks({
      cachePath,
      fetchJson: async () => ({ openai: { api: 'https://api.openai.com/v1', models: { repaired: {} } } }),
    });

    const catalog = await modelsDev.loadCatalog();
    expect(catalog.providers.openai.models.repaired).toBeDefined();
    expect((await fs.readdir(root)).some(name => name.startsWith('models-dev.json.corrupt-'))).toBe(true);
    expect(JSON.parse(await fs.readFile(cachePath, 'utf8')).status).toBe('fresh');
  });
});
