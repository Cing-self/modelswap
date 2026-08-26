import fs from "fs-extra";
import path from "path";
import { OKIT_DIR } from "../config/registry";
import { backupImportantData } from "../config/backup";
import { Provider, ProviderModel, ProviderSite, ProvidersData, ModelMetadata } from "./types";
import { PRESET_PROVIDERS } from "./presets";
import { PRESET_AUTH_MODE_MIGRATIONS, PRESET_BASE_URL_MIGRATIONS, PRESET_ENDPOINT_BASE_URL_MIGRATIONS, PRESET_MODEL_ID_MIGRATIONS, RETIRED_PRESET_PROVIDER_IDS } from "./metadata";
import { atomicWriteJSON } from "../utils/atomicWrite";

const PROVIDERS_PATH = path.join(OKIT_DIR, "providers.json");
const MODELS_CACHE_PATH = path.join(OKIT_DIR, "models-cache.json");
const PROVIDERS_VERSION = 2 as const;
const CACHE_VERSION = 1 as const;
const LEGACY_DEEPSEEK_DEFAULT_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
]);

export type ModelsCacheData = { version: 1; source: "okit"; fetchedAt: string; providers: Record<string, ModelMetadata[]>; [field: string]: unknown };
type ProviderFile = { version: 2; providers: ProviderSite[]; [field: string]: unknown };

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function isSite(value: any): value is ProviderSite { return value && typeof value.id === "string" && typeof value.name === "string" && typeof value.type === "string" && typeof value.baseUrl === "string"; }
function stripModels(provider: Provider | ProviderSite): ProviderSite { const { models: _models, modelCache: _cache, platforms: _platforms, ...site } = provider as any; return clone(site); }
function toMetadata(model: ProviderModel, source: ModelMetadata["source"] = "legacy"): ModelMetadata {
  const meta = model.meta;
  const effectiveSource = meta?.source === "modelsdev" ? "modelsdev" : source;
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
    ...(meta?.family ? { family: meta.family } : {}),
    ...(meta?.context ? { context: meta.context } : {}),
    ...(meta?.input ? { input: meta.input } : {}),
    ...(meta?.output ? { output: meta.output } : {}),
    ...(meta?.modalities ? { modalities: clone(meta.modalities) } : {}),
    ...(meta?.toolCall === undefined ? {} : { tool: meta.toolCall }),
    ...(meta?.reasoning === undefined ? {} : { reasoning: meta.reasoning }),
    ...(meta?.reasoningOptions ? { reasoningOptions: clone(meta.reasoningOptions) } : {}),
    ...(meta?.structuredOutput === undefined ? {} : { structuredOutput: meta.structuredOutput }),
    ...(meta?.temperature === undefined ? {} : { temperature: meta.temperature }),
    ...(meta?.interleaved ? { interleaved: clone(meta.interleaved) } : {}),
    ...(meta?.knowledge ? { knowledge: meta.knowledge } : {}),
    ...(meta?.releaseDate ? { releaseDate: meta.releaseDate } : {}),
    ...(meta?.lastUpdated ? { lastUpdated: meta.lastUpdated } : {}),
    ...(meta?.openWeights === undefined ? {} : { openWeights: meta.openWeights }),
    ...(meta?.status ? { status: meta.status } : {}),
    ...(meta?.cost ? { cost: clone(meta.cost) } : {}),
    ...(meta?.providerConfig ? { providerConfig: clone(meta.providerConfig) } : {}),
    ...(meta?.experimental ? { experimental: clone(meta.experimental) } : {}),
    source: effectiveSource,
    confidence: effectiveSource === "modelsdev" ? "high" : effectiveSource === "remote" || effectiveSource === "manual" ? "medium" : "low",
    raw: clone(model),
  };
}

