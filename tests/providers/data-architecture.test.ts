import { describe, expect, it } from 'vitest';
import { migrateProvidersData } from '../../src/providers/store';
import { resolveModel, resolveModelRoute } from '../../src/providers/routing';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const { __testing: providersApiTesting } = require('../../src/web/api/providers.js');

function runInTemporaryHome(script: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-data-architecture-'));
  const root = path.resolve(__dirname, '../..');
  const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
    // Windows resolves os.homedir() from USERPROFILE, not HOME; the parent
    // suite's isolated USERPROFILE must not leak into the child.
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim());
}

// Several it()s boot a child node with ts-node/register against a legacy
// fixture; the 40k-model migration alone can exceed the 5s default timeout.
describe('provider data architecture', { timeout: 30000 }, () => {
  it('keeps built-in and models.dev site identities stable instead of adding duplicate names', () => {
    const data: any = migrateProvidersData({ providers: [
      { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', authMode: 'api_key', models: [] },
      { id: 'modelsdev:openai-compatible', name: 'OpenAI Compatible', type: 'openai', baseUrl: 'https://relay.test/v1', authMode: 'api_key', models: [] },
    ] });
    expect(new Set(data.providers.map((site: any) => site.id)).size).toBe(data.providers.length);
    expect(data.providers.filter((site: any) => site.id === 'openai')).toHaveLength(1);
  });
  it('migrates a 40k-line legacy fixture idempotently without losing unknown fields', () => {
    const models = Array.from({ length: 40000 }, (_, index) => ({
      id: `model-${index}`, name: `Model ${index}`, opaqueModelField: { index },
    }));
    const legacy: any = {
      providers: [{ id: 'legacy', name: 'Legacy', type: 'openai', baseUrl: 'https://legacy.test/v1', authMode: 'api_key', models, opaqueSiteField: { keep: true } }],
      platforms: [{ rebuildable: true }], opaqueRootField: { keep: true },
    };

    const first: any = migrateProvidersData(legacy);
    const second = migrateProvidersData(first);

    expect(first).toEqual(second);
    expect(first.platforms).toBeUndefined();
    expect(first.opaqueRootField).toEqual({ keep: true });
    expect(first.providers.find((site: any) => site.id === 'legacy')).toMatchObject({ opaqueSiteField: { keep: true } });
    expect(first.providers.find((site: any) => site.id === 'legacy').models).toBeUndefined();
    // Model facts are no longer embedded in the provider document. Disk-level
    // migration coverage below exercises the independent cache file.
    expect(first).not.toHaveProperty('modelCache');
  });

  it('migrates a disk legacy provider document once, backs it up, and puts all model facts in models-cache.json', () => {
    const result = runInTemporaryHome(`
      const fs=require('fs'), path=require('path');
      const store=require(path.join(process.argv[1], 'src/providers/store'));
      (async()=>{
        const dir=path.join(process.env.HOME,'.okit'); fs.mkdirSync(dir,{recursive:true});
        const models=Array.from({length:1638},(_,index)=>({id:'legacy-'+index,name:'Legacy '+index,opaqueModelField:{index,padding:'x'.repeat(80)}}));
        const legacy={opaqueRootField:{keep:true},providers:[{id:'legacy-disk',name:'Legacy Disk',type:'openai',baseUrl:'https://legacy.test/v1',authMode:'none',opaqueSiteField:{keep:true},models}],platforms:[{rebuildable:true}]};
        const legacyText=JSON.stringify(legacy); fs.writeFileSync(path.join(dir,'providers.json'),legacyText);
        await store.loadProviders();
        const once=fs.readFileSync(path.join(dir,'providers.json'),'utf8');
        const cache=JSON.parse(fs.readFileSync(path.join(dir,'models-cache.json'),'utf8'));
        await store.loadProviders();
        const twice=fs.readFileSync(path.join(dir,'providers.json'),'utf8');
        const backups=fs.readdirSync(dir).filter(name=>name.startsWith('providers.json.pre-model-cache-'));
        console.log(JSON.stringify({legacyBytes:Buffer.byteLength(legacyText),siteBytes:Buffer.byteLength(once),once:JSON.parse(once),twice,backups,cache}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `);
    expect(result.backups).toHaveLength(1);
    expect(result.once).toMatchObject({ version: 2, opaqueRootField: { keep: true } });
    expect(result.once).not.toHaveProperty('models');
    expect(result.once).not.toHaveProperty('modelCache');
    expect(result.once).not.toHaveProperty('platforms');
    expect(result.once.providers.find((site: any) => site.id === 'legacy-disk')).toMatchObject({ opaqueSiteField: { keep: true } });
    expect(result.twice).toBe(JSON.stringify(result.once, null, 2));
    expect(result.cache.providers['legacy-disk']).toHaveLength(1638);
    expect(result.cache.providers['legacy-disk'][617].raw.opaqueModelField).toEqual({ index: 617, padding: 'x'.repeat(80) });
    expect(result.siteBytes / result.legacyBytes).toBeLessThanOrEqual(0.3);
  });

  it('uses user overrides before profile, models.dev, remote facts, and defaults', () => {
    const provider: any = { id: 'site', name: 'Site', type: 'openai', baseUrl: 'https://site.test/v1', authMode: 'api_key', models: [{ id: 'remote-only', meta: {
      source: 'modelsdev', description: 'Catalog model', family: 'deepseek', context: 200000, input: 190000,
      output: 16000, modalities: { input: ['text', 'image'], output: ['text'] }, toolCall: true, reasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }], structuredOutput: true, temperature: false,
      knowledge: '2026-01', releaseDate: '2026-02-01', openWeights: true, cost: { input: 1 },
    } }] };
    const result = resolveModel(provider, 'remote-only', { context: 180000, source: 'remote', confidence: 'medium' }, { context: 32000, name: 'My model' });
    expect(result).toMatchObject({
      id: 'remote-only', name: 'My model', description: 'Catalog model', family: 'deepseek', context: 32000,
      input: 190000, output: 16000, modalities: { input: ['text', 'image'], output: ['text'] }, tool: true,
      reasoning: true, reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }], structuredOutput: true,
      temperature: false, knowledge: '2026-01', releaseDate: '2026-02-01', openWeights: true, cost: { input: 1 },
    });
  });

  it('keeps an offline v2 metadata snapshot intact', () => {
    const cached: any = { version: 2, providers: [{ id: 'site', name: 'Site', type: 'openai', baseUrl: 'https://site.test/v1', authMode: 'api_key' }] };
    const migrated: any = migrateProvidersData(cached);
    expect(migrated.providers.find((provider: any) => provider.id === 'site')).toMatchObject(cached.providers[0]);
    expect(migrated).not.toHaveProperty('modelCache');
  });

  it('replaces old built-in DeepSeek rows with the current shared-directory models', () => {
    const result = runInTemporaryHome(`
      const fs=require('fs'), path=require('path');
      const store=require(path.join(process.argv[1], 'src/providers/store'));
      (async()=>{
        const dir=path.join(process.env.HOME,'.okit'); fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'providers.json'), JSON.stringify({version:2,providers:[{id:'deepseek',name:'DeepSeek',type:'openai',baseUrl:'https://api.deepseek.com',authMode:'api_key'}]}));
        fs.writeFileSync(path.join(dir,'models-cache.json'), JSON.stringify({version:1,source:'okit',fetchedAt:'now',providers:{deepseek:[
          {id:'deepseek-v4-flash',source:'legacy',confidence:'low'},
          {id:'deepseek-v4-pro',source:'legacy',confidence:'low'},
          {id:'deepseek-chat',source:'legacy',confidence:'low'},
          {id:'deepseek-reasoner',source:'legacy',confidence:'low'}
        ]}}));
        const catalogDir=path.join(dir,'cache'); fs.mkdirSync(catalogDir,{recursive:true});
        fs.writeFileSync(path.join(catalogDir,'models-dev.json'), JSON.stringify({source:'models.dev',version:1,fetchedAt:new Date().toISOString(),data:{deepseek:{api:'https://api.deepseek.com',models:{
          'deepseek-v4-flash':{limit:{context:128000,output:8192}},
          'deepseek-v4-pro':{limit:{context:128000,output:8192}},
          'deepseek-v4-flash-vision-exp':{limit:{context:128000,output:8192}}
        }}}}));
        const providers=await store.loadProviders();
        const cache=await store.loadModelsCache();
        console.log(JSON.stringify({ runtime:providers.find(p=>p.id==='deepseek').models.map(m=>m.id), cache:cache.providers.deepseek.map(m=>m.id) }));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `);
    const expected = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
    expect(result.runtime).toEqual(expected);
    expect(result.cache).toEqual(expected);
  });

  it('does not restore retired DeepSeek aliases merely because an old Agent selection references them', () => {
    const refreshed = providersApiTesting.replaceRemoteModels(
      {
        id: 'deepseek',
        models: [
          { id: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner' },
        ],
      },
      [
        { endpointId: 'deepseek:openai', model: { id: 'deepseek-v4-flash' } },
        { endpointId: 'deepseek:openai', model: { id: 'deepseek-v4-pro' } },
        { endpointId: 'deepseek:openai', model: { id: 'deepseek-v4-flash-vision-exp' } },
      ],
      new Set(['deepseek-chat', 'deepseek-reasoner']),
    );
    expect(refreshed.map((model: any) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ]);
  });

  it('keeps a remote-only model selectable while directory-only entries are unavailable', () => {
    const provider: any = { id: 'site', name: 'Site', type: 'openai', baseUrl: 'https://site.test/v1', endpoints: [{ id: 'ep', type: 'openai', baseUrl: 'https://site.test/v1' }], authMode: 'api_key', models: [
      { id: 'remote-only', availability: [{ executionMode: 'http_endpoint', endpointId: 'ep', remoteModelId: 'remote-only', status: 'available', source: 'remote' }] },
      { id: 'directory-only', availability: [{ executionMode: 'http_endpoint', endpointId: 'ep', remoteModelId: 'directory-only', status: 'unavailable', source: 'static' }] },
    ] };
    const adapter: any = { id: 'codex', supportedTypes: ['openai'] };
    expect(resolveModelRoute(provider, 'remote-only', adapter).remoteModelId).toBe('remote-only');
    expect(() => resolveModelRoute(provider, 'directory-only', adapter)).toThrow(/当前不可用|没有适用于/);
  });
});
