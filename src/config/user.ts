import fs from "fs-extra";
import path from "path";
import os from "os";
import { OKIT_DIR } from "./registry";
import { backupImportantData } from "./backup";
import { atomicWriteJSON } from "../utils/atomicWrite";

type Language = "zh" | "en";

export type ClaudeTierMap = {
  haiku?: string;
  sonnet?: string;
  opus?: string;
};

// The one user-facing configuration source for an agent. Multi-site agents
// keep one entry per configured provider; exclusive agents use `active*` and
// may have one site entry carrying Claude Code's tier mapping.
export type AgentProviderSite = {
  modelIds: string[];
  enabled?: boolean;
  tierMap?: ClaudeTierMap;
};

export type AgentProviderState = {
  sites: Record<string, AgentProviderSite>;
  activeProviderId?: string;
  activeModelId?: string;
};

export type AgentProviders = Record<string, AgentProviderState>;

export type UserConfig = {
  language?: Language;
  git?: {
    name?: string;
    email?: string;
  };
  repo?: {
    github?: {
      username?: string;
      token?: string;
    };
    gitee?: {
      username?: string;
      token?: string;
    };
  };
  // Single source of truth for configured sites/models per Agent. The home
  // page renders this directly; adapters write the corresponding native files.
  agentProviders?: AgentProviders;
  /** Only fields deliberately edited in the advanced-model drawer. */
  modelOverrides?: Record<string, Record<string, Record<string, unknown>>>;
  sync?: {
    // Cross-machine sync password: derives the cloud blob encryption key AND
    // the sync identity. Required on every machine that shares a sync set.
    password?: string;
    autoSync?: boolean;
    platforms?: {
      cloudflare?: {
        enabled?: boolean;
        storeId?: string;
      };
      cloudflareD1?: {
        enabled?: boolean;
        databaseId?: string;
        tableName?: string;
      };
      cloudflareR2?: {
        enabled?: boolean;
        bucketName?: string;
      };
      volcengine?: {
        enabled?: boolean;
        region?: string;
        accessKey?: string;
        secretKey?: string;
      };
      supabase?: {
        enabled?: boolean;
        projectId?: string;
        apiKey?: string;
      };
      'cloudflare-kv'?: {
        enabled?: boolean;
        apiToken?: string;
      };
      webdav?: {
        enabled?: boolean;
        url?: string;
        username?: string;
        password?: string;
      };
      lan?: {
        enabled?: boolean;
        baseUrl?: string;
        token?: string;
      };
      icloud?: {
        enabled?: boolean;
      };
    };
    // LAN peer sync hub: a token-authenticated blob-store listener on its own
    // port (default 3790). Other machines pair via okit-lan:// connection codes.
    lan?: {
      enabled?: boolean;
      port?: number;
      token?: string;
    };
  };
  hints?: {
    mainHelpShown?: boolean;
  };
};

const USER_CONFIG_PATH = path.join(OKIT_DIR, "user.json");
const LEGACY_LANG_PATH = path.join(OKIT_DIR, "language.json");
const LEGACY_CLAUDE_PATH = path.join(OKIT_DIR, "claude-current.json");

export async function loadUserConfig(): Promise<UserConfig> {
  const config = await readJson(USER_CONFIG_PATH);
  if (config) {
    if (migrateAgentProviders(config)) return require("../web/api/cloud-sync-core").applyLegacyMigration();
    return config;
  }

  const migrated = await migrateLegacyConfig();
  if (migrated) {
    if (migrated.language) await require("../web/api/cloud-sync-core").setPreference("language", migrated.language);
    const claude = migrated.agentProviders?.claude;
    if (claude?.activeProviderId && claude.activeModelId) {
      try {
        await require("../web/api/cloud-sync-core").initializeLegacyClaude(claude.activeProviderId, claude.activeModelId);
      } catch {
        // A legacy provider name that fails today's identifier rules must not
        // wedge every future loadUserConfig; skip the binding and continue.
      }
    }
    return require("../web/api/cloud-sync-core").loadConfig();
  }
  return {};
}

export async function setUserPreference(field: "language" | "mainHelpShown", value: string | boolean): Promise<UserConfig> {
  return require("../web/api/cloud-sync-core").setPreference(field, value);
}

export async function replaceAgentProviderState(agentId: string, state: AgentProviderState): Promise<UserConfig> {
  return require("../web/api/cloud-sync-core").replaceAgentState(agentId, state);
}

function mergeModelOverrides(
  current: UserConfig["modelOverrides"],
  patch: NonNullable<UserConfig["modelOverrides"]>,
): NonNullable<UserConfig["modelOverrides"]> {
  const merged: NonNullable<UserConfig["modelOverrides"]> = { ...(current || {}) };
  for (const [providerId, models] of Object.entries(patch)) {
    merged[providerId] = { ...(merged[providerId] || {}) };
    for (const [modelId, fields] of Object.entries(models || {})) {
      merged[providerId][modelId] = { ...(merged[providerId][modelId] || {}), ...(fields || {}) };
    }
  }
  return merged;
}

export function mergeAgentProviders(
  current: AgentProviders | undefined,
  patch: AgentProviders,
): AgentProviders {
  const merged: AgentProviders = { ...(current || {}) };
  for (const [agentId, state] of Object.entries(patch || {})) {
    const previous = merged[agentId] || { sites: {} };
    const sites = { ...previous.sites };
    for (const [providerId, site] of Object.entries(state.sites || {})) {
      if (site === null) delete sites[providerId];
      else sites[providerId] = { ...sites[providerId], ...site };
    }
    merged[agentId] = {
      ...previous,
      ...state,
      sites,
    };
  }
  return merged;
}

