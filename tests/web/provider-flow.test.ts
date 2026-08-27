import { describe, expect, it } from 'vitest';
import { mergeAgentProviders } from '../../src/config/user';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const { removeSite } = require('../../src/web/api/agent-providers.js');

// Each it() boots a child node with ts-node/register to exercise the real
// API surface; cold compilation alone can exceed the 5s default timeout.
describe('provider flow source of truth', { timeout: 30000 }, () => {
  it('writes each Claude tier from its own routed ID and resolved facts when a tier map reapplies the active site', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-claude-tier-route-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path');
      const api=require(path.join(process.argv[1], 'src/web/api/providers.js'));
      const call=(handler, req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      (async()=>{
        const provider={id:'glm-like',name:'GLM-like',type:'anthropic',baseUrl:'https://glm-like.test/anthropic',authMode:'none',endpoints:[{id:'glm-anthropic',type:'anthropic',baseUrl:'https://glm-like.test/anthropic'}],models:[
          {id:'canonical-model',name:'GLM 5.3',meta:{source:'modelsdev',description:'Gateway GLM model',context:1000000,output:131072,reasoning:true,reasoningOptions:[{type:'effort',values:['low','high','max']}],interleaved:{field:'reasoning_content'},modalities:{input:['text','image'],output:['text']}},availability:[{executionMode:'http_endpoint',endpointId:'glm-anthropic',remoteModelId:'remote-model-v2',status:'available',source:'remote'}]},
          {id:'canonical-flash',name:'GLM 5.3 Flash',meta:{source:'modelsdev',description:'Gateway GLM flash model',context:256000,output:32768,reasoning:true,reasoningOptions:[{type:'effort',values:['low','high']}],modalities:{input:['text'],output:['text']}},availability:[{executionMode:'http_endpoint',endpointId:'glm-anthropic',remoteModelId:'remote-flash-v2',status:'available',source:'remote'}]}
        ]};
        await call(api.createProvider,{body:provider});
        await call(api.configureAgentProvider,{params:{agentId:'claude',providerId:'glm-like'},body:{modelIds:['canonical-model','canonical-flash'],primaryModelId:'canonical-model'}});
        await call(api.setTierMap,{params:{providerId:'glm-like'},body:{haiku:'canonical-model',sonnet:'canonical-flash',opus:'canonical-model'}});
        const settings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json'),'utf8'));
        console.log(JSON.stringify(settings));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const settings = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    const env = settings.env;
    expect(env.ANTHROPIC_MODEL).toBe('remote-model-v2');
    for (const tier of ['HAIKU', 'OPUS']) {
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL`]).toBe('remote-model-v2');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`]).toBe('GLM 5.3');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`]).toBe('Gateway GLM model');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`]).toContain('thinking');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`]).toContain('effort');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`]).toContain('max_effort');
      expect(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`]).toContain('interleaved_thinking');
    }
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('remote-flash-v2');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('GLM 5.3 Flash');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION).toBe('Gateway GLM flash model');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('thinking,effort');
  });

  it('writes routed remote IDs through real Web switch and multi-model configuration paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-provider-route-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path');
      const api=require(path.join(process.argv[1], 'src/web/api/providers.js'));
      const call=(handler, req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      (async()=>{
        const provider={id:'mapped-route',name:'Mapped Route',type:'openai',baseUrl:'https://mapped-route.test/v1',authMode:'none',endpoints:[{id:'mapped-openai',type:'openai',baseUrl:'https://mapped-route.test/v1'}],models:[
          {id:'canonical-model',name:'Canonical Model',meta:{source:'modelsdev',context:200000,output:8192,reasoning:true,modalities:{input:['text','image'],output:['text']}},availability:[{executionMode:'http_endpoint',endpointId:'mapped-openai',remoteModelId:'remote-model-v2',status:'available',source:'remote'}]},
          {id:'canonical-secondary',name:'Canonical Secondary',availability:[{executionMode:'http_endpoint',endpointId:'mapped-openai',remoteModelId:'remote-secondary-v2',status:'available',source:'remote'}]}
        ]};
        await call(api.createProvider,{body:provider});
        await call(api.switchProvider,{body:{agentId:'codex',providerId:'mapped-route',modelId:'canonical-model'}});
        await call(api.configureAgentProvider,{params:{agentId:'opencode',providerId:'mapped-route'},body:{modelIds:['canonical-model','canonical-secondary'],primaryModelId:'canonical-model'}});
        const codex=fs.readFileSync(path.join(process.env.HOME,'.codex','config.toml'),'utf8');
        const opencode=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config','opencode','opencode.json'),'utf8'));
        console.log(JSON.stringify({codex,opencode}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    expect(result.codex).toContain('model = "remote-model-v2"');
    expect(result.codex).not.toContain('model = "canonical-model"');
    expect(Object.keys(result.opencode.provider['mapped-route'].models).sort()).toEqual(['remote-model-v2', 'remote-secondary-v2']);
    expect(result.opencode.provider['mapped-route'].models['remote-model-v2']).toMatchObject({ name: 'Canonical Model' });
  });

  it('runs API → store → Codex/Claude/OpenCode adapters in a temporary HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-provider-flow-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path');
      const api=require(path.join(process.argv[1], 'src/web/api/providers.js'));
      const call=(handler, req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      (async()=>{
        const open={id:'flow-open',name:'Flow Open',type:'openai',baseUrl:'https://flow.test/v1',vaultKey:'FLOW_OPEN_KEY',authMode:'none',models:[{id:'one',meta:{source:'modelsdev',context:262144}},{id:'two'}]};
        const claude={id:'flow-claude',name:'Flow Claude',type:'anthropic',baseUrl:'https://flow-claude.test',authMode:'none',models:[{id:'one'},{id:'two'}]};
        await call(api.createProvider,{body:open});
        const created=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','providers.json'),'utf8'));
        await call(api.updateProvider,{params:{id:'flow-open'},body:{name:'Flow Open Renamed',baseUrl:'https://flow-renamed.test/v1'}});
        await call(api.createProvider,{body:claude});
        const userPath=path.join(process.env.HOME,'.okit','user.json');
        fs.writeFileSync(userPath,JSON.stringify({modelOverrides:{'flow-open':{one:{context:777,output:333}}}}));
        await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:'flow-open'},body:{modelIds:['one','two'],primaryModelId:'one'}});
        await call(api.switchProvider,{body:{agentId:'codex',providerId:'flow-open',modelId:'two'}});
        await call(api.configureAgentProvider,{params:{agentId:'claude',providerId:'flow-claude'},body:{modelIds:['one','two'],primaryModelId:'one'}});
        await call(api.configureAgentProvider,{params:{agentId:'opencode',providerId:'flow-open'},body:{modelIds:['one','two'],primaryModelId:'one'}});
        const user=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','user.json'),'utf8'));
        const providers=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','providers.json'),'utf8'));
        const cache=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','models-cache.json'),'utf8'));
        const codex=fs.readFileSync(path.join(process.env.HOME,'.codex','model-catalogs','model-catalogs.json'),'utf8');
        const claudeSettings=fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json'),'utf8');
        const opencode=fs.readFileSync(path.join(process.env.HOME,'.config','opencode','opencode.json'),'utf8');
        console.log(JSON.stringify({created,user,providers,cache,codex:JSON.parse(codex),claude:JSON.parse(claudeSettings),opencode:JSON.parse(opencode)}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      // Windows resolves os.homedir() from USERPROFILE, not HOME; the parent
      // suite's isolated USERPROFILE must not leak into the child.
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    expect(result.created).toMatchObject({ version: 2 });
    expect(JSON.stringify(result.created)).not.toMatch(/"models"|"modelCache"|"platforms"/);
    expect(result.providers).toMatchObject({ version: 2 });
    expect(JSON.stringify(result.providers)).not.toMatch(/"models"|"modelCache"|"platforms"/);
    expect(result.providers.providers.find((provider: any) => provider.id === 'flow-open')).toMatchObject({
      name: 'Flow Open Renamed', baseUrl: 'https://flow-renamed.test/v1', vaultKey: 'FLOW_OPEN_KEY',
    });
    expect(result.user.agentProviders).toHaveProperty('codex');
    expect(result.user.agentProviders.codex.sites['flow-open'].modelIds).toEqual(['one', 'two']);
    expect(result.user.agentProviders.codex.activeProviderId).toBe('flow-open');
    expect(result.user.agentProviders.codex.activeModelId).toBe('two');
    expect(result.user.modelOverrides['flow-open'].one).toEqual({ context: 777, output: 333 });
    expect(result.cache.providers['flow-open'].map((model: any) => model.id)).toEqual(['one', 'two']);
    expect(result.codex.models).toHaveLength(2);
    expect(result.codex.models.find((model: any) => model.slug === 'one')).toMatchObject({
      context_window: 777,
      max_context_window: 777,
    });
    expect(result.claude.env.ANTHROPIC_MODEL).toBe('one');
    expect(Object.keys(result.opencode.provider['flow-open'].models)).toEqual(['one', 'two']);
  });

  it('uses real refresh, preview, home, tier-map, offline, and deletion API paths in a temporary HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-provider-lifecycle-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), http=require('http');
      const api=require(path.join(process.argv[1], 'src/web/api/providers.js'));
      const call=(handler, req={})=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      (async()=>{
        const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'remote-one'},{id:'remote-two'}]}));});
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const endpoint='http://127.0.0.1:'+server.address().port+'/v1';
        const catalogPath=path.join(process.env.HOME,'.okit','cache','models-dev.json'); fs.mkdirSync(path.dirname(catalogPath),{recursive:true});
        fs.writeFileSync(catalogPath,JSON.stringify({source:'models.dev',version:1,fetchedAt:new Date().toISOString(),data:{local:{api:endpoint,models:{'remote-one':{limit:{context:262144,output:8192},tool_call:true,reasoning:true,modalities:{input:['text']}},'remote-two':{limit:{context:131072,output:4096},modalities:{input:['text','image']}}}}}}));
        const open={id:'life-open',name:'Lifecycle Open',type:'openai',baseUrl:endpoint,authMode:'none',endpoints:[{id:'life-http',type:'openai',baseUrl:endpoint}],models:[{id:'selected-before-refresh',name:'Selected before refresh'},{id:'directory-only',name:'Directory only'}]};
        const claude={id:'life-claude',name:'Lifecycle Claude',type:'anthropic',baseUrl:endpoint,authMode:'none',models:[{id:'remote-one'},{id:'remote-two'}]};
        await call(api.createProvider,{body:open});
        await call(api.createProvider,{body:claude});
        await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:'life-open'},body:{modelIds:['selected-before-refresh'],primaryModelId:'selected-before-refresh'}});
        const beforePreview=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','user.json'),'utf8'));
        await call(api.fetchModels,{body:{providerId:'life-open',endpoints:[{id:'preview',type:'openai',baseUrl:endpoint}]}});
        const afterPreview=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','user.json'),'utf8'));
        const refreshed=await call(api.fetchModels,{body:{providerId:'life-open'}});
        await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:'life-open'},body:{modelIds:['remote-one','remote-two'],primaryModelId:'remote-one'}});
        await call(api.configureAgentProvider,{params:{agentId:'claude',providerId:'life-claude'},body:{modelIds:['remote-one','remote-two'],primaryModelId:'remote-one'}});
        await call(api.setTierMap,{params:{providerId:'life-claude'},body:{haiku:'remote-two',sonnet:'remote-one',opus:'remote-two'}});
        await call(api.configureAgentProvider,{params:{agentId:'opencode',providerId:'life-open'},body:{modelIds:['remote-one','remote-two'],primaryModelId:'remote-one'}});
        const homeResult=await call(api.getAdaptersList,{});
        const cachePath=path.join(process.env.HOME,'.okit','models-cache.json');
        const cacheBefore=fs.readFileSync(cachePath,'utf8');
        await new Promise(resolve=>server.close(resolve));
        const offline=await call(api.fetchModels,{body:{providerId:'life-open'}});
        const cacheAfter=fs.readFileSync(cachePath,'utf8');
        const userPath=path.join(process.env.HOME,'.okit','user.json');
        const withOverride=JSON.parse(fs.readFileSync(userPath,'utf8')); withOverride.modelOverrides={'life-open':{'remote-one':{context:777}}}; fs.writeFileSync(userPath,JSON.stringify(withOverride));
        await call(api.deleteProvider,{params:{id:'life-open'}});
        await call(api.deleteProvider,{params:{id:'life-claude'}});
        const user=JSON.parse(fs.readFileSync(userPath,'utf8'));
        const providers=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','providers.json'),'utf8'));
        const codexCatalogPath=path.join(process.env.HOME,'.codex','model-catalogs','model-catalogs.json');
        const codexCatalogExists=fs.existsSync(codexCatalogPath);
        const codex=codexCatalogExists?JSON.parse(fs.readFileSync(codexCatalogPath,'utf8')):null;
        const claudeSettings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json'),'utf8'));
        const opencode=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config','opencode','opencode.json'),'utf8'));
        console.log(JSON.stringify({beforePreview,afterPreview,refreshed,home:homeResult,offline,cacheBefore,cacheAfter,user,providers,codex,codexCatalogExists,claude:claudeSettings,opencode}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      // Windows resolves os.homedir() from USERPROFILE, not HOME; the parent
      // suite's isolated USERPROFILE must not leak into the child.
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    expect(result.afterPreview.agentProviders).toEqual(result.beforePreview.agentProviders);
    const refreshed = result.refreshed.models;
    expect(refreshed.find((model: any) => model.id === 'remote-one').availability[0]).toMatchObject({ status: 'available', source: 'remote' });
    expect(refreshed.find((model: any) => model.id === 'directory-only').availability[0]).toMatchObject({ status: 'unavailable', source: 'static' });
    for (const agentId of ['codex', 'claude', 'opencode']) {
      const site = result.home.adapters.find((adapter: any) => adapter.id === agentId).compatibleProviders
        .find((provider: any) => provider.id === (agentId === 'claude' ? 'life-claude' : 'life-open'));
      expect(site.models.map((model: any) => model.id)).toEqual(['remote-one', 'remote-two']);
    }
    expect(result.offline).toMatchObject({ success: false });
    expect(result.offline.kept.map((model: any) => model.id)).toContain('remote-one');
    expect(result.cacheAfter).toBe(result.cacheBefore);
    expect(result.user.modelOverrides?.['life-open']).toBeUndefined();
    expect(JSON.stringify(result.user)).not.toContain('life-open');
    expect(JSON.stringify(result.user)).not.toContain('life-claude');
    expect(JSON.stringify(result.providers)).not.toContain('life-open');
    expect(JSON.stringify(result.providers)).not.toContain('life-claude');
    expect(result.codexCatalogExists).toBe(false);
    expect(JSON.stringify(result.claude)).not.toContain('life-claude');
    expect(result.claude.env).toBeUndefined();
    expect(result.opencode.provider?.['life-open']).toBeUndefined();
  });

  it('migrates a legacy receiving site into its cache before merging synced v2 sites', () => {
    const root = path.resolve(__dirname, '../..');
    const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-target-'));
    const targetScript = `
      const fs=require('fs'), path=require('path'); const store=require(path.join(process.argv[1], 'src/providers/store')); const sync=require(path.join(process.argv[1], 'src/web/api/cloud-sync-core.js'));
      (async()=>{
        const dir=path.join(process.env.HOME,'.okit');fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'providers.json'),JSON.stringify({opaqueRoot:{keep:true},providers:[{id:'legacy-custom',name:'Legacy custom',type:'openai',baseUrl:'https://legacy.test/v1',vaultKey:'LOCAL_LEGACY_KEY',authMode:'none',opaqueSite:{keep:true},models:[{id:'local-only-model',name:'Local only',opaqueModel:{keep:true}}]}],platforms:[{derived:true}]}));
        await store.saveModelsCache({version:1,source:'okit',fetchedAt:'now',providers:{'legacy-custom':[ {id:'cache-only-model',name:'Cache only',source:'manual',confidence:'medium'} ]}});
        await sync.mergeSyncedProviderSites({providers:[{id:'legacy-custom',name:'Remote rename',type:'openai',baseUrl:'https://remote-legacy.test/v1',vaultKey:null,authMode:'none'},{id:'remote-site',name:'Remote site',type:'openai',baseUrl:'https://remote.test/v1',authMode:'none'}]});
        const providerFile=JSON.parse(fs.readFileSync(path.join(dir,'providers.json'),'utf8'));
        const cache=await store.loadModelsCache();const runtime=await store.loadProviders();
        const backups=fs.readdirSync(dir).filter(name=>name.startsWith('providers.json.pre-model-cache-'));
        console.log(JSON.stringify({providerFile,cache,runtime,backups}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const target = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', targetScript, root], {
      env: { ...process.env, HOME: targetHome, USERPROFILE: targetHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    expect(target.backups).toHaveLength(1);
    expect(target.providerFile).toMatchObject({ version: 2, opaqueRoot: { keep: true } });
    expect(JSON.stringify(target.providerFile)).not.toMatch(/"models"|"modelCache"|"platforms"/);
    expect(target.providerFile.providers.find((provider: any) => provider.id === 'legacy-custom')).toMatchObject({ opaqueSite: { keep: true } });
    expect(target.providerFile.providers.find((provider: any) => provider.id === 'legacy-custom').vaultKey).toBe('LOCAL_LEGACY_KEY');
    expect(target.providerFile.providers.find((provider: any) => provider.id === 'remote-site')).toMatchObject({ name: 'Remote site', baseUrl: 'https://remote.test/v1' });
    expect(target.cache.providers['legacy-custom'].map((model: any) => model.id).sort()).toEqual(['cache-only-model', 'local-only-model']);
    expect(target.cache.providers['legacy-custom'].find((model: any) => model.id === 'local-only-model').raw.opaqueModel).toEqual({ keep: true });
    expect(target.runtime.find((provider: any) => provider.id === 'legacy-custom').models.map((model: any) => model.id).sort()).toEqual(['cache-only-model', 'local-only-model']);
  });
  it('does not alter selection while a connection test is only a preview', () => {
    const before = { codex: { activeProviderId: 'site', activeModelId: 'a', sites: { site: { modelIds: ['a', 'b'] } } } };
    // The preview endpoint accepts temporary credentials/endpoints and must not
    // receive an agent selection patch. This test locks the persisted shape.
    expect(mergeAgentProviders(before, {})).toEqual(before);
  });

  it('selection of exactly two models is the exact dashboard/adapter input', () => {
    const state = mergeAgentProviders({}, { opencode: { activeProviderId: 'site', activeModelId: 'a', sites: { site: { modelIds: ['a', 'b'] } } } });
    expect(state.opencode.sites.site.modelIds).toEqual(['a', 'b']);
    expect(state.opencode.sites.site.modelIds).toHaveLength(2);
  });

  it('removes a site and its model selection without residual user state', () => {
    const config: any = { agentProviders: { codex: { activeProviderId: 'site', activeModelId: 'a', sites: { site: { modelIds: ['a', 'b'] } } } } };
    removeSite(config, 'codex', 'site');
    expect(config.agentProviders.codex).toBeUndefined();
  });

  it('preserves the explicit Claude three-tier map and OpenCode enabled state', () => {
    const state = mergeAgentProviders({}, {
      claude: { activeProviderId: 'site', activeModelId: 'sonnet', sites: { site: { modelIds: ['haiku', 'sonnet', 'opus'], tierMap: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' } } } },
      opencode: { sites: { site: { modelIds: ['a'], enabled: true } } },
    });
    expect(state.claude.sites.site.tierMap).toEqual({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' });
    expect(state.opencode.sites.site.enabled).toBe(true);
  });

  it('sync payload strips model caches and platform projections', () => {
    const { __testing } = require('../../src/web/api/cloud-sync-core.js');
    expect(__testing.stripRebuildableProviderData({ providers: [{ id: 'site', name: 'Site', models: [{ id: 'm' }], platforms: [{ id: 'derived' }], modelCache: { secret: false } }] })).toEqual([{ id: 'site', name: 'Site' }]);
  });
});
