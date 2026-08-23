import fs from "fs-extra";
import path from "path";
import os from "os";
import { OKIT_DIR } from "./registry";
import { backupImportantData } from "./backup";
import { atomicWrite, atomicWriteJSON } from "../utils/atomicWrite";

type Language = "zh" | "en";

// A model that was used in a successful switchProvider call. Auto-maintained:
// each switch prepends the model (deduped by providerId+modelId), capped at 10.
export interface RecentModel {
  providerId: string;
  modelId: string;
  agentId: string;      // which external CLI agent was switched
  lastUsedAt: string;   // ISO timestamp
}

export type UserConfig = {
  language?: Language;
  claude?: {
    name?: string;
    model?: string;
    agentTeams?: boolean;
    teammateMode?: "auto" | "in-process" | "tmux";
  };
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
  providers?: Record<string, {
    providerId?: string;
    modelId?: string;
    // Additive agents (workbuddy): model ids OKIT wrote into the agent's own
    // config file, keyed by OKIT providerId — used to never touch entries
    // OKIT didn't create. See ManagedModels in providers/types.ts.
    managedModels?: Record<string, string[]>;
  }>;
  sync?: {
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
  // Auto-recorded on each successful switchProvider.
  recentModels?: RecentModel[];
  // Provider ids the user has explicitly added to each agent's home-page list.
  // Empty/absent = show nothing (the user adds their own). This is the "常用
  // 站点" concept: the home page only renders what the user curated, not every
  // configured provider.
  homeProviders?: Record<string, string[]>;
  // Codex model-catalog exclusion: per-provider lists of model ids the user
  // UNCHECKED in the UI. When writing ~/.codex/model-catalogs/..., the codex
  // adapter omits these so /model only lists models the user wants. Absent
  // entry = all models included (default "all checked").
  // Models the user ADDED to a provider's card (inclusion model; absent =
  // empty card). Replaced the legacy exclusion/extra pair.
  codexCatalogVisible?: Record<string, string[]>;
  codexCatalogVisibleMigrated?: boolean;
  // Claude Code tier mapping: per-provider overrides for the three Anthropic
  // model tiers. Keys are providerIds; values are { haiku, sonnet, opus }
  // model-id strings. When a claude provider is switched, the adapter reads
  // this to write ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL differentially.
  // Absent tier = fall back to ANTHROPIC_MODEL (the selected model).
  claudeTierMaps?: Record<string, { haiku?: string; sonnet?: string; opus?: string }>;
};

const USER_CONFIG_PATH = path.join(OKIT_DIR, "user.json");
const LEGACY_LANG_PATH = path.join(OKIT_DIR, "language.json");
const LEGACY_CLAUDE_PATH = path.join(OKIT_DIR, "claude-current.json");

export async function loadUserConfig(): Promise<UserConfig> {
  const config = await readJson(USER_CONFIG_PATH);
  if (config) {
    // Remove the retired model-favorites field from older user configs once.
    if (Object.prototype.hasOwnProperty.call(config, "favoriteModels")) {
      const { favoriteModels: _removed, ...cleanConfig } = config;
      await saveUserConfig(cleanConfig);
      return cleanConfig;
    }
    return config;
  }

  const migrated = await migrateLegacyConfig();
  if (migrated) {
    await saveUserConfig(migrated);
    return migrated;
  }
  return {};
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  await fs.ensureDir(OKIT_DIR);
  await backupImportantData("user");
  await atomicWriteJSON(USER_CONFIG_PATH, config);
}

export async function updateUserConfig(patch: Partial<UserConfig>): Promise<UserConfig> {
  const current = await loadUserConfig();
  const merged = {
    ...current,
    ...patch,
    claude: patch.claude ? { ...current.claude, ...patch.claude } : current.claude,
    hints: patch.hints ? { ...current.hints, ...patch.hints } : current.hints,
    git: patch.git ? { ...current.git, ...patch.git } : current.git,
    providers: patch.providers ? { ...current.providers, ...patch.providers } : current.providers,
    repo: patch.repo ? { ...current.repo, ...patch.repo } : current.repo,
    // Arrays are replaced wholesale — callers read-modify-write the full list
    // (e.g. switchProvider prepends to recentModels after deduping).
    recentModels: patch.recentModels ?? current.recentModels,
    // Per-agent home-page provider lists: merge per agent key.
    homeProviders: patch.homeProviders ? { ...current.homeProviders, ...patch.homeProviders } : current.homeProviders,
    codexCatalogVisible: patch.codexCatalogVisible ? { ...current.codexCatalogVisible, ...patch.codexCatalogVisible } : current.codexCatalogVisible,
    codexCatalogVisibleMigrated: patch.codexCatalogVisibleMigrated ?? current.codexCatalogVisibleMigrated,
    claudeTierMaps: patch.claudeTierMaps ? { ...current.claudeTierMaps, ...patch.claudeTierMaps } : current.claudeTierMaps,
    sync: patch.sync ? {
      ...current.sync,
      ...patch.sync,
      platforms: patch.sync.platforms ? {
        ...current.sync?.platforms,
        ...patch.sync.platforms,
      } : current.sync?.platforms,
    } : current.sync,
  };
  await saveUserConfig(merged);
  return merged;
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
    config.claude = {
      name: legacyClaude.name,
      model: legacyClaude.model,
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
