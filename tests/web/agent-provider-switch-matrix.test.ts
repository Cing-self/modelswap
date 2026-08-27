import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/** Credential-free copy of the current Agent/site/model choices. Never read ~/.okit here. */
const MATRIX = {
  claude: {
    'opencode-zen': ['x-preview-f-free', 'hy3-free'],
    'kimi-coding-plan': ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'],
    moonshot: ['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'moonshot-v1-32k', 'moonshot-v1-8k', 'kimi-k2.5', 'moonshot-v1-128k', 'kimi-k2.7-code-highspeed', 'moonshot-v1-auto'],
    'opencode-go': ['hy3', 'minimax-m2.7', 'ox-alpha-free'],
    'glm-coding': ['glm-5.3', 'glm-5.2', 'glm-5-turbo'],
  },
  zcode: {
    'opencode-zen': ['deepseek-v4-flash-free', 'x-preview-f-free', 'hy3-free'],
    'xiaomi-coding': ['mimo-v2.5', 'mimo-v2.5-asr', 'mimo-v2.5-pro', 'mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign'],
    'qianfan-coding': ['glm-5.1', 'deepseek-v4-flash', 'qianfan-code-latest'],
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    openrouter: ['stealth/ox-alpha', 'mistralai/voxtral-small-24b-2507'],
  },
  opencode: {
    'xiaomi-coding': ['mimo-v2.5'],
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    'qianfan-coding': ['glm-5.2', 'ernie-5.1', 'deepseek-v4-pro'],
  },
  'mimo-code': {
    'qianfan-coding': ['ernie-5.1'],
    'opencode-zen': ['x-preview-f-free', 'hy3-free'],
  },
  grok: {
    'opencode-zen': ['x-preview-f-free', 'hy3-free'],
    'opencode-go': ['hy3', 'deepseek-v4-flash', 'ox-alpha-free'],
    'qianfan-coding': ['glm-5.2'],
    deepseek: ['deepseek-v4-flash'],
  },
  workbuddy: {
    deepseek: ['deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'deepseek-v4-flash'],
    'xiaomi-coding': ['mimo-v2.5-pro', 'mimo-v2.5'],
  },
  'kimi-code': {
    'xiaomi-coding': ['mimo-v2.5-pro', 'mimo-v2.5'],
    'opencode-go': ['glm-5.3', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'ox-alpha-free'],
  },
  codex: {
    'openai-codex': ['gpt-5.6-sol'],
    'opencode-go': ['ox-alpha-free', 'glm-5.1', 'glm-5.3'],
    openrouter: ['deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-pro', '~deepseek/deepseek-v4-flash-latest'],
  },
} as const;

const DISABLED = { agentId: 'kimi-code', providerId: 'deepseek', modelIds: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'] } as const;
const ADDITIVE = new Set(['workbuddy', 'zcode', 'kimi-code', 'grok', 'mimo-code', 'opencode']);
const CASES = Object.entries(MATRIX).flatMap(([agentId, sites]) => Object.entries(sites).flatMap(([providerId, modelIds]) => modelIds.map(modelId => ({ agentId, providerId, modelId, expectedIds: [...modelIds] }))));
type MatrixResult = { outcomes: Record<string, { success: boolean; active: boolean; selected: string[]; configContainsRoute: boolean; allSitesEnabled: boolean }>; user: any; providers: any; cache: any; disabledConfigContainsModels: boolean; reloadStable: boolean; outsideHomeTouched: boolean };
let result: MatrixResult;
const key = (agentId: string, providerId: string, modelId: string) => `${agentId}\u0000${providerId}\u0000${modelId}`;

describe('Agent × site × selected-model switch matrix', () => {
  beforeAll(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okit-agent-switch-matrix-'));
    const root = path.resolve(__dirname, '../..');
    const script = String.raw`
      const fs=require('fs'), path=require('path'), https=require('https');
      const matrix=JSON.parse(process.env.OKIT_MATRIX_JSON), disabled=JSON.parse(process.env.OKIT_DISABLED_JSON), root=process.argv[1];
      const cacheDir=path.join(process.env.HOME,'.okit','cache'); fs.mkdirSync(cacheDir,{recursive:true});
      fs.writeFileSync(path.join(cacheDir,'models-dev.json'),JSON.stringify({source:'models.dev',version:2,generation:1,sourceFetchedAt:new Date().toISOString(),cachedAt:new Date().toISOString(),sourceHash:'matrix-fixture',status:'fresh',lastError:null,data:{}}));
      https.get=()=>{throw new Error('network is forbidden in agent switch matrix')};
      const api=require(path.join(root,'src/web/api/providers.js'));
      const {PRESET_PROVIDERS}=require(path.join(root,'src/providers/presets'));
      const {loadProviders}=require(path.join(root,'src/providers/store'));
      const presets=new Map(PRESET_PROVIDERS.map(p=>[p.id,p]));
      const additive=new Set(['workbuddy','zcode','kimi-code','grok','mimo-code','opencode']);
      const call=(handler,req={})=>new Promise((resolve,reject)=>handler(req,{status(c){this.code=c;return this},json(v){(this.code||200)>=400?reject(new Error(v.error||JSON.stringify(v))):resolve(v)}}));
      const modelIdsByProvider={};
      for(const sites of Object.values(matrix)) for(const [providerId,modelIds] of Object.entries(sites)) modelIdsByProvider[providerId]=[...new Set([...(modelIdsByProvider[providerId]||[]),...modelIds])];
      modelIdsByProvider[disabled.providerId]=[...new Set([...(modelIdsByProvider[disabled.providerId]||[]),...disabled.modelIds])];
      const configText=async agentId=>{const view=await call(api.getAgentConfigFiles,{params:{agentId},query:{}});return view.files.filter(f=>f.exists&&typeof f.content==='string').map(f=>f.content).join('\\n')};
      (async()=>{
        for(const [providerId,ids] of Object.entries(modelIdsByProvider)){
          const preset=presets.get(providerId)||{id:providerId,name:providerId,type:'openai',baseUrl:'https://matrix.invalid/v1'};
          await call(api.createProvider,{body:{...preset,id:providerId,name:preset.name||providerId,authMode:'none',models:ids.map(id=>({id,name:id,meta:{source:'remote',context:128000}}))}});
        }
        for(const [agentId,sites] of Object.entries(matrix)) for(const [providerId,modelIds] of Object.entries(sites)) await call(api.configureAgentProvider,{params:{agentId,providerId},body:{modelIds,primaryModelId:modelIds[0]}});
        const userPath=path.join(process.env.HOME,'.okit','user.json'); const config=JSON.parse(fs.readFileSync(userPath,'utf8'));
        config.agentProviders[disabled.agentId].sites[disabled.providerId]={modelIds:disabled.modelIds,enabled:false}; fs.writeFileSync(userPath,JSON.stringify(config));
        const outcomes={};
        for(const [agentId,sites] of Object.entries(matrix)) for(const [providerId,modelIds] of Object.entries(sites)) for(const modelId of modelIds){
          const response=await call(api.switchProvider,{body:{agentId,providerId,modelId}}); const after=JSON.parse(fs.readFileSync(userPath,'utf8')); const state=after.agentProviders[agentId], site=state&&state.sites[providerId]; const contents=await configText(agentId); const routeModel=response.route&&response.route.remoteModelId;
          const allSitesEnabled=additive.has(agentId)?Object.keys(sites).every(id=>after.agentProviders[agentId].sites[id]&&after.agentProviders[agentId].sites[id].enabled!==false):true;
          outcomes[[agentId,providerId,modelId].join('\u0000')]={success:response.success===true,active:additive.has(agentId)||(state.activeProviderId===providerId&&state.activeModelId===modelId),selected:site?site.modelIds:[],configContainsRoute:typeof routeModel==='string'&&contents.includes(routeModel),allSitesEnabled};
        }
        const user=JSON.parse(fs.readFileSync(userPath,'utf8')), providers=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','providers.json'),'utf8')), cache=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.okit','models-cache.json'),'utf8')); const beforeReload=JSON.stringify(user.agentProviders); await loadProviders(); const reloaded=JSON.parse(fs.readFileSync(userPath,'utf8')); const disabledContents=await configText(disabled.agentId);
        console.log(JSON.stringify({outcomes,user,providers,cache,disabledConfigContainsModels:disabledContents.includes('api.deepseek.com'),reloadStable:beforeReload===JSON.stringify(reloaded.agentProviders),outsideHomeTouched:fs.existsSync('/Users/dolphin/.okit/.agent-switch-matrix-sentinel')||fs.existsSync('/Users/dolphin/.codex/.agent-switch-matrix-sentinel')}));
      })().catch(error=>{console.error(error&&error.stack||error);process.exit(1)});
    `;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, root], { env: { ...process.env, HOME: home, VITEST: 'true', OKIT_MATRIX_JSON: JSON.stringify(MATRIX), OKIT_DISABLED_JSON: JSON.stringify(DISABLED) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    result = JSON.parse(output.trim());
  }, 120_000);

  it('has 8 agents, 26 active sites, and 72 switch cases', () => {
    expect(CASES).toHaveLength(72);
    expect(new Set(CASES.map(item => `${item.agentId}\u0000${item.providerId}`)).size).toBe(26);
  });
  it.each(CASES)('$agentId / $providerId / $modelId keeps selection and writes the route', testCase => {
    expect(result.outcomes[key(testCase.agentId, testCase.providerId, testCase.modelId)]).toEqual({ success: true, active: true, selected: testCase.expectedIds, configContainsRoute: true, allSitesEnabled: true });
  });
  it('keeps the disabled Kimi Code / DeepSeek site disabled and absent from adapter output', () => {
    expect(result.user.agentProviders[DISABLED.agentId].sites[DISABLED.providerId]).toMatchObject({ modelIds: DISABLED.modelIds, enabled: false });
    expect(result.disabledConfigContainsModels).toBe(false);
  });
  it('keeps canonical provider/model persistence separate and reload-stable', () => {
    expect(result.providers.version).toBe(2); expect(JSON.stringify(result.providers)).not.toMatch(/"models"|"modelCache"|"platforms"/); expect(result.cache.version).toBe(2); expect(result.reloadStable).toBe(true); expect(result.outsideHomeTouched).toBe(false);
  });
});
