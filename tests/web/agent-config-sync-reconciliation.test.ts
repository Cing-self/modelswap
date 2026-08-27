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
  it('reconciles an empty B through missing-provider retry into native configs', () => {
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
      const open={id:'sync-open',name:'Sync Open',modelCatalogId:'sync-open-catalog',type:'openai',baseUrl:'https://sync-open.test/v1',authMode:'none',endpoints:[{id:'open-endpoint',type:'openai',baseUrl:'https://sync-open.test/v1'}],models:[{id:'open-canonical',name:'Open Canonical',meta:{source:'modelsdev',context:123456,output:7890,reasoning:true,reasoningOptions:[{type:'effort',values:['high']}],modalities:{input:['text','image']}},availability:[{executionMode:'http_endpoint',endpointId:'open-endpoint',remoteModelId:'open-canonical',status:'available',source:'remote'}]}]};
      const claude={id:'sync-claude',name:'Sync Claude',modelCatalogId:'sync-claude-catalog',type:'anthropic',baseUrl:'https://sync-claude.test',authMode:'none',endpoints:[{id:'claude-endpoint',type:'anthropic',baseUrl:'https://sync-claude.test'}],models:[{id:'claude-canonical',name:'Claude Canonical',meta:{source:'modelsdev',context:654321,reasoning:true,reasoningOptions:[{type:'effort',values:['high']}],modalities:{input:['text','image']}},availability:[{executionMode:'http_endpoint',endpointId:'claude-endpoint',remoteModelId:'claude-canonical',status:'available',source:'remote'}]}]};
      const unavailable={id:'sync-unavailable',name:'Sync Unavailable',type:'openai',baseUrl:'https://unavailable.test/v1',authMode:'none',models:[{id:'unavailable-canonical'}]};
      const userPath=path.join(process.env.HOME,'.okit','user.json');
    `;
    const push = `${shared}
      (async()=>{
        for (const provider of [open,claude,unavailable]) await call(api.createProvider,{body:provider});
        await call(api.configureAgentProvider,{params:{agentId:'codex',providerId:'sync-open'},body:{modelIds:['open-canonical'],primaryModelId:'open-canonical'}});
        await call(api.configureAgentProvider,{params:{agentId:'claude',providerId:'sync-claude'},body:{modelIds:['claude-canonical'],primaryModelId:'claude-canonical'}});
        await call(api.setTierMap,{params:{providerId:'sync-claude'},body:{haiku:'claude-canonical',sonnet:'claude-canonical',opus:'claude-canonical'}});
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
        // B starts with no provider sites or agent selection. Its models.dev
        // snapshot is an independent, rebuildable source — never A's local
        // models-cache — and provides model facts once the remote sites arrive.
        const catalogPath=path.join(process.env.HOME,'.okit','cache','models-dev.json');
        fs.mkdirSync(path.dirname(catalogPath),{recursive:true});
        const now=new Date().toISOString();
        fs.writeFileSync(catalogPath,JSON.stringify({source:'models.dev',version:2,generation:1,sourceFetchedAt:now,cachedAt:now,sourceHash:'fixture',status:'fresh',lastError:null,data:{
          'sync-open-catalog':{api:'https://sync-open.test/v1',models:{'open-canonical':{name:'Open Canonical',limit:{context:123456,output:7890},reasoning:true,reasoning_options:[{type:'effort',values:['high']}],modalities:{input:['text','image']}}}},
          'sync-claude-catalog':{api:'https://sync-claude.test',models:{'claude-canonical':{name:'Claude Canonical',limit:{context:654321},reasoning:true,reasoning_options:[{type:'effort',values:['high']}],modalities:{input:['text','image']}}}}
        }}));
        fs.mkdirSync(path.dirname(userPath),{recursive:true});
        // Simulate an incomplete pull where the selection arrives before its
        // site partition is eligible. Desired state remains, diagnostics are
        // per-site PROVIDER_NOT_FOUND, and no native config is written.
        fs.writeFileSync(userPath,JSON.stringify({sync:{password:'shared-secret',platforms:{supabase:{enabled:true,projectId:'project',apiToken:'token'}},localChangedAt:{providers:'9999-01-01T00:00:00.000Z'}}}));
        const first=await sync.syncPull();
        const hadNativeBeforeProvider=fs.existsSync(path.join(process.env.HOME,'.codex','config.toml'));
        const afterFirst=JSON.parse(fs.readFileSync(userPath,'utf8'));
        afterFirst.sync.localChangedAt.providers='1970-01-01T00:00:00.000Z';
        fs.writeFileSync(userPath,JSON.stringify(afterFirst));
        const second=await sync.syncPull(); const third=await sync.syncPull();
        const user=JSON.parse(fs.readFileSync(userPath,'utf8'));
        const codex=fs.readFileSync(path.join(process.env.HOME,'.codex','config.toml'),'utf8');
        const claudeSettings=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude','settings.json'),'utf8'));
        const opencode=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config','opencode','opencode.json'),'utf8'));
        console.log(JSON.stringify({first,second,third,hadNativeBeforeProvider,user,codex,claudeSettings,opencode}));
      })().catch(error=>{console.error(error.stack);process.exit(1)});
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', pull, root], {
      env: { ...process.env, HOME: machineB, USERPROFILE: machineB, OKIT_SYNC_BLOB: blob }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());

    expect(result.user.agentProviders.codex).toMatchObject({ activeProviderId: 'sync-open', activeModelId: 'open-canonical' });
    expect(result.user.agentProviders.claude).toMatchObject({ activeProviderId: 'sync-claude', activeModelId: 'claude-canonical' });
    expect(result.user.agentProviders.opencode.sites['sync-open'].modelIds).toEqual(['open-canonical']);
    expect(result.first.agentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'codex', providerId: 'sync-open', code: 'PROVIDER_NOT_FOUND' }),
      expect.objectContaining({ agentId: 'claude', providerId: 'sync-claude', code: 'PROVIDER_NOT_FOUND' }),
    ]));
    expect(result.hadNativeBeforeProvider).toBe(false);
    expect(result.second.providersApplied).toBe(true);
    expect(result.codex).toContain('model = "open-canonical"');
    expect(result.codex).toContain('model_context_window = 123456');
    expect(result.codex).toContain('model_supports_reasoning_summaries = true');
    expect(result.claudeSettings.env.ANTHROPIC_MODEL).toBe('claude-canonical');
    expect(result.claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES).toContain('thinking');
    expect(result.opencode.provider['sync-open'].models['open-canonical']).toBeDefined();
    expect(result.opencode.provider['sync-open'].models['open-canonical'].limit).toMatchObject({ context: 123456, output: 7890 });
    expect(result.second.agentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'openclaw', providerId: 'sync-unavailable', code: 'MODEL_NOT_FOUND' }),
    ]));
    expect(result.user.agentProviders.openclaw.sites['sync-unavailable'].modelIds).toEqual(['unavailable-canonical']);
    expect(result.third.agentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'openclaw', providerId: 'sync-unavailable' }),
    ]));
  });
});
