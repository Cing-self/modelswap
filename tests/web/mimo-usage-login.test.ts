import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('MiMo browser-login controller', { timeout: 30000 }, () => {
  it('opens each MiMo card at its own console and never accepts an unrelated provider', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-mimo-usage-login-'));
    const root = path.resolve(__dirname, '../..');
    const script = `
      const path=require('path');
      const wsPath=path.join(process.argv[1], 'src/web/api/ws-extension.js');
      const commands=[];
      require.cache[require.resolve(wsPath)]={id:wsPath,filename:wsPath,loaded:true,exports:{
        isExtensionConnected:()=>true,
        sendCommand:async(action,params)=>{commands.push({action,params});return action==='navigate'?{ok:true,data:{tabId:'tab-'+commands.length}}:{ok:true}}
      }};
      const usage=require(path.join(process.argv[1], 'src/web/api/usage-controller.js'));
      const call=(handler,providerId)=>new Promise(resolve=>handler({params:{providerId}},{status(code){this.code=code;return this},json(value){resolve({status:this.code||200,value})}}));
      (async()=>{
        const coding=await call(usage.openXiaomiLogin,'xiaomi-coding');
        const api=await call(usage.openXiaomiLogin,'xiaomi');
        const close=await call(usage.closeXiaomiLoginWindow,'xiaomi');
        const unrelated=await call(usage.openXiaomiLogin,'github-copilot');
        console.log(JSON.stringify({coding,api,close,unrelated,commands}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());

    expect(result.coding).toMatchObject({
      status: 200,
      value: { success: true, url: 'https://platform.xiaomimimo.com/console/plan-manage' },
    });
    expect(result.api).toMatchObject({
      status: 200,
      value: { success: true, url: 'https://platform.xiaomimimo.com/console/balance' },
    });
    expect(result.close).toMatchObject({ status: 200, value: { success: true } });
    expect(result.unrelated).toMatchObject({
      status: 400,
      value: { success: false, error: '该 Provider 不支持浏览器登录' },
    });
    expect(result.commands).toEqual([
      { action: 'navigate', params: { url: 'https://platform.xiaomimimo.com/console/plan-manage', workspace: 'okit' } },
      { action: 'focus-window', params: { workspace: 'okit', hold: true } },
      { action: 'navigate', params: { url: 'https://platform.xiaomimimo.com/console/balance', workspace: 'okit' } },
      { action: 'focus-window', params: { workspace: 'okit', hold: true } },
      { action: 'close-window', params: { workspace: 'okit' } },
    ]);
  });
});
