import { api } from './client';

export interface ProviderModel {
  id: string;
  name?: string;
  origin?: 'remote' | 'user';
  capabilities?: string[];
  recent?: boolean;
  availability?: ProviderModelAvailability[];
}

export interface ProviderModelAvailability {
  executionMode: 'http_endpoint' | 'agent_native';
  endpointId?: string;
  nativeAgentIds?: string[];
  remoteModelId: string;
  status: 'available' | 'unavailable' | 'deprecated' | 'unknown';
  source: 'remote' | 'static' | 'cli' | 'manual' | 'legacy_unknown';
  discoveredAt?: string;
  lastSeenAt?: string;
}

export interface ProviderEndpoint {
  id?: string;
  type: 'anthropic' | 'openai';
  baseUrl: string;
  protocol?: 'chat' | 'responses';
  plan?: 'coding' | 'token' | 'agent' | 'go';
}

export interface Provider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai';
  baseUrl: string;
  endpoints?: ProviderEndpoint[];
  vaultKey?: string;
  authVerified?: boolean;
  authVerifiedKey?: string;
  authVerifiedAt?: string;
  authLastCheckedAt?: string;
  authLastCheckedKey?: string;
  authLastError?: string;
  authState?: 'unconfigured' | 'needs_verification' | 'verified' | 'partial' | 'stale' | 'invalid' | 'oauth_required' | 'oauth_verified' | 'mixed';
  authVerifiedEndpointIds?: string[];
  authEndpointStates?: Record<string, { state: 'verified' | 'stale' | 'invalid' | 'unknown'; checkedAt: string; error?: string }>;
  authMode: 'api_key' | 'oauth' | 'both' | 'none';
  executionMode?: 'http_endpoint' | 'agent_native';
  nativeAgentIds?: string[];
  models: ProviderModel[];
  usedBy?: { id: string; name: string; modelId: string }[];
}

export interface PlatformOffering {
  id: string;
  type: string;
  label: string;
  providerId: string;
  endpointIds: string[];
  authMethodIds: string[];
  executionMode: 'http_endpoint' | 'agent_native';
  nativeAgentIds?: string[];
}

export interface PlatformAuthMethod {
  id: string;
  type: string;
  label: string;
  providerId: string;
  credentialRef?: string;
  status?: 'unconfigured' | 'configured' | 'verified' | 'invalid' | 'expired';
  verifiedAt?: string;
  verifiedEndpointId?: string;
}

export interface PlatformEndpoint {
  id: string;
  name: string;
  offeringId: string;
  baseUrl: string;
  protocol: { family: string; mode: string };
  authMethodIds: string[];
  modelDiscovery: { type: string; path?: string; modelIds?: string[]; command?: string };
}

export interface PlatformModel {
  id: string;
  name: string;
  capabilities?: string[];
  availability: {
    offeringId: string;
    endpointIds: string[];
    executionMode: 'http_endpoint' | 'agent_native';
    nativeAgentIds?: string[];
    remoteModelId: string;
    status: string;
    source: string;
    discoveredAt?: string;
  }[];
}

export interface Platform {
  id: string;
  name: string;
  providerIds: string[];
  offerings: PlatformOffering[];
  authMethods: PlatformAuthMethod[];
  endpoints: PlatformEndpoint[];
  models: PlatformModel[];
}

export interface ModelDataRecord {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  context?: number;
  input?: number;
  output?: number;
  modalities?: { input?: string[]; output?: string[] };
  tool?: boolean;
  reasoning?: boolean;
  reasoningOptions?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  structuredOutput?: boolean;
  temperature?: boolean;
  interleaved?: { field?: string };
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  openWeights?: boolean;
  status?: string;
  cost?: Record<string, unknown>;
  providerConfig?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  source: 'preset' | 'modelsdev' | 'remote' | 'legacy' | 'manual' | string;
  confidence: 'high' | 'medium' | 'low';
  fetchedAt?: string;
  raw?: unknown;
  selectedBy: string[];
}

export interface ModelDataProvider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai';
  executionMode: 'http_endpoint' | 'agent_native';
  catalog?: {
    key: string;
    id?: string;
    name?: string;
    api?: string;
    doc?: string;
    env: string[];
    npm?: string;
  } | null;
  endpoints: Array<{ id: string; type: string; protocol?: string; baseUrl: string }>;
  sources: Record<string, number>;
  models: ModelDataRecord[];
}

