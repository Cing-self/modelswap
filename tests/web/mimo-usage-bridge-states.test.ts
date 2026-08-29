import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROBE = String.raw`
  const Module=require('module'), path=require('path');
  const root=process.argv[1];
  let connected=false, cookieMode='none';
  const original=Module.prototype.require;
  Module.prototype.require=function(id) {
    if(id==='../web/api/ws-extension') return {
      isExtensionConnected:()=>connected,
      sendCommand:async action=>{
        if(action==='cookies') return {data:cookieMode==='valid'?[{name:'session',value:'fixture-session',domain:'.xiaomimimo.com',path:'/'}]:[]};
        if(action==='tabs') return {data:[]};
        return {ok:false};
      },
    };
    return original.apply(this,arguments);
  };
  const { createUsageBrowserStrategies }=require(path.join(root,'src/application/usage-browser-strategies.js'));
  const browser=createUsageBrowserStrategies({
    resolveVaultKey:async()=>undefined,
    createVaultStore:()=>({set:async()=>{},delete:async()=>{}}),
    httpRequest:async()=>({status:200,body:JSON.stringify({code:0,data:{usage:{items:[{name:'plan_total_token',used:25,limit:100}]}}})}),
    queryConsoleOnlyUsage:()=>({}), round1:value=>Math.round(value*10)/10, round4:value=>Math.round(value*10000)/10000,
    epochToISO:value=>String(value), accountBalanceResult:()=>null,
    MIMO_CONSOLE_URL:'https://platform.xiaomimimo.com/console/plan-manage',
    MIMO_BALANCE_CONSOLE_URL:'https://platform.xiaomimimo.com/console/balance',
    MIMO_BALANCE_URL:'https://platform.xiaomimimo.com/api/v1/balance',
    MIMO_SESSION_VAULT_KEY:'MIMO_SESSION',
  });
  (async()=>{
    const disconnected=await browser.queryXiaomiCodingUsage(undefined,'https://token-plan-sgp.xiaomimimo.com/v1');
    connected=true;
    const noSession=await browser.queryXiaomiCodingUsage(undefined,'https://token-plan-sgp.xiaomimimo.com/v1');
    cookieMode='valid';
    const validSession=await browser.queryXiaomiCodingUsage(undefined,'https://token-plan-sgp.xiaomimimo.com/v1');
    console.log('RESULT'+JSON.stringify({disconnected,noSession,validSession}));
  })().catch(error=>{console.error(error && error.stack || String(error));process.exit(1)});
`;

describe('MiMo bridge usage states', () => {
  it('distinguishes an offline bridge, missing SSO, and valid browser usage', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-mimo-bridge-state-'));
    const root = path.resolve(__dirname, '../..');
    try {
      const stdout = execFileSync(process.execPath, ['-e', PROBE, root], {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf('RESULT') + 'RESULT'.length));
      expect(result.disconnected).toMatchObject({ source: 'console', refreshPolicy: 'manual' });
      expect(result.disconnected.handoff).toEqual({
        notice: { key: 'usage.handoff.notice.pluginRefresh', params: { target: { key: 'usage.handoff.target.mimoConsole' } } },
      });

      expect(result.noSession).toMatchObject({ source: 'console', refreshPolicy: 'manual' });
      expect(result.noSession.handoff).toMatchObject({
        notice: { key: 'usage.handoff.notice.browserRefresh' },
        action: { key: 'usage.handoff.action.open', mode: 'extension', url: 'https://platform.xiaomimimo.com/console/plan-manage' },
      });

      expect(result.validSession).toMatchObject({ supported: true, source: 'browser' });
      expect(result.validSession.windows).toEqual([expect.objectContaining({ label: 'credits', usedPercent: 25, remainingCredits: 75 })]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
