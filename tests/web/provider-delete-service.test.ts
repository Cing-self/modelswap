import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

describe('provider deletion through Agent configuration service', { timeout: 30000 }, () => {
  it('removes only the deleted Codex registration and retains another managed provider', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-delete-service-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const fs=require('fs'), path=require('path'), api=require(path.join(process.argv[1],'src/web/api/providers.js'));
      const call=(h,r)=>new Promise((ok,no)=>h(r,{status(c){this.c=c;return this},json(v){(this.c||200)>=400?no(new Error(v.error)):ok(v)}}));
      (async()=>{for(const id of ['one','two']){const p={id,name:id,type:'openai',baseUrl:'https://'+id+'.test/v1',authMode:'none',models:[{id:id+'-model'}]};await call(api.createProvider,{body:p});await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:id},body:{modelIds:[id+'-model'],primaryModelId:id+'-model'}})}await call(api.deleteProvider,{params:{id:'one'}});const text=fs.readFileSync(path.join(process.env.HOME,'.codex','config.toml'),'utf8');console.log(JSON.stringify({text,catalog:fs.existsSync(path.join(process.env.HOME,'.codex','model-catalogs','model-catalogs.json'))}));})().catch(e=>{console.error(e.stack);process.exit(1)});
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    expect(result.text).not.toContain('modelswap-one');
    expect(result.text).toContain('modelswap-two');
    expect(result.catalog).toBe(true);
  });
});
