import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROBE = String.raw`
  const http=require('http'), path=require('path');
  const { WebSocket }=require('ws');
  const root=process.argv[1];
  const providerService=require(path.join(root,'src/application/provider-service.js'));
  const { createServer }=require(path.join(root,'src/web/server.js'));
  const extension=require(path.join(root,'src/web/api/ws-extension.js'));
  // A malformed dependency rejection was the released failure shape. Keep
  // this at the real POST route instead of merely unit-testing a fake res.
  providerService.discoverMissingConfiguredModels=async()=>Promise.reject(undefined);
  const app=createServer(0);
  const server=http.createServer(app);
  const wss=extension.setupWebSocket(server);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const close=async ws=>{
    if(ws.readyState===ws.OPEN) ws.close();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));
  };
  (async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port, base='http://127.0.0.1:'+port;
    const token=extension.issueExtensionToken();
    const ws=new WebSocket('ws://127.0.0.1:'+port+'/ws/extension',{origin:'chrome-extension://p0-resilience'});
    await new Promise((resolve,reject)=>{
      ws.once('open',()=>ws.send(JSON.stringify({type:'auth',token})));
      ws.on('message',raw=>{
        const message=JSON.parse(raw.toString());
        if(message.type==='auth-ok') { ws.send(JSON.stringify({type:'hello',version:'fixture',protocol:'atomic'})); resolve(); }
      });
      ws.once('error',reject);
      ws.once('close',()=>reject(new Error('extension closed before auth')));
    });
    await wait(15);
    const before=await (await fetch(base+'/ping')).json();
    const warmup=await fetch(base+'/api/providers/warmup-missing-models',{method:'POST'});
    const warmupBody=await warmup.json();
    const after=await (await fetch(base+'/ping')).json();
    const diagnostics=await (await fetch(base+'/api/diagnostics')).json();
    const connected=extension.isExtensionConnected()&&ws.readyState===ws.OPEN;
    await close(ws);
    console.log('RESULT'+JSON.stringify({before,warmupStatus:warmup.status,warmupBody,after,diagnostics,connected}));
  })().catch(error=>{console.error(error && error.stack || String(error));process.exit(1)});
`;

describe('warmup failures do not take down the desktop web service', { timeout: 30000 }, () => {
  it('keeps ping, diagnostics, and an authenticated Chrome extension connection alive', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelswap-server-warmup-resilience-'));
    const root = path.resolve(__dirname, '../..');
    try {
      const stdout = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', PROBE, root], {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = JSON.parse(stdout.slice(stdout.indexOf('RESULT') + 'RESULT'.length));
      expect(result.before).toEqual({ ok: true });
      expect(result.warmupStatus).toBe(500);
      expect(result.warmupBody).toEqual({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      expect(result.after).toEqual({ ok: true });
      expect(result.diagnostics.extension).toMatchObject({ connected: true, version: 'fixture', protocol: 'atomic' });
      expect(result.connected).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
