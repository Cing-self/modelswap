// API protocol compatibility
export type ProviderType = 'anthropic' | 'openai';
export type OpenAIProtocol = 'chat' | 'responses';
export type ProviderEndpointPlan = 'coding' | 'token' | 'agent' | 'go';
export type OfferingType = 'api' | 'coding_plan' | 'token_plan' | 'agent_plan' | 'agent_subscription' | 'go_plan' | string;
export type AuthMethodType = 'api_key' | 'oauth' | 'cli_login' | 'cloud_credential' | string;
export type EntitlementType = 'pay_as_you_go' | 'subscription_included' | 'prepaid_quota' | 'free_tier' | 'unknown' | string;
export type ExecutionMode = 'http_endpoint' | 'agent_native';
export type AvailabilitySource = 'remote' | 'static' | 'cli' | 'manual' | 'legacy_unknown';

export interface PlatformAuthMethod {
  id: string;
  type: AuthMethodType;
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
  protocol: {
    family: ProviderType | 'custom';
    mode: OpenAIProtocol | 'messages' | 'generate-content' | string;
  };
  authMethodIds: string[];
  modelDiscovery: {
    type: 'remote' | 'static' | 'cli' | 'unsupported';
    path?: string;
    modelIds?: string[];
    command?: string;
  };
}

export interface PlatformOffering {
  id: string;
  type: OfferingType;
  label: string;
  providerId: string;
  endpointIds: string[];
  authMethodIds: string[];
  executionMode: ExecutionMode;
  nativeAgentIds?: string[];
  entitlement?: {
    type: EntitlementType;
    product?: string;
  };
}

export interface PlatformModelAvailability {
  offeringId: string;
  endpointIds: string[];
  executionMode: ExecutionMode;
  nativeAgentIds?: string[];
  remoteModelId: string;
  status: 'available' | 'unavailable' | 'deprecated' | 'unknown';
  source: AvailabilitySource;
  discoveredAt?: string;
  lastSeenAt?: string;
}

export interface PlatformModel {
  id: string;
  name: string;
  capabilities?: string[];
  availability: PlatformModelAvailability[];
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

// A provider (platform) that offers AI models
export interface ProviderEndpoint {
  id?: string;
  type: ProviderType;
  baseUrl: string;
  protocol?: OpenAIProtocol;
  /** Optional product plan for this endpoint; omitted means a standard API. */
  plan?: ProviderEndpointPlan;
}

export interface Provider {
  id: string;              // unique slug (e.g. "volcengine")
  name: string;            // display name (e.g. "火山引擎")
  type: ProviderType;      // primary API protocol
  baseUrl: string;         // primary API endpoint
  endpoints?: ProviderEndpoint[]; // multi-protocol endpoints
  vaultKey?: string;       // reference to Vault key for API key
  /** Whether the current endpoint/key combination passed an explicit test. */
  authVerified?: boolean;
  authVerifiedKey?: string;
  authVerifiedAt?: string;
  authLastCheckedAt?: string;
  authLastCheckedKey?: string;
  authLastError?: string;
  authState?: 'unconfigured' | 'needs_verification' | 'verified' | 'partial' | 'stale' | 'invalid' | 'oauth_required' | 'oauth_verified' | 'mixed';
  authVerifiedEndpointIds?: string[];
  authEndpointStates?: Record<string, {
    state: 'verified' | 'stale' | 'invalid' | 'unknown';
    checkedAt: string;
    error?: string;
  }>;
  authMode: 'api_key' | 'oauth' | 'both' | 'none';
  executionMode?: ExecutionMode;
  nativeAgentIds?: string[];
  /** CLI subscription login only; never expose this provider to API adapters. */
  cliOnly?: boolean;
  models: ProviderModel[];
}

export interface ProviderModel {
  id: string;              // model identifier (e.g. "glm-4.7")
  name?: string;           // display name (e.g. "GLM-4.7")
  capabilities?: string[]; // ["chat", "code", "vision"]
  // Provenance for refresh semantics: 'remote' models come from the
  // provider's /models API and are fully replaced on every refresh (delisted
  // ids drop out); 'user' models were added manually and are never removed
  // automatically. Legacy entries without origin are treated as remote.
  origin?: 'remote' | 'user';
  // Catalog-enriched metadata from models.dev (filled when models are
  // fetched; see web/api/models-dev.js). Heuristic fields stay separate so
  // consumers can prefer catalog data when present.
  meta?: {
    source: 'modelsdev';
    context?: number;      // context window (tokens)
    output?: number;       // max output tokens
    toolCall?: boolean;    // model supports tool/function calling
    reasoning?: boolean;   // model supports reasoning/thinking
    attachment?: boolean;  // accepts image/video inputs
    deprecated?: boolean;
  };
  availability?: ProviderModelAvailability[];
}

export interface ProviderModelAvailability {
  executionMode: ExecutionMode;
  endpointId?: string;
  nativeAgentIds?: string[];
  remoteModelId: string;
  status: 'available' | 'unavailable' | 'deprecated' | 'unknown';
  source: AvailabilitySource;
  discoveredAt?: string;
  lastSeenAt?: string;
}

// Runtime auth status (computed, not persisted)
export interface AuthStatus {
  mode: 'api_key' | 'oauth' | 'both' | 'none';
  hasApiKey: boolean;
  oauthLoggedIn?: boolean;
}

// Per-agent current selection, stored in user.json
export interface AgentSelection {
  providerId: string;
  modelId: string;
}

// Additive agents (workbuddy): model ids OKIT has written into the agent's own
// config, keyed by OKIT providerId. Entries outside this map were written by
// the agent itself (official presets / user-added in-app) and must never be
// modified or removed by OKIT.
export type ManagedModels = Record<string, string[]>;

// Adapter interface each agent implements
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: ProviderType[];
  detectOAuthStatus(): Promise<AuthStatus>;
  getCurrentConfig(): Promise<AgentSelection | null>;
  applyConfig(provider: Provider, modelId: string): Promise<void>;
  resolveApiKey(provider: Provider): Promise<string | undefined>;
  // Additive agents only (workbuddy): batch-write routed models into the
  // agent config without changing the "current" selection. Models whose id
  // collides with an entry OKIT did not write are skipped, not written.
  applyModels?(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }>;
  // Additive agents only: remove every entry OKIT wrote for this provider
  // (entries still claimed by another provider are kept) and clear the
  // current selection if it pointed at the removed provider.
  removeProvider?(providerId: string): Promise<void>;
  // Additive agents only (agents whose config supports an enabled flag, e.g.
  // ZCode): flip the provider's enabled state WITHOUT removing its entries.
  // Used by the home-page site toggle OFF; toggling back ON rewrites entries
  // via applyConfig. Absent = disable falls back to removeProvider.
  setProviderEnabled?(providerId: string, enabled: boolean): Promise<void>;
  // Additive agents only: the provider ids currently present (and, when the
  // config carries an enabled flag, enabled) in the agent's config. Used by
  // the home page so each site's toggle reflects its real state — additive
  // agents keep MANY sites enabled at once. Absent = fall back to the current
  // selection for toggle state.
  listEnabledProviders?(): Promise<string[]>;
  // Additive agents only: the provider/model the agent is ACTUALLY using right
  // now, read from the agent's own state (ZCode records it per task in its
  // local sqlite). More accurate than OKIT's last-written selection. Absent =
  // fall back to the user.json selection for the "current" badge.
  getActiveModel?(): Promise<{ providerId: string; modelId: string } | null>;
}

// Stored file format for providers.json
export interface ProvidersData {
  providers: Provider[];
  platforms?: Platform[];
}
