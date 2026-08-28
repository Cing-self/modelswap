import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('live model discovery is the sole runtime membership source', { timeout: 30000 }, () => {
  it('keeps GLM discovery/cache/views aligned and treats models.dev as same-id metadata only', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-live-model-source-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), http=require('http');
      const api=require(path.join(process.argv[1], 'src/application/provider-service.js'));
      (async()=>{
        let response='models';
        const server=http.createServer((req,res)=>{
          res.setHeader('content-type','application/json');
          if (response === 'models') return res.end(JSON.stringify({data:[
            {id:'glm-5.3',name:'GLM 5.3 from endpoint'},
            {id:'glm-live-only',name:'GLM Live Only'}
          ]}));
          if (response === 'empty') return res.end(JSON.stringify({data:[]}));
          res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const endpoint='http://127.0.0.1:'+server.address().port+'/v1';
        const catalogPath=path.join(process.env.HOME,'.okit','cache','models-dev.json');
        fs.mkdirSync(path.dirname(catalogPath),{recursive:true});
        fs.writeFileSync(catalogPath, JSON.stringify({
          source:'models.dev', version:2, generation:1, sourceFetchedAt:new Date().toISOString(), cachedAt:new Date().toISOString(), status:'fresh', data:{
            'glm-coding':{api:endpoint,models:{
              'glm-5.3':{limit:{context:1000000,output:131072},reasoning:true,tool_call:true},
              'glm-5.3-highspeed':{limit:{context:999999},reasoning:true},
              'glm-5.2-highspeed':{limit:{context:888888}},
              'glm-5v-turbo':{modalities:{input:['text','image']}},
              'glm-4.6v':{modalities:{input:['text','image']}}
            }}
          }
        }));
        await api.updateProvider('glm-coding',{baseUrl:endpoint,endpoints:[{id:'glm-live',type:'openai',baseUrl:endpoint}],authMode:'none',models:[{id:'manual-kept',name:'Manual kept',origin:'user'}]});
        const providersPath=path.join(process.env.HOME,'.okit','providers.json');
        const providersBefore=fs.readFileSync(providersPath,'utf8');
        const refreshed=await api.fetchModels({providerId:'glm-coding'});
        const cachePath=path.join(process.env.HOME,'.okit','models-cache.json');
        const cacheAfterRefresh=fs.readFileSync(cachePath,'utf8');
        const providersAfter=fs.readFileSync(providersPath,'utf8');
        const listed=await api.listProviders();
        const listedGlm=listed.providers.find(p=>p.id==='glm-coding');
        const adapters=await api.getAdaptersList();
        const homeGlm=adapters.adapters.find(a=>a.id==='codex').availableProviders.find(p=>p.id==='glm-coding');
        const store=require(path.join(process.argv[1], 'src/providers/store'));
        await store.refreshModelsFromCatalog();
        const catalogRefreshed=(await api.listProviders()).providers.find(p=>p.id==='glm-coding');
        const cacheAfterCatalog=fs.readFileSync(cachePath,'utf8');
        const demoBefore=fs.readFileSync(cachePath,'utf8');
        const demo=await api.getModelData();
        const demoAfter=fs.readFileSync(cachePath,'utf8');
        response='empty'; const empty=await api.fetchModels({providerId:'glm-coding'}); const cacheAfterEmpty=fs.readFileSync(cachePath,'utf8');
        response='not-found'; const unavailable=await api.fetchModels({providerId:'glm-coding'}); const cacheAfter404=fs.readFileSync(cachePath,'utf8');
        const reloaded=(await api.listProviders()).providers.find(p=>p.id==='glm-coding');
        response='models';
        const persisted=await api.fetchModels({providerId:'glm-coding',endpoints:[{id:'glm-persisted',type:'openai',baseUrl:endpoint}],persistConfig:true});
        const persistedSite=(await api.listProviders()).providers.find(p=>p.id==='glm-coding');
        await new Promise(resolve=>server.close(resolve));
        console.log(JSON.stringify({refreshed,providersBefore,providersAfter,cacheAfterRefresh,listed:listedGlm,home:homeGlm,catalogRefreshed,cacheAfterCatalog,demo,demoBefore,demoAfter,empty,unavailable,cacheAfterEmpty,cacheAfter404,reloaded,persisted,persistedSite}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    const ids = ['glm-5.3', 'glm-live-only', 'manual-kept'];
    const catalogOnly = ['glm-5.3-highspeed', 'glm-5.2-highspeed', 'glm-5v-turbo', 'glm-4.6v'];

    expect(result.refreshed.modelsDiscovered).toBe(true);
    expect(result.refreshed.models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    expect(result.listed.models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    expect(result.home.models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    expect(result.catalogRefreshed.models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    expect(result.demo.providers.find((provider: any) => provider.id === 'glm-coding').models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    expect(result.reloaded.models.map((model: any) => model.id).sort()).toEqual(ids.slice().sort());
    for (const snapshot of [result.refreshed.models, result.listed.models, result.home.models, result.reloaded.models]) {
      expect(snapshot.map((model: any) => model.id)).not.toEqual(expect.arrayContaining(catalogOnly));
    }
    expect(result.refreshed.models.find((model: any) => model.id === 'glm-5.3').meta).toMatchObject({ context: 1000000, reasoning: true });
    expect(result.providersAfter).toBe(result.providersBefore);
    expect(result.providersAfter).not.toContain('"models"');
    expect(result.demoAfter).toBe(result.demoBefore);
    expect(result.empty).toMatchObject({ success: false, modelsDiscovered: false });
    expect(result.unavailable).toMatchObject({ success: false, modelsDiscovered: false });
    expect(result.cacheAfterEmpty).toBe(result.cacheAfterCatalog);
    expect(result.cacheAfter404).toBe(result.cacheAfterCatalog);
    expect(result.persisted).toMatchObject({ success: true, modelsDiscovered: true });
    expect(result.persistedSite.endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'glm-persisted' })]));
  });
});
