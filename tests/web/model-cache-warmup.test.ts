import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('configured model-cache startup warmup', { timeout: 30000 }, () => {
  it('discovers only missing configured sites once, bounds concurrency, and leaves sites/sync state untouched', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-model-cache-warmup-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), http=require('http');
      const controller=require(path.join(process.argv[1], 'src/web/api/providers-controller.js'));
      const service=require(path.join(process.argv[1], 'src/application/provider-service.js'));
      const {VaultStore}=require(path.join(process.argv[1], 'src/vault/store'));
      const call=(handler,req={})=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      (async()=>{
        const calls={}, active={value:0,max:0};
        const server=http.createServer(async (req,res)=>{
          const key=req.url.split('/')[1];
          calls[key]=(calls[key]||0)+1;
          active.value++; active.max=Math.max(active.max,active.value);
          await new Promise(resolve=>setTimeout(resolve,35));
          active.value--;
          res.setHeader('content-type','application/json');
          if (key==='missing-a') return res.end(JSON.stringify({data:[{id:'a-live'}]}));
          if (key==='missing-b') return res.end(JSON.stringify({data:[{id:'b-live'}]}));
          if (key==='empty') return res.end(JSON.stringify({data:[]}));
          res.statusCode=404; return res.end(JSON.stringify({error:'not found'}));
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+server.address().port;
        const okit=path.join(process.env.HOME,'.okit');
        fs.mkdirSync(path.join(okit,'cache'),{recursive:true});
        const site=(id,key)=>({id,name:id,type:'openai',baseUrl:base+'/'+id,authMode:'api_key',vaultKey:key,endpoints:[{id:id+'-endpoint',type:'openai',baseUrl:base+'/'+id}]});
        fs.writeFileSync(path.join(okit,'providers.json'),JSON.stringify({version:2,providers:[
          site('missing-a','WARM_A'),site('missing-b','WARM_B'),site('empty','WARM_EMPTY'),site('missing-fail','WARM_FAIL'),
          {id:'network-fail',name:'network-fail',type:'openai',baseUrl:'http://127.0.0.1:1/network',authMode:'api_key',vaultKey:'WARM_NETWORK',endpoints:[{id:'network-fail-endpoint',type:'openai',baseUrl:'http://127.0.0.1:1/network'}]},
          site('existing','WARM_EXIST'),{id:'unconfigured',name:'unconfigured',type:'openai',baseUrl:base+'/unconfigured',authMode:'none',endpoints:[{id:'none',type:'openai',baseUrl:base+'/unconfigured'}]}
        ]}));
        fs.writeFileSync(path.join(okit,'models-cache.json'),JSON.stringify({version:2,source:'okit',generation:0,sourceFetchedAt:null,cachedAt:'2026-08-28T00:00:00.000Z',sourceHash:null,status:'empty',lastError:null,providers:{
          existing:[{id:'existing-remote',source:'remote',confidence:'medium',origin:'remote'},{id:'existing-manual',source:'manual',confidence:'medium',origin:'user'}]
        }}));
        fs.writeFileSync(path.join(okit,'user.json'),JSON.stringify({sync:{lastSyncAt:'2026-08-28T00:00:00.000Z',localChangedAt:{providers:'2026-08-28T00:00:00.000Z'}},agentProviders:{}}));
        fs.writeFileSync(path.join(okit,'cache','models-dev.json'),JSON.stringify({source:'models.dev',version:2,generation:1,sourceFetchedAt:new Date().toISOString(),cachedAt:new Date().toISOString(),status:'fresh',data:{
          'missing-a':{api:'endpoint',models:{'a-live':{limit:{context:123456},reasoning:true},'a-catalog-only':{limit:{context:999999}}}},
          'missing-b':{api:'endpoint',models:{'b-live':{limit:{context:654321}},'b-catalog-only':{limit:{context:999999}}}}
        }}));
        const vault=new VaultStore();
        for (const key of ['WARM_A','WARM_B','WARM_EMPTY','WARM_FAIL','WARM_NETWORK','WARM_EXIST']) await vault.set(key,'token-'+key);
        const providersPath=path.join(okit,'providers.json'), userPath=path.join(okit,'user.json'), cachePath=path.join(okit,'models-cache.json');
        const providersBefore=fs.readFileSync(providersPath,'utf8'), userBefore=fs.readFileSync(userPath,'utf8');
        const existingBefore=JSON.stringify(JSON.parse(fs.readFileSync(cachePath,'utf8')).providers.existing);
        const [first,second]=await Promise.all([
          call(controller.warmupMissingModels), call(controller.warmupMissingModels)
        ]);
        const listed=await service.listProviders();
        const demo=await service.getModelData();
        const cacheAfter=fs.readFileSync(cachePath,'utf8');
        await new Promise(resolve=>server.close(resolve));
        const cache=JSON.parse(cacheAfter);
        console.log(JSON.stringify({calls,max:active.max,first,second,listed,demo,cache,existingBefore,existingAfter:JSON.stringify(cache.providers.existing),providersBefore,providersAfter:fs.readFileSync(providersPath,'utf8'),userBefore,userAfter:fs.readFileSync(userPath,'utf8')}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    const provider = (id: string) => result.listed.providers.find((item: any) => item.id === id);
    const demoProvider = (id: string) => result.demo.providers.find((item: any) => item.id === id);

    expect(result.calls).toMatchObject({ 'missing-a': 1, 'missing-b': 1, empty: 1, 'missing-fail': 1 });
    expect(result.calls.existing).toBeUndefined();
    expect(result.calls.unconfigured).toBeUndefined();
    expect(result.max).toBeLessThanOrEqual(2);
    expect(result.first.warmed.slice().sort()).toEqual(['missing-a', 'missing-b']);
    expect(provider('missing-a').models.map((model: any) => model.id)).toEqual(['a-live']);
    expect(provider('missing-b').models.map((model: any) => model.id)).toEqual(['b-live']);
    expect(provider('existing').models.map((model: any) => model.id).sort()).toEqual(['existing-manual', 'existing-remote']);
    expect(provider('empty').models).toEqual([]);
    expect(provider('missing-fail').models).toEqual([]);
    expect(provider('network-fail').models).toEqual([]);
    expect(demoProvider('missing-a').models.map((model: any) => model.id)).toEqual(['a-live']);
    expect(result.cache.providers['missing-a'][0]).toMatchObject({ id: 'a-live', source: 'remote', context: 123456, reasoning: true });
    expect(result.cache.providers['missing-a'].map((model: any) => model.id)).not.toContain('a-catalog-only');
    expect(result.cache.providers['missing-b'].map((model: any) => model.id)).not.toContain('b-catalog-only');
    expect(result.cache.providers.unconfigured).toBeUndefined();
    expect(result.cache.providers.empty).toBeUndefined();
    expect(result.cache.providers['missing-fail']).toBeUndefined();
    expect(result.cache.providers['network-fail']).toBeUndefined();
    expect(result.providersAfter).toBe(result.providersBefore);
    expect(result.userAfter).toBe(result.userBefore);
    expect(result.existingAfter).toBe(result.existingBefore);
  });
});
