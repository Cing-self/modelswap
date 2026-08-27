import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// This is intentionally a child-process integration test: the platform
// transport is a tiny in-memory-file stand-in, but syncPull, the application
// service and the Codex/Claude/OpenCode adapters are all the real modules.
// Each machine gets an isolated HOME/USERPROFILE, including on Windows CI.
describe('syncPull Agent configuration reconciliation', { timeout: 30000 }, () => {
  it('applies accepted A selections to B native configs, is idempotent, and retains a failed site', () => {
    const root = path.resolve(__dirname, '../..');
    const machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-agent-a-'));
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-agent-b-'));
    const blob = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'okit-sync-agent-blob-')), 'remote.json');
    const transport = `
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
    const shared = `
      const fs=require('fs'), path=require('path');
      const root=process.argv[1]; ${transport}
      const api=require(path.join(root,'src/web/api/providers.js'));
      const sync=require(path.join(root,'src/web/api/cloud-sync-core.js'));
      const call=(handler,req)=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error)):resolve(v)}}));
      const open={id:'sync-open',name:'Sync Open',type:'openai',baseUrl:'https://sync-open.test/v1',authMode:'none',endpoints:[{id:'open-endpoint',type:'openai',baseUrl:'https://sync-open.test/v1'}],models:[{id:'open-canonical',name:'Open Canonical',meta:{source:'modelsdev',context:123456},availability:[{executionMode:'http_endpoint',endpointId:'open-endpoint',remoteModelId:'open-remote-v9',status:'available',source:'remote'}]}]};
      const claude={id:'sync-claude',name:'Sync Claude',type:'anthropic',baseUrl:'https://sync-claude.test',authMode:'none',endpoints:[{id:'claude-endpoint',type:'anthropic',baseUrl:'https://sync-claude.test'}],models:[{id:'claude-canonical',name:'Claude Canonical',meta:{source:'modelsdev',context:654321},availability:[{executionMode:'http_endpoint',endpointId:'claude-endpoint',remoteModelId:'claude-remote-v8',status:'available',source:'remote'}]}]};
      const unavailable={id:'sync-unavailable',name:'Sync Unavailable',type:'openai',baseUrl:'https://unavailable.test/v1',authMode:'none',models:[{id:'unavailable-canonical'}]};
      const userPath=path.join(process.env.HOME,'.okit','user.json');
    `;
    const push = `${shared}
      (async()=>{
        for (const provider of [open,claude,unavailable]) await call(api.createProvider,{body:provider});
        await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:'sync-open'},body:{modelIds:['open-canonical'],primaryModelId:'open-canonical'}});
        await call(api.configureAgentProvider,{params:{agentId:'claude',providerId:'sync-claude'},body:{modelIds:['claude-canonical'],primaryModelId:'claude-canonical'}});
        await call(api.configureAgentProvider,{params:{agentId:'opencode',providerId:'sync-open'},body:{modelIds:['open-canonical'],primaryModelId:'open-canonical'}});
        const user=JSON.parse(fs.readFileSync(userPath,'utf8'));
        user.agentProviders.openclaw={activeProviderId:'sync-unavailable',activeModelId:'unavailable-canonical',sites:{'sync-unavailable':{modelIds:['unavailable-canonical']}}};
        user.sync={password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}};
        fs.writeFileSync(userPath,JSON.stringify(user));
        await sync.syncPush();
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', push, root], {
      env: { ...process.env, HOME: machineA, USERPROFILE: machineA, OKIT_SYNC_BLOB: blob }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pull = `${shared}
      (async()=>{
        // B has local model caches for the three successful sites but no cache
        // for sync-unavailable, exactly the recoverable per-site failure.
        for (const provider of [open,claude]) await call(api.createProvider,{body:provider});
        fs.mkdirSync(path.dirname(userPath),{recursive:true});
        fs.writeFileSync(userPath,JSON.stringify({sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}}}}));
        const first=await sync.syncPull(); const second=await sync.syncPull();
        const user=JSON.parse(fs.readFileSync(userPath,'utf8'));
        const codex=fs.readFileSync(path.join(process.env.HOME,'.codex','config.toml'),'utf8');
        const claudeSettings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json'),'utf8'));
        const opencode=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config','opencode','opencode.json'),'utf8'));
        console.log(JSON.stringify({first,second,user,codex,claudeSettings,opencode}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', pull, root], {
      env: { ...process.env, HOME: machineB, USERPROFILE: machineB, OKIT_SYNC_BLOB: blob }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());

    expect(result.user.agentProviders.codex).toMatchObject({ activeProviderId: 'sync-open', activeModelId: 'open-canonical' });
    expect(result.user.agentProviders.claude).toMatchObject({ activeProviderId: 'sync-claude', activeModelId: 'claude-canonical' });
    expect(result.user.agentProviders.opencode.sites['sync-open'].modelIds).toEqual(['open-canonical']);
    expect(result.codex).toContain('model = "open-remote-v9"');
    expect(result.claudeSettings.env.ANTHROPIC_MODEL).toBe('claude-remote-v8');
    expect(result.opencode.provider['sync-open'].models['open-remote-v9']).toBeDefined();
    expect(result.first.agentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'openclaw', providerId: 'sync-unavailable', code: 'MODEL_NOT_FOUND' }),
    ]));
    expect(result.user.agentProviders.openclaw.sites['sync-unavailable'].modelIds).toEqual(['unavailable-canonical']);
    expect(result.second.agentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'openclaw', providerId: 'sync-unavailable' }),
    ]));
  });
});
