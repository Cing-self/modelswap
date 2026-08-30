import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

function reservePort() {
  const server = http.createServer();
  return new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve mock port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('sync pull agent model hydration', { timeout: 30000 }, () => {
  it('rebuilds B-local model membership before reconciling native Agent configs', async () => {
    const root = path.resolve(__dirname, '../..');
    const machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-hydration-a-'));
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-hydration-b-'));
    const blob = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-hydration-blob-')), 'remote.json');
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const transport = `
      const Module=require('module'), transportFs=require('fs'); const original=Module.prototype.require;
      Module.prototype.require=function(id) {
        if (id === 'http') {
          const http=original.apply(this,arguments);
          const patched=Object.create(http);
          patched.request=(target,...args)=>{
            const url=target instanceof URL?new URL(target.toString()):new URL(String(target));
            if(url.hostname==='qianfan.baidubce.com') {
              url.protocol='http:'; url.hostname='127.0.0.1'; url.port='${port}';
              target=url;
            }
            return http.request(target,...args);
          };
          return patched;
        }
        if (id === './platform-adapters/supabase') return {
          name:'Supabase', testConnection:async()=>true,
          pushSync:async (_config,_id,data)=>transportFs.writeFileSync(process.env.OKIT_SYNC_BLOB, JSON.stringify(data)),
          pullSync:async ()=>transportFs.existsSync(process.env.OKIT_SYNC_BLOB)?JSON.parse(transportFs.readFileSync(process.env.OKIT_SYNC_BLOB,'utf8')):null,
        };
        return original.apply(this,arguments);
      };
    `;
    const shared = `
      const fs=require('fs'), path=require('path');
      const root=process.argv[1]; ${transport}
      const api=require(path.join(root,'src/web/api/providers.js'));
      const sync=require(path.join(root,'src/web/api/cloud-sync-core.js'));
      const {VaultStore}=require(path.join(root,'src/vault/store'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      const userPath=path.join(process.env.HOME,'.okit','user.json');
      const providersPath=path.join(process.env.HOME,'.okit','providers.json');
      const cachePath=path.join(process.env.HOME,'.okit','models-cache.json');
      const syncOpen={id:'sync-open',name:'Sync Open',type:'openai',baseUrl:'${origin}/open/v1',endpoints:[{id:'sync-open-endpoint',type:'openai',baseUrl:'${origin}/open/v1'}],authMode:'api_key',vaultKey:'SYNC_OPEN_KEY',models:[{id:'sync-open-live'}]};
      const syncClaude={id:'sync-claude',name:'Sync Claude',type:'anthropic',baseUrl:'${origin}/claude',endpoints:[{id:'sync-claude-endpoint',type:'anthropic',baseUrl:'${origin}/claude'}],authMode:'api_key',vaultKey:'SYNC_CLAUDE_KEY',models:[{id:'sync-claude-live'}]};
      const qianfan={id:'qianfan-coding',name:'Qianfan Token Plan',type:'openai',baseUrl:'http://qianfan.baidubce.com/v2/tokenplan/personal',endpoints:[{id:'qianfan-openai',type:'openai',baseUrl:'http://qianfan.baidubce.com/v2/tokenplan/personal',plan:'token'},{id:'qianfan-anthropic',type:'anthropic',baseUrl:'http://qianfan.baidubce.com/anthropic/tokenplan/personal',plan:'token'}],authMode:'api_key',vaultKey:'QIANFAN_TOKEN_KEY',models:[]};
      const thirdCoding={id:'third-coding',name:'Third Coding',type:'openai',baseUrl:'${origin}/third/v2/coding',endpoints:[{id:'third-coding-openai',type:'openai',baseUrl:'${origin}/third/v2/coding'}],authMode:'api_key',vaultKey:'THIRD_CODING_KEY',models:[]};
      const thirdToken={id:'third-token',name:'Third Token',type:'openai',baseUrl:'${origin}/third/v2/tokenplan/personal',endpoints:[{id:'third-token-openai',type:'openai',baseUrl:'${origin}/third/v2/tokenplan/personal'}],authMode:'api_key',vaultKey:'THIRD_TOKEN_KEY',models:[]};
      const unavailable={id:'sync-offline',name:'Sync Offline',type:'openai',baseUrl:'${origin}/offline/v1',endpoints:[{id:'sync-offline-endpoint',type:'openai',baseUrl:'${origin}/offline/v1'}],authMode:'api_key',vaultKey:'SYNC_OFFLINE_KEY',models:[{id:'sync-offline-model'}]};
    `;
    const push = `${shared}
      (async()=>{
        fs.mkdirSync(path.dirname(userPath),{recursive:true});
        if(!fs.existsSync(userPath)) fs.writeFileSync(userPath,JSON.stringify({}));
        const vault=new VaultStore();
        await vault.set('SYNC_OPEN_KEY','open-secret');
        await vault.set('SYNC_CLAUDE_KEY','claude-secret');
        await vault.set('QIANFAN_TOKEN_KEY','qianfan-secret');
        await vault.set('THIRD_CODING_KEY','third-coding-secret');
        await vault.set('THIRD_TOKEN_KEY','third-token-secret');
        await vault.set('SYNC_OFFLINE_KEY','offline-secret');
        for (const provider of [syncOpen,syncClaude,qianfan,thirdCoding,thirdToken,unavailable]) await call(api.createProvider,{body:provider});
        // Write machine A's desired state through the semantic store API.
        // Provider creation fires fire-and-forget queued writes (saveProviders
        // -> markDirty -> recordLocalChanged), so a raw fs read-modify-write of
        // user.json here races those in-flight queue commits: a queued write
        // whose read predated the raw write lands after it and restores the
        // pre-write snapshot, dropping the sync section — syncPush then fails
        // with 请先设置同步密码. Store ops serialize on that same write queue,
        // which closes the window by construction.
        await sync.setSyncField('password','shared-secret');
        await sync.setPlatformField('supabase','enabled',true);
        await sync.setPlatformField('supabase','projectId','project');
        await sync.setPlatformField('supabase','apiToken','token');
        await sync.replaceAgentState('codex',{activeProviderId:'openai-codex',activeModelId:'gpt-5.6-sol',sites:{'openai-codex':{modelIds:['gpt-5.6-sol']}}});
        await sync.replaceAgentState('claude',{activeProviderId:'sync-claude',activeModelId:'sync-claude-live',sites:{'sync-claude':{modelIds:['sync-claude-live']}}});
        await sync.replaceAgentState('opencode',{sites:{'sync-open':{modelIds:['sync-open-live']},'qianfan-coding':{modelIds:['glm-5.1','glm-5.2']},'third-coding':{modelIds:['third-coding-live']},'third-token':{modelIds:['third-token-live']},'sync-offline':{modelIds:['sync-offline-model']}}});
        await sync.syncPush();
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', push, root], {
        env: { ...process.env, HOME: machineA, USERPROFILE: machineA, OKIT_SYNC_BLOB: blob },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });

    const pull = `${shared}
        (async()=>{
          const http=require('http');
          const requests=[];
          const server=http.createServer((req,res)=>{
            requests.push({url:req.url||'',authorization:req.headers.authorization,apiKey:req.headers['x-api-key']});
            res.setHeader('content-type','application/json');
            if(req.url==='/open/v1/models') return res.end(JSON.stringify({data:[{id:'sync-open-live'}]}));
            if(req.url==='/claude/v1/models') return res.end(JSON.stringify({data:[{id:'sync-claude-live',display_name:'Sync Claude Live'}]}));
            if(req.url==='/v2/models') return res.end(JSON.stringify({data:[{id:'glm-5.1'},{id:'glm-5.2'}]}));
            if(req.url==='/third/v2/coding/models') return res.end(JSON.stringify({data:[{id:'third-coding-live'}]}));
            if(req.url==='/third/v2/tokenplan/personal/models') return res.end(JSON.stringify({data:[{id:'third-token-live'}]}));
            res.statusCode=503; return res.end(JSON.stringify({error:'offline fixture'}));
          });
          await new Promise((resolve,reject)=>server.listen(${port},'127.0.0.1',error=>error?reject(error):resolve()));
          // B begins without provider sites or OKIT model cache. Codex's own
          // CLI cache is a separate local discovery source, not sync payload.
          fs.mkdirSync(path.join(process.env.HOME,'.codex'),{recursive:true});
          fs.writeFileSync(path.join(process.env.HOME,'.codex','models_cache.json'),JSON.stringify([{slug:'gpt-5.6-sol',display_name:'GPT 5.6 Sol'}]));
          const catalogPath=path.join(process.env.HOME,'.okit','cache','models-dev.json');
          const now=new Date().toISOString();
          fs.mkdirSync(path.dirname(catalogPath),{recursive:true});
          fs.writeFileSync(catalogPath,JSON.stringify({source:'models.dev',version:2,generation:1,sourceFetchedAt:now,cachedAt:now,status:'fresh',data:{'qianfan-coding':{api:'${origin}/v2',models:{'glm-5.1':{limit:{context:123456,output:8192},reasoning:true},'catalog-only':{limit:{context:999999}}}}}}));
          fs.writeFileSync(userPath,JSON.stringify({sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}}}));
          const before={providers:fs.existsSync(providersPath),cache:fs.existsSync(cachePath)};
          const first=await sync.syncPull();
          const providersAfterFirst=fs.readFileSync(providersPath,'utf8');
          const userAfterFirst=JSON.parse(fs.readFileSync(userPath,'utf8'));
          const cache=JSON.parse(fs.readFileSync(cachePath,'utf8'));
          // An explicit B-only manual model must survive subsequent sync pull
          // and a non-empty discovered cache must suppress repeat discovery.
          cache.providers['sync-open']=cache.providers['sync-open']||[];
          cache.providers['sync-open'].push({id:'b-manual-model',origin:'user',source:'manual',confidence:'medium'});
          fs.writeFileSync(cachePath,JSON.stringify(cache));
          const beforeSecondProviders=fs.readFileSync(providersPath,'utf8');
          const second=await sync.syncPull();
          const afterSecondProviders=fs.readFileSync(providersPath,'utf8');
          const afterCache=JSON.parse(fs.readFileSync(cachePath,'utf8'));
          const user=JSON.parse(fs.readFileSync(userPath,'utf8'));
          const codex=fs.readFileSync(path.join(process.env.HOME,'.codex','config.toml'),'utf8');
          const claudePath=path.join(process.env.HOME,'.claude','settings.json');
          const opencodePath=path.join(process.env.HOME,'.config','opencode','opencode.json');
          const claude=fs.existsSync(claudePath)?JSON.parse(fs.readFileSync(claudePath,'utf8')):null;
          const opencode=fs.existsSync(opencodePath)?JSON.parse(fs.readFileSync(opencodePath,'utf8')):null;
          await new Promise(resolve=>server.close(resolve));
          console.log(JSON.stringify({before,first,second,providersAfterFirst,beforeSecondProviders,afterSecondProviders,cache:afterCache,userAfterFirst,user,codex,claude,opencode,requests}));
        })().catch(error=>{console.error(error.stack);process.exit(1)});
      `;
    const result = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', pull, root], {
        env: { ...process.env, HOME: machineB, USERPROFILE: machineB, OKIT_SYNC_BLOB: blob },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());

      expect(result.before).toEqual({ providers: false, cache: false });
      expect(result.first.agentModelHydration.warmed, JSON.stringify(result.first)).toEqual(expect.arrayContaining([
        'openai-codex', 'sync-open', 'sync-claude',
        'qianfan-coding', 'third-coding', 'third-token',
      ]));
      expect(result.first.agentModelHydration.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerId: 'sync-offline', status: 'failed', code: 'MODEL_DISCOVERY_FAILED' }),
      ]));
      expect(result.cache.providers['sync-open']).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sync-open-live', source: 'remote' }),
        expect.objectContaining({ id: 'b-manual-model', origin: 'user', source: 'manual' }),
      ]));
      expect(result.cache.providers['sync-claude']).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sync-claude-live', source: 'remote' }),
      ]));
      expect(result.cache.providers['qianfan-coding']).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'glm-5.1', source: 'remote', context: 123456, reasoning: true }),
        expect.objectContaining({ id: 'glm-5.2', source: 'remote' }),
      ]));
      expect(result.cache.providers['qianfan-coding'].map((model: any) => model.id)).not.toContain('catalog-only');
      expect(result.cache.providers['third-coding']).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'third-coding-live', source: 'remote' })]));
      expect(result.cache.providers['third-token']).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'third-token-live', source: 'remote' })]));
      expect(result.cache.providers['openai-codex']).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'gpt-5.6-sol',
          availability: expect.arrayContaining([expect.objectContaining({ source: 'cli', executionMode: 'agent_native' })]),
        }),
      ]));
      const sites = JSON.parse(result.providersAfterFirst).providers;
      expect(sites.every((site: any) => !('models' in site) && !('platforms' in site) && !('modelCache' in site))).toBe(true);
      expect(result.beforeSecondProviders).toBe(result.afterSecondProviders);
      expect(result.userAfterFirst.sync.localChangedAt).toBeUndefined();
      expect(result.codex).toContain('model = "gpt-5.6-sol"');
      expect(result.claude.env.ANTHROPIC_MODEL).toBe('sync-claude-live');
      expect(result.opencode.provider['sync-open'].models['sync-open-live']).toBeDefined();
      expect(result.opencode.provider['qianfan-coding'].models['glm-5.1']).toBeDefined();
      expect(result.opencode.provider['qianfan-coding'].models['glm-5.2']).toBeDefined();
      expect(result.opencode.provider['third-coding'].models['third-coding-live']).toBeDefined();
      expect(result.opencode.provider['third-token'].models['third-token-live']).toBeDefined();
      expect(result.first.agentFailures).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'opencode', providerId: 'sync-offline', code: 'MODEL_NOT_FOUND' }),
      ]));
      expect(result.user.agentProviders.opencode.sites['sync-offline'].modelIds).toEqual(['sync-offline-model']);
      expect(result.cache.providers['sync-offline']).toBeUndefined();
      expect(result.requests.filter((request: any) => request.url === '/open/v1/models')).toHaveLength(1);
      expect(result.requests.filter((request: any) => request.url === '/claude/v1/models')).toHaveLength(1);
      expect(result.requests.filter((request: any) => request.url === '/v2/models')).toHaveLength(1);
      expect(result.requests.filter((request: any) => request.url === '/v2/tokenplan/personal/models')).toHaveLength(0);
      expect(result.requests.filter((request: any) => request.url === '/third/v2/coding/models')).toHaveLength(1);
      expect(result.requests.filter((request: any) => request.url === '/third/v2/tokenplan/personal/models')).toHaveLength(1);
      expect(result.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: '/open/v1/models', authorization: 'Bearer open-secret' }),
        expect.objectContaining({ url: '/claude/v1/models', apiKey: 'claude-secret' }),
        expect.objectContaining({ url: '/v2/models', authorization: 'Bearer qianfan-secret' }),
        expect.objectContaining({ url: '/third/v2/coding/models', authorization: 'Bearer third-coding-secret' }),
        expect.objectContaining({ url: '/third/v2/tokenplan/personal/models', authorization: 'Bearer third-token-secret' }),
      ]));
  });
});
