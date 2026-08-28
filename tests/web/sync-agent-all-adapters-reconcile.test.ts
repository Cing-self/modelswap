import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const EXPECTED_AGENT_IDS = [
  'claude', 'codex', 'opencode', 'openclaw', 'workbuddy',
  'zcode', 'hermes', 'kimi-code', 'grok', 'mimo-code',
];

function reservePort() {
  const server = http.createServer();
  return new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('could not reserve mock port'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function run(root: string, home: string, script: string, blob: string) {
  return execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OKIT_SYNC_BLOB: blob },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('sync pull reconciles every registered Agent through local discovery', { timeout: 30000 }, () => {
  it('hydrates B-local models and writes every native Agent config from the dynamic registry', async () => {
    const root = path.resolve(__dirname, '../..');
    const machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-all-adapters-a-'));
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-all-adapters-b-'));
    const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-all-adapters-blob-'));
    const blob = path.join(blobDir, 'remote.json');
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;

    // This transport is deliberately confined to a child process.  It keeps
    // file-parallel Vitest workers from sharing a module cache, HOME, or sync
    // blob implementation with this A -> B acceptance fixture.
    const transport = String.raw`
      const Module=require('module'), transportFs=require('fs'); const original=Module.prototype.require;
      Module.prototype.require=function(id) {
        if (id === './platform-adapters/supabase') return {
          name:'Supabase', testConnection:async()=>true,
          pushSync:async (_config,_id,data)=>transportFs.writeFileSync(process.env.OKIT_SYNC_BLOB, JSON.stringify(data)),
          pullSync:async ()=>transportFs.existsSync(process.env.OKIT_SYNC_BLOB)?JSON.parse(transportFs.readFileSync(process.env.OKIT_SYNC_BLOB,'utf8')):null,
        };
        return original.apply(this,arguments);
      };
    `;
    const common = String.raw`
      const fs=require('fs'), path=require('path'), http=require('http'); const root=process.argv[1];
      ${transport}
      const api=require(path.join(root,'src/web/api/providers.js'));
      const sync=require(path.join(root,'src/web/api/cloud-sync-core.js'));
      const { VaultStore }=require(path.join(root,'src/vault/store'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error||JSON.stringify(v))):resolve(v)}}));
      const selectedRef='SYNC_ALL_ADAPTERS_PRIMARY_REF';
      const distractorRef='SYNC_ALL_ADAPTERS_DISTRACTOR_REF';
      // These fixture-only values are deliberately distinct and are never
      // serialized to the parent process. Adapters which natively accept
      // only an inline credential have no portable ref field to inspect, so
      // this proves the final native value came from the selected Vault ref.
      const selectedValue='fixture-selected-credential';
      const distractorValue='fixture-distractor-credential';
      const provider={
        id:'sync-all-adapters', name:'Sync all adapters', type:'openai', baseUrl:'${origin}/open/v1', authMode:'api_key', vaultKey:selectedRef,
        endpoints:[
          {id:'sync-all-openai',type:'openai',baseUrl:'${origin}/open/v1'},
          {id:'sync-all-anthropic',type:'anthropic',baseUrl:'${origin}/anthropic'},
        ], models:[],
      };
      const remote='sync-all-remote-v1';
      const startDirectory=()=>new Promise((resolve,reject)=>{
        const server=http.createServer((req,res)=>{
          res.setHeader('content-type','application/json');
          if(req.url==='/open/v1/models' || req.url==='/anthropic/v1/models') return res.end(JSON.stringify({data:[{id:remote,name:'Sync All Remote'}]}));
          res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
        });
        server.listen(${port},'127.0.0.1',error=>error?reject(error):resolve(server));
      });
    `;
    const push = `${common}
      (async()=>{
        const server=await startDirectory();
        const vault=new VaultStore();
        await vault.set(selectedRef,selectedValue);
        await vault.set(distractorRef,distractorValue);
        await call(api.createProvider,{body:provider});
        const discovery=await call(api.fetchModels,{body:{providerId:provider.id}});
        if(!discovery.modelsDiscovered) throw new Error('A fixture did not discover its remote model');
        const state={sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}},agentProviders:{}};
        for(const id of ${JSON.stringify(EXPECTED_AGENT_IDS)}) state.agentProviders[id]={activeProviderId:provider.id,activeModelId:remote,sites:{[provider.id]:{modelIds:[remote]}}};
        state.agentProviders.claude.sites[provider.id].tierMap={haiku:remote,sonnet:remote,opus:remote};
        await sync.saveConfig(state,{applyAgentProviders:true,applyModelOverrides:true});
        await sync.syncPush(); await new Promise(resolve=>server.close(resolve));
      })().catch(error=>{console.error(error.stack||error);process.exit(1)});
    `;
    const pull = `${common}
      (async()=>{
        const { AGENTS_META }=require(path.join(root,'src/providers/agentsMeta'));
        const { getAdapters }=require(path.join(root,'src/providers/registry'));
        const server=await startDirectory();
        const home=process.env.HOME, okit=path.join(home,'.okit'); fs.mkdirSync(okit,{recursive:true});
        // Same-ID catalog data supplements facts only; it cannot create a
        // second model row and allows tier/token mappings to be asserted.
        const now=new Date().toISOString(); fs.mkdirSync(path.join(okit,'cache'),{recursive:true});
        fs.writeFileSync(path.join(okit,'cache','models-dev.json'),JSON.stringify({source:'models.dev',version:2,generation:1,sourceFetchedAt:now,cachedAt:now,status:'fresh',data:{'sync-all-adapters':{models:{[remote]:{name:'Sync All Remote',limit:{context:123456,output:8192},reasoning:true,modalities:{input:['text'],output:['text']}}}}}}));
        await sync.saveConfig({sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}}});
        const result=await sync.syncPull();
        const read=(...parts)=>fs.readFileSync(path.join(home,...parts),'utf8');
        const claude=JSON.parse(read('.claude','settings.json'));
        const codex=read('.codex','config.toml');
        const opencode=JSON.parse(read('.config','opencode','opencode.json'));
        const openclaw=JSON.parse(read('.openclaw','openclaw.json'));
        const workbuddy=JSON.parse(read('.workbuddy','models.json'));
        const zcode=JSON.parse(read('.zcode','v2','config.json'));
        const zcodeCli=JSON.parse(read('.zcode','cli','config.json'));
        const hermes=read('.hermes','config.yaml');
        const kimi=read('.kimi-code','config.toml');
        const grok=read('.grok','config.toml');
        const mimo=JSON.parse(read('.config','mimocode','mimocode.jsonc'));
        const providersText=read('.okit','providers.json');
        const cache=JSON.parse(read('.okit','models-cache.json'));
        const vault=new VaultStore();
        const selectedValue=await vault.get(selectedRef);
        const distractorValue=await vault.get(distractorRef);
        // Never return either value. A selected-vs-distractor equality check
        // catches an incorrectly wired-but-present credential without leaking
        // a test key into the Vitest report.
        const isSelectedCredential=value=>typeof value==='string'&&value===selectedValue&&value!==distractorValue;
        const claudeHelperPath=path.join(home,'.claude','.okit-key-helper.sh');
        const claudeHelper=claude.apiKeyHelper===claudeHelperPath&&fs.existsSync(claudeHelperPath)?fs.readFileSync(claudeHelperPath,'utf8'):'';
        const claudeHelperValue=claudeHelper
          ? require('child_process').execFileSync('/bin/sh',[claudeHelperPath],{encoding:'utf8'}).trim()
          : undefined;
        const claudeAuth={
          helperPath:claude.apiKeyHelper===claudeHelperPath,
          executable:(fs.statSync(claudeHelperPath).mode&0o777)===0o700,
          selectedOutput:isSelectedCredential(claudeHelperValue),
        };
        const yaml=require('js-yaml').load(hermes);
        const tomlCredential=text=>{
          const match=/^api_key\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\")\\s*$/m.exec(text);
          return match?JSON.parse(match[1]):undefined;
        };
        const files={
          claude:claudeAuth.helperPath&&claudeAuth.executable&&claudeAuth.selectedOutput&&claude.env.ANTHROPIC_BASE_URL==='${origin}/anthropic'&&claude.env.ANTHROPIC_MODEL===remote&&claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL===remote,
          codex:codex.includes('model = "'+remote+'"')&&codex.includes('base_url = "${origin}/open/v1"')&&codex.includes('"vault", "get", "'+selectedRef+'"')&&!codex.includes('"vault", "get", "'+distractorRef+'"')&&!codex.includes('requires_openai_auth'),
          opencode:isSelectedCredential(opencode.provider['sync-all-adapters'].options.apiKey)&&opencode.provider['sync-all-adapters'].options.baseURL==='${origin}/open/v1'&&Boolean(opencode.provider['sync-all-adapters'].models[remote]),
          openclaw:isSelectedCredential(openclaw.models.providers['sync-all-adapters'].apiKey)&&openclaw.models.providers['sync-all-adapters'].baseUrl==='${origin}/open/v1'&&openclaw.agents.defaults.model.primary==='sync-all-adapters/'+remote,
          workbuddy:Array.isArray(workbuddy)&&workbuddy.some(item=>item.id===remote&&item.url==='${origin}/open/v1/chat/completions'&&isSelectedCredential(item.apiKey)),
          zcode:isSelectedCredential(zcode.provider['sync-all-adapters'].options.apiKey)&&zcode.provider['sync-all-adapters'].options.baseURL==='${origin}/open/v1'&&Boolean(zcode.provider['sync-all-adapters'].models[remote])&&zcodeCli.modelCatalog.overrides['sync-all-adapters/'+remote].supportsImages===false,
          hermes:isSelectedCredential(yaml.providers['sync-all-adapters'].api_key)&&yaml.providers['sync-all-adapters'].api==='${origin}/open/v1'&&yaml.providers['sync-all-adapters'].default_model===remote,
          'kimi-code':isSelectedCredential(tomlCredential(kimi))&&kimi.includes('base_url = "${origin}/open/v1"')&&kimi.includes('model = "'+remote+'"'),
          grok:isSelectedCredential(tomlCredential(grok))&&grok.includes('base_url = "${origin}/open/v1"')&&grok.includes('model = "'+remote+'"'),
          'mimo-code':isSelectedCredential(mimo.provider['sync-all-adapters'].options.apiKey)&&mimo.provider['sync-all-adapters'].options.baseURL==='${origin}/open/v1'&&Boolean(mimo.provider['sync-all-adapters'].models[remote]),
        };
        await new Promise(resolve=>server.close(resolve));
        console.log(JSON.stringify({metaIds:AGENTS_META.map(a=>a.id),registryIds:getAdapters().map(a=>a.id),result,files,claudeAuth,cacheIds:(cache.providers[provider.id]||[]).map(m=>m.id),providersHasRebuildable:/"models"\s*:|"platforms"\s*:|"modelCache"\s*:/.test(providersText)}));
      })().catch(error=>{console.error(error.stack||error);process.exit(1)});
    `;

    try {
      run(root, machineA, push, blob);
      const result = JSON.parse(run(root, machineB, pull, blob).trim());
      expect(result.metaIds).toEqual(EXPECTED_AGENT_IDS);
      expect(result.registryIds).toEqual(EXPECTED_AGENT_IDS);
      expect(result.result.agentModelHydration.warmed).toEqual(['sync-all-adapters']);
      expect(result.result.agentFailures).toEqual([]);
      expect(result.claudeAuth).toEqual({ helperPath: true, executable: true, selectedOutput: true });
      expect(result.cacheIds).toEqual(['sync-all-remote-v1']);
      expect(result.providersHasRebuildable).toBe(false);
      expect(result.files).toEqual(Object.fromEntries(EXPECTED_AGENT_IDS.map(id => [id, true])));
    } finally {
      fs.rmSync(machineA, { recursive: true, force: true });
      fs.rmSync(machineB, { recursive: true, force: true });
      fs.rmSync(blobDir, { recursive: true, force: true });
    }
  });
});