export interface ModelDataSnapshot {
  cache: {
    version: number;
    source: string;
    generation?: number;
    sourceFetchedAt?: string | null;
    cachedAt?: string | null;
    fetchedAt: string | null;
    sourceHash?: string | null;
    status?: 'fresh' | 'stale' | 'error' | 'empty';
    lastError?: string | null;
    file: string;
  };
  summary: {
    providers: number;
    models: number;
    withContext: number;
    withOutput: number;
    withReasoning: number;
    withTool: number;
    withModalities: number;
  };
  providers: ModelDataProvider[];
}

export interface AgentInfo {
  id: string;
  name: string;
  supportedTypes: string[];
  launchType?: 'cli' | 'app';
  canLaunch?: boolean;
  installed?: boolean;
  /** Additive agent (workbuddy): its config holds many sites at once and
   *  switching happens inside the agent's own UI — the toggle means
   *  enable/disable per site instead of exclusive switch. */
  additive?: boolean;
  current: { providerId: string; providerName: string; modelId: string } | null;
  /** Exact sites/models saved for this Agent. */
  compatibleProviders: { id: string; name: string; type: string; baseUrl?: string; models: ProviderModel[]; allModels?: ProviderModel[]; enabled?: boolean }[];
  /** Full compatible catalog, used only by the add-site model picker. */
  availableProviders?: { id: string; name: string; type: string; baseUrl?: string; models: ProviderModel[]; allModels?: ProviderModel[]; added: boolean }[];
  externalSites?: { id: string; name: string; known: boolean }[];
}

// The providers payload is ~0.5 MB of JSON; parsing it on every page visit is
// the dominant cost (the backend responds in ~20 ms). Cache it in memory for a
// short window and invalidate on any mutation.
let providersCache: { data: { providers: Provider[]; platforms: Platform[] }; at: number } | null = null;
const PROVIDERS_CACHE_TTL_MS = 30_000;

export function invalidateProvidersCache() {
  providersCache = null;
}

export async function listProviders(options?: { force?: boolean }): Promise<{ providers: Provider[]; platforms: Platform[] }> {
  if (!options?.force && providersCache && Date.now() - providersCache.at < PROVIDERS_CACHE_TTL_MS) {
    return providersCache.data;
  }
  const data = await api('/api/providers') as { providers: Provider[]; platforms: Platform[] };
  providersCache = { data, at: Date.now() };
  return data;
}

export async function getModelData(): Promise<ModelDataSnapshot> {
  return api('/api/demo/model-data');
}

export async function refreshModelData(): Promise<ModelDataSnapshot> {
  return api('/api/demo/model-data/refresh', { method: 'POST' });
}

export async function refreshDemoProviderModels(providerId: string): Promise<{ success: boolean; provider: ModelDataProvider; errors?: Array<{ endpoint: string; error: string }> }> {
  return api(`/api/demo/model-data/providers/${encodeURIComponent(providerId)}/refresh`, { method: 'POST' });
}

export async function getAdapters(): Promise<{ adapters: AgentInfo[] }> {
  return api('/api/providers/adapters');
}

export async function createProvider(data: Partial<Provider> & { id: string; name: string; type: string; baseUrl: string }): Promise<{ success: boolean; provider: Provider }> {
  invalidateProvidersCache();
  return api('/api/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProvider(id: string, data: Partial<Provider>): Promise<{ success: boolean; provider: Provider }> {
  invalidateProvidersCache();
  return api(`/api/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteProvider(id: string): Promise<{ success: boolean }> {
  invalidateProvidersCache();
  return api(`/api/providers/${id}`, { method: 'DELETE' });
}

export async function switchProvider(agentId: string, providerId: string, modelId: string): Promise<{ success: boolean; snapshotAvailable?: boolean }> {
  return api('/api/providers/switch', {
    method: 'POST',
    body: JSON.stringify({ agentId, providerId, modelId }),
  });
}

// --- Agent site + selected models ---

export async function saveAgentProviderSite(
  agentId: string,
  providerId: string,
  modelIds: string[],
  primaryModelId?: string,
): Promise<{ success: boolean; modelIds: string[]; primaryModelId?: string; snapshotAvailable?: boolean }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/sites/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify({ modelIds, primaryModelId }),
  });
}

export async function removeAgentProviderSite(agentId: string, providerId: string): Promise<{ success: boolean }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/sites/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export async function setAgentProviderSiteEnabled(agentId: string, providerId: string, enabled: boolean): Promise<{ success: boolean }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/sites/${encodeURIComponent(providerId)}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export interface AgentConfigFile {
  path: string;
  exists: boolean;
  content: string | null;
  /** Number of sensitive values masked in `content` (0 when revealed). */
  maskedCount?: number;
}

export async function getAgentConfigFiles(
  agentId: string,
  opts?: { reveal?: boolean },
): Promise<{ agentId: string; files: AgentConfigFile[]; revealed: boolean }> {
  const suffix = opts?.reveal ? '?reveal=1' : '';
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/config-files${suffix}`);
}

export async function saveAgentConfigFile(agentId: string, filePath: string, content: string): Promise<{ success: boolean; path: string }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/config-files`, {
    method: 'PUT',
    body: JSON.stringify({ filePath, content }),
  });
}

// --- Claude Code tier mapping ---

export interface TierMap { haiku?: string; sonnet?: string; opus?: string }

export async function getTierMaps(): Promise<{ tierMaps: Record<string, TierMap> }> {
  return api('/api/providers/tier-maps');
}

export async function setTierMap(providerId: string, map: TierMap): Promise<{ success: boolean; providerId: string; tierMap: TierMap }> {
  return api(`/api/providers/tier-maps/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify(map),
  });
}

