import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('usage provider path injection', { timeout: 30000 }, () => {
  it('uses the injected temporary providers path through registry and controller, including a missing file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-usage-provider-path-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      (async()=>{
        const providersPath=path.join(process.env.HOME,'.modelswap','providers.json');
        fs.mkdirSync(path.dirname(providersPath),{recursive:true});
        fs.writeFileSync(providersPath,JSON.stringify({version:2,providers:[{
          id:'github-copilot',name:'GitHub Copilot',type:'openai',baseUrl:'https://api.githubcopilot.com',authMode:'oauth'
        }]}));
        const registry=await usage.queryUsage('github-copilot');
        const controller=await call(usage.getUsage,{params:{providerId:'github-copilot'}});
        fs.unlinkSync(providersPath);
        const missing=await usage.queryUsage('github-copilot');
        console.log(JSON.stringify({registry,controller,missing}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    expect(result.registry).toMatchObject({ supported: true, windows: [], source: 'console' });
    expect(result.controller).toMatchObject({
      status: 200,
      value: expect.objectContaining({ supported: true, windows: [], source: 'console', kind: 'subscription' }),
    });
    expect(result.missing).toMatchObject({ supported: false, error: 'Provider 不存在' });
    expect(JSON.stringify(result)).not.toContain('PROVIDERS_PATH is not defined');
  });

  it('resolves a real encrypted GLM vault key through controller, registry, and the usage request', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-usage-glm-vault-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), https=require('https'), {EventEmitter}=require('events');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const {VaultStore}=require(path.join(process.argv[1], 'src/vault/store'));
      const call=(handler,req)=>new Promise(resolve=>handler(req,{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      (async()=>{
        const key='glm-test-'+('x'.repeat(40));
        const providersPath=path.join(process.env.HOME,'.modelswap','providers.json');
        fs.mkdirSync(path.dirname(providersPath),{recursive:true});
        fs.writeFileSync(providersPath,JSON.stringify({version:2,providers:[{
          id:'glm-coding',name:'GLM Coding',type:'openai',baseUrl:'https://open.bigmodel.cn/api/paas/v4',authMode:'api_key',
          vaultKey:'TEST_GLM_KEY',authVerified:true
        }]}));
        await new VaultStore().set('TEST_GLM_KEY',key);
        let authorization;
        const original=https.request;
        https.request=(url,options,callback)=>{
          authorization=options.headers.Authorization;
          const response=new EventEmitter(); response.statusCode=200;
          process.nextTick(()=>{callback(response);response.emit('data',JSON.stringify({success:true,data:{limits:[{unit:3,percentage:12.5,nextResetTime:1760000000}]}}));response.emit('end');});
          const request=new EventEmitter();
          request.write=()=>{};request.setTimeout=()=>{};request.destroy=()=>{};request.end=()=>{};
          return request;
        };
        const result=await call(usage.getUsage,{params:{providerId:'glm-coding'}});
        https.request=original;
        console.log(JSON.stringify({keyLength:key.length,authorization,result}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    expect(result.keyLength).toBeGreaterThan(40);
    expect(result.authorization).toBe('glm-test-' + 'x'.repeat(40));
    expect(result.result).toMatchObject({
      status: 200,
      value: expect.objectContaining({
        supported: true,
        kind: 'subscription',
        windows: [expect.objectContaining({ label: '5h', usedPercent: 12.5 })],
      }),
    });
    expect(result.result.value.error || '').not.toContain('无可用 API Key');
  });

  it('injects regional Kimi and Moonshot origins, decrypts their keys, and sends bearer authorization', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-usage-kimi-moonshot-vault-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), http=require('http');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const {VaultStore}=require(path.join(process.argv[1], 'src/vault/store'));
      const call=(handler,req)=>new Promise(resolve=>handler(req,{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      const listen=(amount,calls)=>new Promise(resolve=>{
        const server=http.createServer((req,res)=>{
          calls.push({url:req.url,authorization:req.headers.authorization});
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify({data:{available_balance:amount}}));
        });
        server.listen(0,'127.0.0.1',()=>resolve(server));
      });
      (async()=>{
        const kimiCalls=[], moonshotCalls=[];
        const kimiServer=await listen(12.34,kimiCalls);
        const moonshotServer=await listen(56.78,moonshotCalls);
        const kimiOrigin='http://127.0.0.1:'+kimiServer.address().port+'/regional/kimi';
        const moonshotOrigin='http://127.0.0.1:'+moonshotServer.address().port+'/regional/moonshot';
        const providersPath=path.join(process.env.HOME,'.modelswap','providers.json');
        fs.mkdirSync(path.dirname(providersPath),{recursive:true});
        fs.writeFileSync(providersPath,JSON.stringify({version:2,providers:[
          {id:'kimi-coding',name:'Kimi',type:'openai',baseUrl:kimiOrigin,authMode:'api_key',vaultKey:'TEST_KIMI_KEY'},
          {id:'moonshot',name:'Moonshot',type:'openai',baseUrl:moonshotOrigin,authMode:'api_key',vaultKey:'TEST_MOONSHOT_KEY'}
        ]}));
        const vault=new VaultStore();
        await vault.set('TEST_KIMI_KEY','kimi-real-key-'+('k'.repeat(40)));
        await vault.set('TEST_MOONSHOT_KEY','moonshot-real-key-'+('m'.repeat(40)));
        const kimi=await call(usage.getUsage,{params:{providerId:'kimi-coding'}});
        const moonshot=await call(usage.getUsage,{params:{providerId:'moonshot'}});
        await new Promise(resolve=>kimiServer.close(resolve));
        await new Promise(resolve=>moonshotServer.close(resolve));
        console.log(JSON.stringify({kimi,moonshot,kimiCalls,moonshotCalls}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    expect(result.kimi).toMatchObject({
      status: 200,
      value: expect.objectContaining({ supported: true, kind: 'prepaid', windows: [expect.objectContaining({ remainingCredits: 12.34 })] }),
    });
    expect(result.moonshot).toMatchObject({
      status: 200,
      value: expect.objectContaining({ supported: true, kind: 'prepaid', windows: [expect.objectContaining({ remainingCredits: 56.78 })] }),
    });
    expect(result.kimiCalls).toEqual([{ url: '/v1/users/me/balance', authorization: 'Bearer kimi-real-key-' + 'k'.repeat(40) }]);
    expect(result.moonshotCalls).toEqual([{ url: '/v1/users/me/balance', authorization: 'Bearer moonshot-real-key-' + 'm'.repeat(40) }]);
    expect(JSON.stringify(result)).not.toContain('getOrigin is not defined');
  });

  it('returns a product state for every supported usage route without leaking implementation errors', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-usage-execution-matrix-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), https=require('https'), {EventEmitter}=require('events');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const listed={}; usage.getSupportedUsageProviders({}, {json(value){Object.assign(listed,value)}});
      const providers=listed.providers.filter(id=>id!=='openai-codex').map(id=>({id,name:id,type:'openai',authMode:'api_key'}));
      const providersPath=path.join(process.env.HOME,'.modelswap','providers.json');
      fs.mkdirSync(path.dirname(providersPath),{recursive:true});
      fs.writeFileSync(providersPath,JSON.stringify({version:2,providers}));
      const requests=[]; const original=https.request;
      https.request=(url,options,callback)=>{
        requests.push(String(url));
        const response=new EventEmitter(); response.statusCode=200;
        process.nextTick(()=>{callback(response);response.emit('data','{}');response.emit('end');});
        const request=new EventEmitter(); request.write=()=>{};request.setTimeout=()=>{};request.destroy=()=>{};request.end=()=>{};return request;
      };
      (async()=>{
        const results={};
        for (const id of listed.providers) results[id]=await usage.queryUsage(id);
        https.request=original;
        console.log(JSON.stringify({listed:listed.providers,results,requests}));
      })().catch(error=>{https.request=original;console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    expect(Object.keys(result.results).sort()).toEqual([...result.listed].sort());
    expect(Object.values(result.results).every((value: any) => value && typeof value === 'object')).toBe(true);
    expect(result.results.siliconflow).toMatchObject({
      supported: true,
      source: 'console',
      refreshPolicy: 'never',
      handoff: {
        notice: { key: 'usage.handoff.notice.console' },
        action: { key: 'usage.handoff.action.open', url: 'https://cloud.siliconflow.cn/' },
      },
    });
    expect(result.results['anthropic-agent']).toMatchObject({ supported: true, source: 'console' });
    expect(result.results.tencent).toMatchObject({ supported: true, source: 'console' });
    expect(result.results['opencode-go']).toMatchObject({
      supported: true,
      source: 'console',
      refreshPolicy: 'manual',
    });
    expect(result.results['qianfan-coding']).toMatchObject({
      supported: true,
      source: 'console',
      refreshPolicy: 'manual',
    });
    expect(result.results['qwen-coding']).toMatchObject({
      supported: true,
      source: 'console',
      refreshPolicy: 'never',
    });
    expect(Object.values(result.results)
      .filter((usage: any) => usage.source === 'console')
      .every((usage: any) => ['auto', 'manual', 'never'].includes(usage.refreshPolicy)))
      .toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ReferenceError|is not defined|HTTP 410/);
  });
});
