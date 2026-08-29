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
      if (!address || typeof address === 'string') return reject(new Error('could not reserve mock port'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function child(root: string, home: string, blob: string, script: string) {
  return execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OKIT_SYNC_BLOB: blob },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('sync provider vault-reference reconciliation', { timeout: 30000 }, () => {
  it('keeps references through site edits, migrations, sync pull, discovery, and Codex reconciliation', async () => {
    const root = path.resolve(__dirname, '../..');
    const machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-vault-a-'));
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-vault-b-'));
    const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-vault-blob-'));
    const blob = path.join(blobDir, 'remote.json');
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
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
      const store=require(path.join(root,'src/providers/store'));
      const { VaultStore }=require(path.join(root,'src/vault/store'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error||JSON.stringify(v))):resolve(v)}}));
      const ref='SYNC_VAULT_REFERENCE', remote='sync-vault-remote-v1';
      const provider={id:'sync-vault-provider',name:'Sync Vault Provider',type:'openai',baseUrl:'${origin}/v1',authMode:'api_key',vaultKey:ref,endpoints:[{id:'sync-vault-openai',type:'openai',baseUrl:'${origin}/v1'}],models:[]};
      const startDirectory=()=>new Promise((resolve,reject)=>{const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:remote}]}));res.statusCode=404;res.end('{}')});server.listen(${port},'127.0.0.1',error=>error?reject(error):resolve(server))});
    `;
    const push = `${common}
      (async()=>{
        const server=await startDirectory();
        const vault=new VaultStore(); await vault.set(ref,'vault-secret-never-printed'); await vault.set('GLM_LOCAL_REFERENCE','glm-secret-never-printed');
        await call(api.createProvider,{body:provider});
        // Non-credential edits and an explicit models field must leave the
        // reference untouched; models are normalized into local cache only.
        await call(api.updateProvider,{params:{id:provider.id},body:{name:'Renamed sync vault provider',baseUrl:'${origin}/v1',endpoints:provider.endpoints,models:[{id:'manual-local',origin:'user'}]}});
        const afterEdit=(await store.getProvider(provider.id)).vaultKey;
        // Missing, null, and empty peer bindings are all non-destructive.
        for(const missing of [{}, {vaultKey:null}, {vaultKey:''}]) await store.mergeProviderSites([{...provider,name:'remote update',...missing}]);
        const afterMissing=(await store.getProvider(provider.id)).vaultKey;
        // Exercise the preset/endpoint migration path as well: a legacy
        // Qianfan-shaped remote update must not erase a local Vault reference.
        const glm=(await store.loadProviders()).find(item=>item.id==='glm-coding');
        await store.mergeProviderSites([{...glm,vaultKey:'GLM_LOCAL_REFERENCE'}]);
        await store.mergeProviderSites([{...glm,baseUrl:'https://open.bigmodel.cn/api/paas/v4',endpoints:[{type:'openai',baseUrl:'https://open.bigmodel.cn/api/paas/v4'}],vaultKey:null}]);
        const glmRef=(await store.getProvider('glm-coding')).vaultKey;
        await call(api.fetchModels,{body:{providerId:provider.id}});
        const config={sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}},agentProviders:{codex:{activeProviderId:provider.id,activeModelId:remote,sites:{[provider.id]:{modelIds:[remote]}}}}};
        await sync.patchSyncConfig(config.sync);
        for(const [agentId,selection] of Object.entries(config.agentProviders)) await sync.patchAgentSelection(agentId,selection);
        await sync.syncPush();
        const projection=await store.loadProviderSitesForSync(); const payload=fs.readFileSync(process.env.OKIT_SYNC_BLOB,'utf8');
        await new Promise(resolve=>server.close(resolve));
        console.log(JSON.stringify({afterEdit,afterMissing,glmRef,projectionRef:projection.find(item=>item.id===provider.id)?.vaultKey,projectionHasSecret:JSON.stringify(projection).includes('vault-secret-never-printed'),projectionHasModels:/"models"\s*:|"modelCache"\s*:|"platforms"\s*:/.test(JSON.stringify(projection)),payloadHasSecret:payload.includes('vault-secret-never-printed')}));
      })().catch(error=>{console.error(error.stack||error);process.exit(1)});
    `;
    const pull = `${common}
      (async()=>{
        const server=await startDirectory(); const home=process.env.HOME;
        fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
        // Reconciliation must actively remove this obsolete official-OAuth
        // flag from a third-party table and install only scoped Vault auth.
        fs.writeFileSync(path.join(home,'.codex','config.toml'),'[model_providers.okit-sync-vault-provider]\\nrequires_openai_auth = true\\n');
        await sync.patchSyncConfig({password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}});
        const result=await sync.syncPull();
        const providerAfter=await store.getProvider(provider.id);
        const cache=await store.loadModelsCache();
        const toml=fs.readFileSync(path.join(home,'.codex','config.toml'),'utf8');
        const vaultValue=await new VaultStore().get(ref);
        await new Promise(resolve=>server.close(resolve));
        console.log(JSON.stringify({result,ref:providerAfter?.vaultKey,cacheIds:(cache.providers[provider.id]||[]).map(m=>m.id),vaultResolved:Boolean(vaultValue),codex:{remote:toml.includes('model = "'+remote+'"'),scopedRef:toml.includes('"vault", "get", "'+ref+'"'),legacyOpenAiAuth:toml.includes('requires_openai_auth'),inlineSecret:toml.includes('vault-secret-never-printed')}}));
      })().catch(error=>{console.error(error.stack||error);process.exit(1)});
    `;

    try {
      const source = JSON.parse(child(root, machineA, blob, push).trim());
      const received = JSON.parse(child(root, machineB, blob, pull).trim());
      expect(source).toMatchObject({
        afterEdit: 'SYNC_VAULT_REFERENCE', afterMissing: 'SYNC_VAULT_REFERENCE', glmRef: 'GLM_LOCAL_REFERENCE',
        projectionRef: 'SYNC_VAULT_REFERENCE', projectionHasSecret: false, projectionHasModels: false, payloadHasSecret: false,
      });
      expect(received.result.agentFailures).toEqual([]);
      expect(received.ref).toBe('SYNC_VAULT_REFERENCE');
      expect(received.cacheIds).toEqual(['sync-vault-remote-v1']);
      expect(received.vaultResolved).toBe(true);
      expect(received.codex).toEqual({ remote: true, scopedRef: true, legacyOpenAiAuth: false, inlineSecret: false });
    } finally {
      fs.rmSync(machineA, { recursive: true, force: true });
      fs.rmSync(machineB, { recursive: true, force: true });
      fs.rmSync(blobDir, { recursive: true, force: true });
    }
  });
});
