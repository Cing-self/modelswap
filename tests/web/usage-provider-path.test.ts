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
});
