import { api } from './client';

export interface ProviderModel {
  id: string;
  name?: string;
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
  /** Providers shown on the home page (user-curated subset). */
  compatibleProviders: { id: string; name: string; type: string; baseUrl?: string; models: ProviderModel[]; allModels?: ProviderModel[]; enabled?: boolean }[];
  /** All configured-and-compatible providers, for the "+ add" picker. */
  availableProviders?: { id: string; name: string; type: string; added: boolean }[];
  // Reconciliation: entries in the agent's own config that are not on the
  // home list. known=true → under an OKIT provider id (adopt or remove);
  // known=false → created outside OKIT (read-only, never touched).
  externalSites?: { id: string; name: string; known: boolean }[];
}

// The providers payload is ~0.5 MB of JSON; parsing it on every page visit is
// the dominant cost (the backend responds in ~20 ms). Cache it in memory for a
// short window and invalidate on any mutation.
let providersCache: { data: { providers: Provider[]; platforms: Platform[] }; at: number } | null = null;
const PROVIDERS_CACHE_TTL_MS = 30_000;

function invalidateProvidersCache() {
  providersCache = null;
}

export async function listProviders(): Promise<{ providers: Provider[]; platforms: Platform[] }> {
  if (providersCache && Date.now() - providersCache.at < PROVIDERS_CACHE_TTL_MS) {
    return providersCache.data;
  }
  const data = await api('/api/providers') as { providers: Provider[]; platforms: Platform[] };
  providersCache = { data, at: Date.now() };
  return data;
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

export async function switchProvider(agentId: string, providerId: string, modelId: string): Promise<{ success: boolean }> {
  return api('/api/providers/switch', {
    method: 'POST',
    body: JSON.stringify({ agentId, providerId, modelId }),
  });
}

// --- Home-page provider list (curated per agent) ---

export async function addHomeProvider(agentId: string, providerId: string): Promise<{ success: boolean; homeProviders: string[] }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/home`, {
    method: 'POST',
    body: JSON.stringify({ providerId }),
  });
}

export async function removeHomeProvider(agentId: string, providerId: string): Promise<{ success: boolean; homeProviders: string[] }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/home/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

// Additive agents only (workbuddy): remove this site's entries from the
// agent's own config. The provider stays in the home list.
export async function disableAgentProvider(agentId: string, providerId: string): Promise<{ success: boolean }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/disable`, {
    method: 'POST',
    body: JSON.stringify({ providerId }),
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

// --- Codex model-catalog exclusion ---

export async function getCatalogVisible(): Promise<{ visible: Record<string, string[]> }> {
  return api('/api/providers/catalog/visible');
}

// Set the model ids shown on a provider's card (inclusion model: the list of
// models the user ADDED; absent/empty = empty card).
export async function setCatalogVisible(providerId: string, visible: string[]): Promise<{ success: boolean; providerId: string; visible: string[] }> {
  return api(`/api/providers/catalog/visible/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify({ visible }),
  });
}

export async function setCatalogExcluded(providerId: string, excluded: string[]): Promise<{ success: boolean; providerId: string; excluded: string[] }> {
  return api(`/api/providers/catalog/excluded/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    body: JSON.stringify({ excluded }),
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

export async function fetchModels(providerId?: string, config?: { endpoints?: ProviderEndpoint[]; vaultKey?: string }): Promise<{ success: boolean; models: ProviderModel[]; errors?: { endpoint: string; error: string }[]; kept?: ProviderModel[] }> {
  invalidateProvidersCache();
  return api('/api/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ providerId, ...config }),
  });
}

// Append specific models of an already-added site into an additive agent's
// own config (used by the home "add models" picker). No-op for non-additive
// agents — they write the single model on switch instead.
export async function applyAgentModels(agentId: string, providerId: string, modelIds: string[]): Promise<{ success: boolean; skipped?: string[] }> {
  return api(`/api/providers/agents/${encodeURIComponent(agentId)}/models`, {
    method: 'POST',
    body: JSON.stringify({ providerId, modelIds }),
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