function toModel(metadata: ModelMetadata): ProviderModel {
  const raw = metadata.raw && typeof metadata.raw === "object" ? clone(metadata.raw as any) : {};
  const hasMeta = Object.keys(metadata).some(key => !["id", "name", "source", "confidence", "fetchedAt", "raw"].includes(key));
  const meta = hasMeta ? {
    source: "modelsdev" as const,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.family ? { family: metadata.family } : {}),
    ...(metadata.context ? { context: metadata.context } : {}),
    ...(metadata.input ? { input: metadata.input } : {}),
    ...(metadata.output ? { output: metadata.output } : {}),
    ...(metadata.modalities ? { modalities: clone(metadata.modalities) } : {}),
    ...(metadata.tool === undefined ? {} : { toolCall: metadata.tool }),
    ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
    ...(metadata.reasoningOptions ? { reasoningOptions: clone(metadata.reasoningOptions) } : {}),
    ...(metadata.structuredOutput === undefined ? {} : { structuredOutput: metadata.structuredOutput }),
    ...(metadata.temperature === undefined ? {} : { temperature: metadata.temperature }),
    ...(metadata.interleaved ? { interleaved: clone(metadata.interleaved) } : {}),
    ...(metadata.knowledge ? { knowledge: metadata.knowledge } : {}),
    ...(metadata.releaseDate ? { releaseDate: metadata.releaseDate } : {}),
    ...(metadata.lastUpdated ? { lastUpdated: metadata.lastUpdated } : {}),
    ...(metadata.openWeights === undefined ? {} : { openWeights: metadata.openWeights }),
    ...(metadata.status ? { status: metadata.status } : {}),
    ...(metadata.cost ? { cost: clone(metadata.cost) } : {}),
    ...(metadata.providerConfig ? { providerConfig: clone(metadata.providerConfig) } : {}),
    ...(metadata.experimental ? { experimental: clone(metadata.experimental) } : {}),
    ...(metadata.modalities?.input ? { attachment: metadata.modalities.input.some(value => /image|video/i.test(value)) } : {}),
  } : undefined;
  return { ...raw, id: metadata.id, ...(metadata.name ? { name: metadata.name } : {}), ...(meta ? { meta } : {}) };
}
function uniqueModels(models: ProviderModel[]): ProviderModel[] { const map = new Map<string, ProviderModel>(); for (const model of models) if (model?.id) map.set(model.id, { ...(map.get(model.id) || {}), ...model }); return [...map.values()]; }
function mergeCachedModels(existing: ModelMetadata[], incoming: ModelMetadata[]): ModelMetadata[] {
  // The receiving machine's independently discovered/manual facts win. A
  // legacy providers.json can only fill model ids that its cache does not yet
  // know about; it must never overwrite current local metadata.
  const merged = new Map<string, ModelMetadata>();
  for (const model of existing) if (model?.id) merged.set(model.id, clone(model));
  for (const model of incoming) if (model?.id && !merged.has(model.id)) merged.set(model.id, clone(model));
  return [...merged.values()];
}
function presetModels(id: string): ProviderModel[] { return clone((PRESET_PROVIDERS as Provider[]).find(provider => provider.id === id)?.models || []); }
function defaultCache(): ModelsCacheData { return { version: CACHE_VERSION, source: "okit", fetchedAt: new Date().toISOString(), providers: {} }; }
function defaultProviderFile(): ProviderFile { return { version: PROVIDERS_VERSION, providers: (PRESET_PROVIDERS as Provider[]).map(stripModels) }; }

// DeepSeek's former four-item preset contained the deprecated compatibility
// aliases deepseek-chat and deepseek-reasoner. Replace only that exact legacy
// default snapshot. User-added models and a live /models result are untouched.
function migrateLegacyDeepSeekDefaultCache(cache: ModelsCacheData): boolean {
  const models = cache.providers.deepseek;
  if (!Array.isArray(models) || models.length !== LEGACY_DEEPSEEK_DEFAULT_MODEL_IDS.size) return false;
  if (!models.every(model => model?.source === "legacy" && LEGACY_DEEPSEEK_DEFAULT_MODEL_IDS.has(model.id))) return false;
  cache.providers.deepseek = presetModels("deepseek").map(model => toMetadata(model));
  return true;
}