export async function launchAgent(agentId: string): Promise<{ success: boolean; command: string }> {
  return api('/api/providers/launch', {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  });
}

export async function getAuthStatus(): Promise<{ statuses: { id: string; name: string; hasApiKey: boolean; authVerified: boolean; oauthLoggedIn: boolean | null; authMode: string; authState?: string; authVerifiedAt?: string; authLastCheckedAt?: string; authLastError?: string; authEndpointStates?: Provider['authEndpointStates'] }[] }> {
  return api('/api/providers/auth');
}

export async function verifyProviderAuth(providerId: string): Promise<{
  success: boolean;
  status: { id: string; hasApiKey: boolean; authVerified: boolean; oauthLoggedIn: boolean | null; authMode: string; authState?: string; authLastCheckedAt?: string; authLastError?: string; authEndpointStates?: Provider['authEndpointStates'] };
  results: { endpointId: string; success: boolean; message: string }[];
}> {
  invalidateProvidersCache();
  return api(`/api/providers/${encodeURIComponent(providerId)}/verify-auth`, { method: 'POST' });
}

export async function triggerOAuthLogin(providerId: string): Promise<{ success: boolean; message: string }> {
  return api('/api/providers/auth/login', {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  });
}

export async function fetchModels(providerId?: string, config?: { endpoints?: ProviderEndpoint[]; vaultKey?: string; persistConfig?: boolean }): Promise<{ success: boolean; models: ProviderModel[]; modelsDiscovered?: boolean; errors?: { endpoint: string; error: string }[]; kept?: ProviderModel[] }> {
  invalidateProvidersCache();
  return api('/api/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ providerId, ...config }),
  });
}

export interface UsageWindow {
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  usedCredits?: number;
  limitCredits?: number | null;
  remainingCredits?: number | null;
  /** Display unit for non-USD credit quotas, e.g. "M Credits". */
  unit?: string;
  isPrepaid?: boolean;
}

export interface UsageResult {
  providerId?: string;
  supported: boolean;
  windows?: UsageWindow[];
  error?: string;
  notice?: string;
  action?: { label: string; url: string; mode?: 'external' | 'extension' };
  source?: 'live' | 'browser' | 'cli' | 'console';
  /** Goal ①: 'subscription' (percentage + reset) or 'prepaid' (USD balance). */
  kind?: 'subscription' | 'prepaid';
  raw?: any;
}

export async function getSupportedUsageProviders(): Promise<{ providers: string[]; manualOnly?: string[] }> {
  return api('/api/usage/supported');
}

export async function getUsage(providerId: string): Promise<UsageResult> {
  return api(`/api/usage/${encodeURIComponent(providerId)}`);
}

export async function openUsageLogin(providerId: string): Promise<{ success: boolean; error?: string }> {
  return api(`/api/usage/${encodeURIComponent(providerId)}/login`, { method: 'POST' });
}

// Close the automation console window opened by openUsageLogin — called by the
// page once its session polling sees usable data.
export async function closeUsageLoginWindow(providerId: string): Promise<{ success: boolean; error?: string }> {
  return api(`/api/usage/${encodeURIComponent(providerId)}/close-window`, { method: 'POST' });
}

// ─── Deep Link: Provider export / import ───

export async function exportProviderCode(id: string, password?: string): Promise<{ success: boolean; code: string }> {
  return api('/api/providers/export-code', {
    method: 'POST',
    body: JSON.stringify({ id, password }),
  });
}

export async function importProviderCode(code: string, password?: string): Promise<{ success: boolean; provider: Provider; created: boolean }> {
  invalidateProvidersCache();
  return api('/api/providers/import-code', {
    method: 'POST',
    body: JSON.stringify({ code, password }),
  });
}
