import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('usage provider path injection', { timeout: 30000 }, () => {
  it('uses the injected temporary providers path through registry and controller, including a missing file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-usage-provider-path-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      (async()=>{
        const providersPath=path.join(process.env.HOME,'.okit','providers.json');
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-usage-glm-vault-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), https=require('https'), {EventEmitter}=require('events');
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const {VaultStore}=require(path.join(process.argv[1], 'src/vault/store'));
      const call=(handler,req)=>new Promise(resolve=>handler(req,{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      (async()=>{
        const key='glm-test-'+('x'.repeat(40));
        const providersPath=path.join(process.env.HOME,'.okit','providers.json');
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
});