// These are the original narrowly-scoped v1 repairs. They run before a legacy
// record is split, and the same preset merge runs for every v2 load.
function applyPresetMigrations(input: Provider[]): Provider[] {
  const providers = input.filter(provider => !RETIRED_PRESET_PROVIDER_IDS.has(provider.id));
  for (const preset of PRESET_PROVIDERS as Provider[]) {
    const current = providers.find(provider => provider.id === preset.id);
    if (!current) { providers.push(clone(preset)); continue; }
    const base = PRESET_BASE_URL_MIGRATIONS.get(preset.id);
    if (base && current.baseUrl === base.from) { current.baseUrl = base.to; if (current.endpoints) current.endpoints = current.endpoints.map(endpoint => endpoint.type === preset.type && endpoint.baseUrl === base.from ? { ...endpoint, baseUrl: base.to } : endpoint); }
    const endpointMigrations = PRESET_ENDPOINT_BASE_URL_MIGRATIONS.get(preset.id) || [];
    if (current.endpoints) current.endpoints = current.endpoints.map(endpoint => { const migration = endpointMigrations.find(candidate => endpoint.baseUrl === candidate.from && (!candidate.type || endpoint.type === candidate.type)); return migration ? { ...endpoint, baseUrl: migration.to } : endpoint; });
    if (preset.endpoints) {
      const types = new Set((current.endpoints || []).map(endpoint => endpoint.type));
      for (const endpoint of preset.endpoints) if (!types.has(endpoint.type)) current.endpoints = [...(current.endpoints || []), clone(endpoint)];
      current.endpoints = (current.endpoints || []).map(endpoint => { const source = preset.endpoints?.find(candidate => candidate.type === endpoint.type && candidate.baseUrl === endpoint.baseUrl && (!endpoint.protocol || !candidate.protocol || endpoint.protocol === candidate.protocol)); return source ? { ...endpoint, ...(!endpoint.protocol && source.protocol ? { protocol: source.protocol } : {}), ...(!endpoint.plan && source.plan ? { plan: source.plan } : {}) } : endpoint; });
    }
    const auth = PRESET_AUTH_MODE_MIGRATIONS.get(preset.id); if (auth && current.authMode === auth.from) current.authMode = auth.to as any;
    if (preset.executionMode) current.executionMode = preset.executionMode;
    if (preset.executionMode === "agent_native") delete current.endpoints;
    if (preset.nativeAgentIds) current.nativeAgentIds = [...preset.nativeAgentIds];
    if (preset.cliOnly) current.cliOnly = true;
    if (preset.authMode === "none" && !current.vaultKey) current.authMode = "none";
    const ids = (current.models || []).map(model => model.id); const snapshots = PRESET_MODEL_ID_MIGRATIONS.get(preset.id) || [];
    if (snapshots.some(snapshot => JSON.stringify(snapshot) === JSON.stringify(ids)) || (preset.id === "qianfan-coding" && ids.some(id => ["kimi-k2.5", "deepseek-v3.2", "minimax-m2.5", "ernie-4.5-turbo-20260402"].includes(id))) || (preset.id === "xiaomi-coding" && ids.length === 4 && ids.every(id => ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.5-asr", "mimo-v2.5-tts"].includes(id)))) current.models = clone(preset.models);
    current.name = preset.name;
  }
  const qianfan = providers.find(provider => provider.id === "qianfan");
  if (qianfan?.endpoints) { qianfan.endpoints = qianfan.endpoints.filter(endpoint => !/^https?:\/\/qianfan\.baidubce\.com\/v2\/(?:coding|tokenplan\/personal)\/?$/i.test(endpoint.baseUrl)); if (qianfan.baseUrl === "https://qianfan.baidubce.com/v2/coding") qianfan.baseUrl = "https://qianfan.baidubce.com/v2"; if (!qianfan.endpoints.length) delete qianfan.endpoints; }
  return providers;
}

async function readCache(): Promise<ModelsCacheData> { if (!(await fs.pathExists(MODELS_CACHE_PATH))) return defaultCache(); try { const data = JSON.parse(await fs.readFile(MODELS_CACHE_PATH, "utf8")); if (data?.version === CACHE_VERSION && data.providers && typeof data.providers === "object") return { ...data, version: CACHE_VERSION, source: "okit", fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : new Date().toISOString() }; } catch (error) { throw new Error(`无法读取 models-cache.json：${error instanceof Error ? error.message : String(error)}`); } return defaultCache(); }
async function writeCache(cache: ModelsCacheData): Promise<void> { await fs.ensureDir(OKIT_DIR); await atomicWriteJSON(MODELS_CACHE_PATH, { ...cache, version: CACHE_VERSION, source: "okit", fetchedAt: new Date().toISOString() }); }
async function writeProviderFile(file: ProviderFile, backup = true): Promise<void> { await fs.ensureDir(OKIT_DIR); if (backup) await backupImportantData("providers"); const { models: _models, modelCache: _cache, platforms: _platforms, ...clean } = file as any; await atomicWriteJSON(PROVIDERS_PATH, clean); }
async function backupLegacy(content: string): Promise<void> { await fs.writeFile(`${PROVIDERS_PATH}.pre-model-cache-${Date.now()}.json`, content, "utf8"); }

async function readProviderFile(): Promise<ProviderFile> {
  if (!(await fs.pathExists(PROVIDERS_PATH))) return defaultProviderFile();
  const content = await fs.readFile(PROVIDERS_PATH, "utf8"); let raw: any;
  try { raw = JSON.parse(content); } catch (error) { throw new Error(`无法读取 providers.json：${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(raw.providers)) throw new Error("无法读取 providers.json：providers.json 中的 providers 必须是数组");
  if (raw.version === PROVIDERS_VERSION && !Object.prototype.hasOwnProperty.call(raw, "models") && !Object.prototype.hasOwnProperty.call(raw, "modelCache") && !Object.prototype.hasOwnProperty.call(raw, "platforms")) {
    const sites = applyPresetMigrations(raw.providers.filter(isSite).map((site: ProviderSite) => ({ ...clone(site), models: [] } as Provider))).map(stripModels);
    return { ...raw, version: PROVIDERS_VERSION, providers: sites };
  }
  const legacy = applyPresetMigrations(raw.providers.filter(isSite).map((provider: any) => clone(provider)));
  const cache = defaultCache();
  for (const provider of legacy) cache.providers[provider.id] = (provider.models || []).filter(model => model?.id).map(model => toMetadata(model));
  const { providers: _providers, models: _models, modelCache: _oldCache, platforms: _platforms, version: _version, ...unknown } = raw;
  const next: ProviderFile = { ...unknown, version: PROVIDERS_VERSION, providers: legacy.map(stripModels) };
  await backupLegacy(content); await writeCache(cache); await writeProviderFile(next, false);
  return next;
}
function materialize(file: ProviderFile, cache: ModelsCacheData): Provider[] { return file.providers.map(site => { const cached = cache.providers[site.id] || []; return { ...clone(site), models: uniqueModels(cached.length ? cached.map(toModel) : presetModels(site.id)) } as Provider; }); }

export async function loadProviders(): Promise<Provider[]> { const file = await readProviderFile(); const cache = await readCache(); if (migrateLegacyDeepSeekDefaultCache(cache)) await writeCache(cache); if (!(await fs.pathExists(PROVIDERS_PATH))) await writeProviderFile(file); return materialize(file, cache); }
/** Site-only read for diagnostics/demos that must not touch model cache. */
export async function loadProviderSites(): Promise<ProviderSite[]> {
  return clone((await readProviderFile()).providers);
}
export async function saveProviders(providers: Provider[]): Promise<void> { const current = await readProviderFile(); const cache = await readCache(); for (const provider of providers) if (isSite(provider) && Array.isArray(provider.models)) cache.providers[provider.id] = provider.models.filter(model => model?.id).map(model => toMetadata(model, model.origin === "user" ? "manual" : "legacy")); const { providers: _old, ...unknown } = current; await writeCache(cache); await writeProviderFile({ ...unknown, version: PROVIDERS_VERSION, providers: providers.filter(isSite).map(stripModels) }); }
export async function mergeProviderSites(sites: ProviderSite[]): Promise<void> {
  // Sync must not perform a preliminary provider-file migration write: an old
  // receiving file is backed up, its embedded models are merged into the
  // receiver's cache, and the final v2 sites document is written once.
  let current: ProviderFile = defaultProviderFile();
  if (await fs.pathExists(PROVIDERS_PATH)) {
    const content = await fs.readFile(PROVIDERS_PATH, "utf8");
    const raw = JSON.parse(content);
    const isV2 = raw?.version === PROVIDERS_VERSION
      && !Object.prototype.hasOwnProperty.call(raw, "models")
      && !Object.prototype.hasOwnProperty.call(raw, "modelCache")
      && !Object.prototype.hasOwnProperty.call(raw, "platforms");
    const { providers, models: _models, modelCache: _cache, platforms: _platforms, version: _version, ...unknown } = raw;
    if (isV2) {
      current = { ...unknown, version: PROVIDERS_VERSION, providers: Array.isArray(providers) ? providers.filter(isSite).map(stripModels) : [] };
    } else {
      const rawSites = Array.isArray(providers) ? providers.filter(isSite) : [];
      const hasEmbeddedModelData = rawSites.some((provider: any) => Array.isArray(provider.models) && provider.models.length > 0)
        || Object.prototype.hasOwnProperty.call(raw, "models")
        || Object.prototype.hasOwnProperty.call(raw, "modelCache");
      const legacy = applyPresetMigrations(Array.isArray(providers)
        ? providers.filter(isSite).map(provider => clone(provider as any) as Provider)
        : []);
      if (hasEmbeddedModelData) {
        const cache = await readCache();
        for (const provider of legacy) {
          const embedded = (provider.models || [])
            .filter(model => model?.id)
            .map(model => toMetadata(model));
          if (embedded.length > 0) {
            cache.providers[provider.id] = mergeCachedModels(cache.providers[provider.id] || [], embedded);
          }
        }
        await backupLegacy(content);
        await writeCache(cache);
      }
      current = { ...unknown, version: PROVIDERS_VERSION, providers: legacy.map(stripModels) };
    }
  }
  const merged = [...current.providers];
  for (const site of sites.filter(isSite)) {
    const index = merged.findIndex(item => item.id === site.id);
    const incoming = clone(site);
    // Vault bindings are local-machine references, never portable secrets.
    // A remote site with an absent/null binding must not erase a working local
    // binding merely because the peer has not configured that key.
    if (incoming.vaultKey == null || incoming.vaultKey === "") delete incoming.vaultKey;
    if (index >= 0) merged[index] = { ...merged[index], ...incoming };
    else merged.push(incoming);
  }
  await writeProviderFile({ ...current, providers: merged });
}
export async function getProvider(id: string): Promise<Provider | undefined> { return (await loadProviders()).find(provider => provider.id === id); }
export async function addProvider(provider: Provider): Promise<void> { const providers = await loadProviders(); const index = providers.findIndex(item => item.id === provider.id); if (index >= 0) providers[index] = provider; else providers.push(provider); await saveProviders(providers); }
export async function deleteProvider(id: string): Promise<boolean> { const file = await readProviderFile(); const index = file.providers.findIndex(provider => provider.id === id); if (index < 0) return false; file.providers.splice(index, 1); const cache = await readCache(); delete cache.providers[id]; await writeCache(cache); await writeProviderFile(file); return true; }
export async function loadModelsCache(): Promise<ModelsCacheData> { return readCache(); }
export async function saveModelsCache(cache: ModelsCacheData): Promise<void> { await writeCache(cache); }
/** Read-only sync projection. It never triggers a legacy migration/write. */
export async function loadProviderSitesForSync(): Promise<ProviderSite[]> {
  if (!(await fs.pathExists(PROVIDERS_PATH))) return [];
  const raw = JSON.parse(await fs.readFile(PROVIDERS_PATH, "utf8"));
  return Array.isArray(raw.providers) ? raw.providers.filter(isSite).map(stripModels) : [];
}
export const providerStorePaths = { providers: PROVIDERS_PATH, modelsCache: MODELS_CACHE_PATH };
export function migrateProvidersData(raw: ProvidersData): ProvidersData { const legacy = applyPresetMigrations((raw.providers || []).filter(isSite).map(provider => clone(provider as Provider))); const { providers: _providers, models: _models, modelCache: _cache, platforms: _platforms, version: _version, ...unknown } = raw as any; return { ...unknown, version: PROVIDERS_VERSION, providers: legacy.map(stripModels) } as ProvidersData; }