/**
 * One-time, lossless migration from the old UI state fields and legacy Agent
 * selections. It mutates the config so both adapters and API callers use the
 * same shape as soon as user.json is next read.
 */
export function migrateAgentProviders(config: UserConfig & Record<string, any>): boolean {
  const legacyProviders = config.providers && typeof config.providers === "object" ? config.providers : {};
  const legacyHome = config.homeProviders && typeof config.homeProviders === "object" ? config.homeProviders : {};
  const legacyVisible = config.codexCatalogVisible && typeof config.codexCatalogVisible === "object" ? config.codexCatalogVisible : {};
  const legacyTierMaps = config.claudeTierMaps && typeof config.claudeTierMaps === "object" ? config.claudeTierMaps : {};
  const retired = ["providers", "homeProviders", "codexCatalogVisible", "codexCatalogVisibleMigrated", "claudeTierMaps", "claude", "agent", "favoriteModels", "recentModels"];
  const hasRetiredFields = retired.some(key => Object.prototype.hasOwnProperty.call(config, key));
  const hasEmptySites = Object.values(config.agentProviders || {}).some(state =>
    Object.values(state?.sites || {}).some(site => !Array.isArray(site?.modelIds) || site.modelIds.length === 0),
  );
  if (!hasRetiredFields && !hasEmptySites) return false;

  const next: AgentProviders = { ...(config.agentProviders || {}) };
  const ensureAgent = (agentId: string): AgentProviderState => {
    const current = next[agentId];
    if (current) {
      current.sites = current.sites || {};
      return current;
    }
    const created: AgentProviderState = { sites: {} };
    next[agentId] = created;
    return created;
  };
  const mergeSite = (agentId: string, providerId: string, modelIds: unknown, extras?: Partial<AgentProviderSite>) => {
    if (!providerId) return;
    const state = ensureAgent(agentId);
    const previous = state.sites[providerId] || { modelIds: [] };
    const incoming = Array.isArray(modelIds) ? modelIds.filter((id): id is string => typeof id === "string") : [];
    state.sites[providerId] = {
      ...previous,
      ...extras,
      modelIds: [...new Set([...previous.modelIds, ...incoming])],
    };
  };

  for (const [agentId, raw] of Object.entries(legacyProviders)) {
    if (!raw || typeof raw !== "object") continue;
    const legacy = raw as { providerId?: string; modelId?: string; managedModels?: Record<string, string[]> };
    const state = ensureAgent(agentId);
    if (legacy.providerId) state.activeProviderId = state.activeProviderId || legacy.providerId;
    if (legacy.modelId) state.activeModelId = state.activeModelId || legacy.modelId;
    if (legacy.providerId) mergeSite(agentId, legacy.providerId, legacy.modelId ? [legacy.modelId] : []);
    for (const [providerId, modelIds] of Object.entries(legacy.managedModels || {})) {
      mergeSite(agentId, providerId, modelIds, { enabled: true });
    }
  }

  for (const [agentId, providerIds] of Object.entries(legacyHome)) {
    if (!Array.isArray(providerIds)) continue;
    for (const providerId of providerIds) {
      if (typeof providerId !== "string") continue;
      const modelIds = legacyVisible[providerId] || [];
      if (modelIds.length > 0) mergeSite(agentId, providerId, modelIds, { enabled: true });
    }
  }

  const legacyClaude = config.claude && typeof config.claude === "object" ? config.claude : null;
  if (legacyClaude?.name && legacyClaude?.model) {
    const state = ensureAgent("claude");
    state.activeProviderId = state.activeProviderId || String(legacyClaude.name).toLowerCase();
    state.activeModelId = state.activeModelId || legacyClaude.model;
    mergeSite("claude", state.activeProviderId, [state.activeModelId]);
  }
  for (const [providerId, rawMap] of Object.entries(legacyTierMaps)) {
    if (!rawMap || typeof rawMap !== "object") continue;
    const tierMap = rawMap as ClaudeTierMap;
    const tierModels = [tierMap.haiku, tierMap.sonnet, tierMap.opus].filter((id): id is string => typeof id === "string");
    mergeSite("claude", providerId, tierModels, { tierMap });
  }

  // A new site cannot be saved without at least one selected model. Empty
  // legacy home cards were display-only state, so do not carry them into the
  // new source of truth as ghost sites.
  for (const [agentId, state] of Object.entries(next)) {
    for (const [providerId, site] of Object.entries(state.sites)) {
      if (!Array.isArray(site.modelIds) || site.modelIds.length === 0) delete state.sites[providerId];
    }
    if (Object.keys(state.sites).length === 0 && !state.activeProviderId) delete next[agentId];
  }

  config.agentProviders = next;
  for (const key of retired) delete config[key];
  return true;
}

async function migrateLegacyConfig(): Promise<UserConfig | null> {
  let changed = false;
  const config: UserConfig = {};

  const legacyLang = await readJson(LEGACY_LANG_PATH);
  if (legacyLang && (legacyLang.lang === "zh" || legacyLang.lang === "en")) {
    config.language = legacyLang.lang;
    changed = true;
  }

  const legacyClaude = await readJson(LEGACY_CLAUDE_PATH);
  if (legacyClaude && typeof legacyClaude.name === "string") {
    const providerId = legacyClaude.name.toLowerCase();
    config.agentProviders = {
      claude: {
        activeProviderId: providerId,
        activeModelId: legacyClaude.model,
        sites: {
          [providerId]: { modelIds: legacyClaude.model ? [legacyClaude.model] : [] },
        },
      },
    };
    changed = true;
  }

  return changed ? config : null;
}

async function readJson(filePath: string): Promise<any | null> {
  try {
    if (!(await fs.pathExists(filePath))) return null;
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
