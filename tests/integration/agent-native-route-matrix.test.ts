import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

type AuditResult = {
  registeredAgents: string[];
  generatedProviders: number;
  combinations: Array<{ agentId: string; providerId: string; main: string; flash: string; mainRoute: string; flashRoute: string }>;
  verified: Array<{ agentId: string; providerId: string; modelId: string }>;
  excluded: Array<{ agentId: string; providerId: string; reason: string }>;
  cli: Array<{ agentId: string; providerId: string; route: string }>;
  failures: string[];
  openCodeRegression: { keys: string[]; canonicalIds: string[]; routes: string[]; limits: Array<{ context?: number; output?: number }> };
  crossEndpoint: { status: number; error: string };
  hermesConfigPath: string | null;
  claudeTier: Record<string, string>;
  reverse: { redErrors: string[]; greenErrors: string[] };
};

function runInTemporaryHome(script: string): AuditResult {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "okit-native-route-audit-"));
  const root = path.resolve(__dirname, "../..");
  try {
    return JSON.parse(execFileSync(process.execPath, ["-r", "ts-node/register", "-e", script, root], {
      env: { ...process.env, HOME: home, USERPROFILE: home, OKIT_AUDIT_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// This is deliberately an end-to-end test of the real CommonJS Web handlers
// and TypeScript adapters. The generated fixture has no credentials and all
// files live below the child process's temporary HOME. The source of the
// matrix is the current registry plus every current built-in HTTP site: preset
// data intentionally contains sites only, so we seed route records in that
// temporary model cache rather than reading a developer's mutable cache.
const auditScript = String.raw`
  const fs = require('fs'), path = require('path');
  const root = process.argv[1], home = process.env.HOME;
  const { PRESET_PROVIDERS } = require(path.join(root, 'src/providers/presets'));
  const { getAdapters } = require(path.join(root, 'src/providers/registry'));
  const routing = require(path.join(root, 'src/providers/routing'));
  const cacheDir = path.join(home, '.okit'); fs.mkdirSync(cacheDir, { recursive: true });
  const adapters = getAdapters();
  const httpSites = PRESET_PROVIDERS.filter(site => routing.providerExecutionMode(site) === 'http_endpoint');
  const endpointId = entry => entry.id;
  const fixtureModels = site => {
    const endpoints = routing.providerEndpointEntries(site);
    const special = site.id === 'glm-coding';
    const ids = special ? ['glm-5.3', 'glm-5.3-flash'] : ['audit-main', 'audit-flash'];
    return ids.map((id, index) => ({
      id,
      name: special ? (index === 0 ? 'GLM 5.3' : 'GLM 5.3 Flash') : (index === 0 ? 'Audit Main' : 'Audit Flash'),
      description: special ? (index === 0 ? 'GLM Coding primary facts' : 'GLM Coding flash facts') : (index === 0 ? 'Main resolved facts' : 'Flash resolved facts'),
      context: index === 0 ? 1000000 : 256000,
      output: index === 0 ? 131072 : 32768,
      reasoning: true,
      reasoningOptions: [{ type: 'effort', values: index === 0 ? ['low', 'high', 'max'] : ['low', 'high'] }],
      ...(index === 0 ? { interleaved: { field: 'reasoning_content' } } : {}),
      modalities: { input: index === 0 ? ['text', 'image'] : ['text'], output: ['text'] },
      source: 'remote', confidence: 'high',
      availability: endpoints.map((entry, endpointIndex) => ({
        executionMode: 'http_endpoint', endpointId: endpointId(entry),
        remoteModelId: 'routed-' + site.id + '-' + entry.endpoint.type + '-' + index + '-' + endpointIndex,
        status: 'available', source: 'remote',
      })),
    }));
  };
  const sites = httpSites.map(site => ({ ...site, authMode: 'none', vaultKey: undefined, models: [] }));
  const cache = {
    version: 2, source: 'okit', generation: 1, sourceFetchedAt: new Date().toISOString(), cachedAt: new Date().toISOString(), sourceHash: 'native-route-audit', status: 'fresh', lastError: null,
    providers: Object.fromEntries(httpSites.map(site => [site.id, fixtureModels(site)])),
  };
  fs.writeFileSync(path.join(cacheDir, 'providers.json'), JSON.stringify({ version: 2, providers: sites }));
  fs.writeFileSync(path.join(cacheDir, 'models-cache.json'), JSON.stringify(cache));
  const api = require(path.join(root, 'src/web/api/providers.js'));
  const { loadProviders } = require(path.join(root, 'src/providers/store'));
  const { providerUse } = require(path.join(root, 'src/commands/provider'));
  const call = (handler, req = {}) => new Promise((resolve, reject) => handler(req, {
    status(code) { this.code = code; return this; },
    json(value) { (this.code || 200) >= 400 ? reject(new Error(value.error || JSON.stringify(value))) : resolve(value); },
  }));
  const errors = [];
  const assert = (condition, message) => { if (!condition) errors.push(message); };
  const configText = async agentId => {
    if (agentId === 'hermes') {
      const file = path.join(home, '.hermes', 'config.yaml');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    const view = await call(api.getAgentConfigFiles, { params: { agentId }, query: { reveal: '1' } });
    return view.files.filter(file => file.exists && typeof file.content === 'string').map(file => file.content).join('\n');
  };
  (async () => {
    const providers = await loadProviders();
    const registeredAgents = adapters.map(adapter => adapter.id);
    const combinations = [], excluded = [], verified = [];
    for (const adapter of adapters) {
      for (const provider of providers) {
        if (adapter.id === 'claude' && provider.baseUrl === 'https://api.anthropic.com') {
          excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'official Claude endpoint intentionally clears third-party routed model fields' });
          continue;
        }
        if (routing.providerExecutionMode(provider) !== 'http_endpoint') {
          if (provider.nativeAgentIds && provider.nativeAgentIds.includes(adapter.id)) excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'agent_native: no HTTP routed model ID or third-party config write' });
          continue;
        }
        if (!routing.providerSupportsAdapter(provider, adapter)) {
          excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'no endpoint with an adapter-supported protocol' });
          continue;
        }
        if (adapter.id === 'codex' && /^https:\/\/qianfan\.baidubce\.com\//.test(provider.baseUrl || '')) {
          // Probed: qianfan exposes no OpenAI Responses endpoint (404), and the
          // codex adapter refuses chat-only endpoints at apply time.
          excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'qianfan has no OpenAI Responses endpoint; Codex requires it' });
          continue;
        }
        const models = provider.models || [];
        if (models.length < 2) { excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'temporary built-in model cache has fewer than two routeable models' }); continue; }
        let mainRoute, flashRoute;
        try { mainRoute = routing.resolveModelRoute(provider, models[0].id, adapter); flashRoute = routing.resolveModelRoute(provider, models[1].id, adapter); }
        catch (error) { excluded.push({ agentId: adapter.id, providerId: provider.id, reason: 'route unavailable: ' + error.message }); continue; }
        combinations.push({ agentId: adapter.id, providerId: provider.id, main: models[0].id, flash: models[1].id, mainRoute: mainRoute.remoteModelId, flashRoute: flashRoute.remoteModelId });
        for (const id of [models[0].id, models[1].id]) await call(api.configureAgentProvider, { params: { agentId: adapter.id, providerId: provider.id }, body: { modelIds: [id], primaryModelId: id } });
        // A → B → A exercises the same switch handler used by the dashboard.
        await call(api.switchProvider, { body: { agentId: adapter.id, providerId: provider.id, modelId: models[0].id } });
        let contents = await configText(adapter.id);
        assert(contents.includes(mainRoute.remoteModelId), adapter.id + '/' + provider.id + ': A did not write routed ID');
        verified.push({ agentId: adapter.id, providerId: provider.id, modelId: models[0].id });
        await call(api.switchProvider, { body: { agentId: adapter.id, providerId: provider.id, modelId: models[1].id } });
        contents = await configText(adapter.id);
        assert(contents.includes(flashRoute.remoteModelId), adapter.id + '/' + provider.id + ': B did not write routed ID');
        verified.push({ agentId: adapter.id, providerId: provider.id, modelId: models[1].id });
        await call(api.switchProvider, { body: { agentId: adapter.id, providerId: provider.id, modelId: models[0].id } });
        const user = JSON.parse(fs.readFileSync(path.join(home, '.okit', 'user.json'), 'utf8'));
        assert(user.agentProviders[adapter.id].activeProviderId === provider.id && user.agentProviders[adapter.id].activeModelId === models[0].id, adapter.id + '/' + provider.id + ': B remains current after A→B→A');
      }
    }
    // Exact OpenCode regression: two canonical selections must become two
    // remote keys while retaining their independently resolved token limits.
    const openCodeProvider = providers.find(provider => provider.id === 'openai');
    const openCodeModels = openCodeProvider.models;
    await call(api.configureAgentProvider, { params: { agentId: 'opencode', providerId: openCodeProvider.id }, body: { modelIds: openCodeModels.map(model => model.id), primaryModelId: openCodeModels[0].id } });
    const openCodeConfig = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    const openCodeRoutes = openCodeModels.map(model => routing.resolveModelRoute(openCodeProvider, model.id, adapters.find(adapter => adapter.id === 'opencode')).remoteModelId);
    const openCodeEntries = openCodeRoutes.map(id => openCodeConfig.provider[openCodeProvider.id].models[id]);
    const openCodeRegression = { keys: Object.keys(openCodeConfig.provider[openCodeProvider.id].models).sort(), canonicalIds: openCodeModels.map(model => model.id), routes: openCodeRoutes.sort(), limits: openCodeEntries.map(entry => entry.limit) };
    assert(openCodeRegression.keys.join('|') === openCodeRegression.routes.join('|'), 'OpenCode config keys are not exactly the two routed IDs');
    assert(openCodeRegression.canonicalIds.every(id => !openCodeRegression.keys.includes(id)), 'OpenCode config leaked canonical model keys');
    assert(openCodeEntries[0].limit.context === 1000000 && openCodeEntries[0].limit.output === 131072, 'OpenCode main resolved limits changed');
    assert(openCodeEntries[1].limit.context === 256000 && openCodeEntries[1].limit.output === 32768, 'OpenCode flash resolved limits changed');
    // A provider entry has one endpoint. Reject a mixed-endpoint selection
    // before adapters can serialize a misleading single base URL.
    const crossProvider = { id: 'cross-endpoint', name: 'Cross endpoint', type: 'openai', baseUrl: 'https://one.invalid/v1', authMode: 'none', endpoints: [{ id: 'cross-one', type: 'openai', baseUrl: 'https://one.invalid/v1' }, { id: 'cross-two', type: 'openai', baseUrl: 'https://two.invalid/v1' }], models: [
      { id: 'canonical-one', name: 'One', meta: { source: 'remote', context: 1 }, availability: [{ executionMode: 'http_endpoint', endpointId: 'cross-one', remoteModelId: 'remote-one', status: 'available', source: 'remote' }] },
      { id: 'canonical-two', name: 'Two', meta: { source: 'remote', context: 2 }, availability: [{ executionMode: 'http_endpoint', endpointId: 'cross-two', remoteModelId: 'remote-two', status: 'available', source: 'remote' }] },
    ] };
    await call(api.createProvider, { body: crossProvider });
    const crossEndpoint = await new Promise(resolve => api.configureAgentProvider({ params: { agentId: 'opencode', providerId: crossProvider.id }, body: { modelIds: ['canonical-one', 'canonical-two'], primaryModelId: 'canonical-one' } }, {
      status(code) { this.code = code; return this; },
      json(body) { resolve({ status: this.code || 200, error: body.error || '' }); },
    }));
    assert(crossEndpoint.status === 400, 'mixed-endpoint OpenCode selection did not return HTTP 400');
    assert(crossEndpoint.error.includes('不同端点'), 'mixed-endpoint OpenCode selection was not rejected clearly');
    const hermesView = await call(api.getAgentConfigFiles, { params: { agentId: 'hermes' }, query: { reveal: '1' } });
    const hermesFile = hermesView.files.find(file => file.exists);
    assert(hermesFile && hermesFile.path === '~/.hermes/config.yaml', 'Hermes Web config entry is not its actual YAML file');
    // The concrete GLM Coding Plan tier regression is intentionally selected
    // by its built-in site ID, while model/tier data still comes from the
    // generated temporary cache above.
    const glm = providers.find(provider => provider.id === 'glm-coding');
    const claude = adapters.find(adapter => adapter.id === 'claude');
    const primary = glm.models.find(model => model.id === 'glm-5.3');
    const flash = glm.models.find(model => model.id === 'glm-5.3-flash');
    await call(api.configureAgentProvider, { params: { agentId: 'claude', providerId: glm.id }, body: { modelIds: [primary.id, flash.id], primaryModelId: primary.id } });
    await call(api.setTierMap, { params: { providerId: glm.id }, body: { haiku: primary.id, sonnet: flash.id, opus: primary.id } });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env;
    const primaryRoute = routing.resolveModelRoute(glm, primary.id, claude).remoteModelId;
    const flashRoute = routing.resolveModelRoute(glm, flash.id, claude).remoteModelId;
    const tierChecks = env => {
      const tierErrors = [];
      const check = (condition, message) => { if (!condition) tierErrors.push(message); };
      for (const tier of ['HAIKU', 'OPUS']) {
        check(env['ANTHROPIC_DEFAULT_' + tier + '_MODEL'] === primaryRoute, tier + ' routed ID');
        check(env['ANTHROPIC_DEFAULT_' + tier + '_MODEL_NAME'] === primary.name, tier + ' name');
        check(env['ANTHROPIC_DEFAULT_' + tier + '_MODEL_DESCRIPTION'] === primary.meta.description, tier + ' description');
        check(env['ANTHROPIC_DEFAULT_' + tier + '_MODEL_SUPPORTED_CAPABILITIES'] === 'thinking,effort,max_effort,interleaved_thinking', tier + ' capabilities');
      }
      check(env.ANTHROPIC_DEFAULT_SONNET_MODEL === flashRoute, 'SONNET routed ID');
      check(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME === flash.name, 'SONNET name');
      check(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION === flash.meta.description, 'SONNET description');
      check(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES === 'thinking,effort', 'SONNET capabilities');
      return tierErrors;
    };
    const beforeMutation = fs.readFileSync(settingsPath, 'utf8');
    const broken = JSON.parse(beforeMutation);
    broken.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'corrupted-remote-model-id';
    broken.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = 'corrupted-tier-metadata';
    fs.writeFileSync(settingsPath, JSON.stringify(broken));
    const redErrors = tierChecks(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env);
    fs.writeFileSync(settingsPath, beforeMutation);
    const greenErrors = tierChecks(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env);
    // Real CLI path, no adapter/handler mock: one dynamically chosen routed
    // model per registered Agent. provider use writes the same native files.
    const cli = [];
    const originalLog = console.log; console.log = () => {};
    for (const adapter of adapters) {
      const candidate = combinations.find(item => item.agentId === adapter.id);
      if (!candidate) continue;
      await providerUse(candidate.providerId, { agent: adapter.id, model: candidate.main });
      const text = await configText(adapter.id);
      assert(text.includes(candidate.mainRoute), 'CLI ' + adapter.id + ': routed ID missing');
      cli.push({ agentId: adapter.id, providerId: candidate.providerId, route: candidate.mainRoute });
    }
    console.log = originalLog;
    console.log(JSON.stringify({ registeredAgents, generatedProviders: httpSites.length, combinations, verified, excluded, cli, failures: errors, openCodeRegression, crossEndpoint, hermesConfigPath: hermesFile && hermesFile.path, claudeTier: {
      haiku: settings.ANTHROPIC_DEFAULT_HAIKU_MODEL, sonnet: settings.ANTHROPIC_DEFAULT_SONNET_MODEL, opus: settings.ANTHROPIC_DEFAULT_OPUS_MODEL,
      haikuName: settings.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, sonnetName: settings.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, opusName: settings.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
    }, reverse: { redErrors, greenErrors } }));
  })().catch(error => { console.error(error && error.stack || error); process.exit(1); });
`;

describe("all registered Agent native routed-model acceptance", { timeout: 300_000 }, () => {
  const result = runInTemporaryHome(auditScript);
  if (process.env.OKIT_AUDIT_REPORT === "1") {
    const excludedByReason = result.excluded.reduce<Record<string, number>>((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      matrixCombinations: result.combinations.length,
      verifiedModels: result.verified.length,
      excluded: result.excluded.length,
      excludedByReason,
      cliVerifiedAgents: result.cli.map(item => item.agentId),
      failures: result.failures,
      openCodeRegression: result.openCodeRegression,
      crossEndpoint: result.crossEndpoint,
      hermesConfigPath: result.hermesConfigPath,
      claudeTier: result.claudeTier,
      reverse: result.reverse,
    }));
  }

  it("derives every registered Agent from the registry and verifies every routeable built-in HTTP site/model", () => {
    expect(result.registeredAgents).toEqual([
      "claude", "codex", "opencode", "openclaw", "workbuddy", "zcode", "hermes", "kimi-code", "grok", "mimo-code",
    ]);
    expect(result.generatedProviders).toBeGreaterThan(0);
    expect(new Set(result.combinations.map(item => item.agentId))).toEqual(new Set(result.registeredAgents));
    expect(result.verified).toHaveLength(result.combinations.length * 2);
    expect(result.excluded.every(item => item.reason.length > 0)).toBe(true);
  });

  it("uses endpoint remoteModelId rather than canonical IDs and leaves A current after A → B → A", () => {
    for (const combination of result.combinations) {
      expect(combination.mainRoute).not.toBe(combination.main);
      expect(combination.flashRoute).not.toBe(combination.flash);
    }
    expect(result.openCodeRegression.keys).toEqual(result.openCodeRegression.routes);
    expect(result.openCodeRegression.keys).not.toContain(result.openCodeRegression.canonicalIds[0]);
    expect(result.openCodeRegression.keys).not.toContain(result.openCodeRegression.canonicalIds[1]);
    expect(result.openCodeRegression.limits).toEqual([{ context: 1000000, output: 131072 }, { context: 256000, output: 32768 }]);
    expect(result.crossEndpoint).toMatchObject({ status: 400, error: expect.stringContaining("不同端点") });
    expect(result.hermesConfigPath).toBe("~/.hermes/config.yaml");
  });

  it("has no routed-ID or stale-current-selection failures", () => {
    expect(result.failures).toEqual([]);
  });

  it("preserves Claude GLM Coding Plan tier IDs and their individual metadata", () => {
    expect(result.claudeTier).toMatchObject({
      haikuName: "GLM 5.3", opusName: "GLM 5.3", sonnetName: "GLM 5.3 Flash",
    });
    expect(result.claudeTier.haiku).toBe(result.claudeTier.opus);
    expect(result.claudeTier.sonnet).not.toBe(result.claudeTier.haiku);
  });

  it("proves the tier checker goes red on corruption and green after restoration", () => {
    expect(result.reverse.redErrors).toContain("SONNET routed ID");
    expect(result.reverse.redErrors).toContain("SONNET description");
    expect(result.reverse.greenErrors).toEqual([]);
  });

  it("runs provider use through real adapter writes for every registered Agent", () => {
    expect(new Set(result.cli.map(item => item.agentId))).toEqual(new Set(result.registeredAgents));
  });
});
