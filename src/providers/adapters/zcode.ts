import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, ManagedModels, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWriteJSON } from "../../utils/atomicWrite";

// ZCode (zcode.z.ai, the GLM desktop coding agent) reads ~/.zcode/v2/config.json
// — NOT ~/.zcode/config.json (that legacy path is only used by its older
// CLI/cc-switch lineage and is ignored by the current app).
//
// The file is a map of provider entries, each one self-contained:
//
//   {
//     "provider": {
//       "xiaomi-coding": {
//         "enabled": true,
//         "name": "小米 MiMo Token Plan",
//         "source": "custom",
//         "kind": "openai-compatible",          // "anthropic" | "openai" | "openai-compatible"
//         "apiFormat": "openai-chat-completions", // anthropic-messages | openai-responses | openai-chat-completions
//         "options": { "baseURL": "...", "apiKey": "..." },
//         "models": { "mimo-v2.5": { "name": "MiMo V2.5", "kinds": [...], "defaultKind": "..." } }
//       }
//     }
//   }
//
// For opencode.ai gateway endpoints (opencode-zen / opencode-go) the entry
// additionally carries a "User-Agent: opencode/<version>" header (entry-level
// and options-level). The gateway rate-limits anonymous traffic separately
// from the official opencode client, which identifies itself via that UA;
// without it ZCode's requests land in the heavily rate-limited anonymous pool
// (429 FreeUsageLimitError → endless "reconnecting"). Verified live: the same
// endpoint + "public" key returns 200 with the UA and 429 without.
// Free-tier models also get explicit limit.{context,output} — ZCode's
// deepseek default of 384000 output exceeds the gateway's 131072 cap and gets
// rejected with 400 (see OPENCODE_FREE_MODEL_LIMITS).
//
// ZCode is an ADDITIVE agent: entries from every source coexist and the user
// switches between them inside ZCode's own model picker. OKIT must therefore
// never modify or remove entries it did not write. Ownership is tracked in
// user.json (managedModels, keyed by OKIT providerId); entries at the same
// base URL are adopted as OKIT's own so configs written by older OKIT versions
// (before tracking existed) keep working.
//
// kind/apiFormat mapping follows the documented ZCode custom-provider format
// (Trinity AI's ZCode cookbook + ZCode's own "Add provider" UI): Anthropic
// Messages → kind "anthropic" + apiFormat "anthropic-messages" (base URL
// without /v1); OpenAI Responses → kind "openai" + apiFormat
// "openai-responses"; Chat Completions → kind "openai-compatible" + apiFormat
// "openai-chat-completions" (base URL with /v1).

const ZCODE_CONFIG_PATH = path.join(os.homedir(), ".zcode", "v2", "config.json");

// The agent process (spawned by the ZCode desktop app) resolves its user
// settings from ~/.zcode/cli/config.json — the v2 config above is only the
// desktop app's own provider store, and its model→protocol projection drops
// per-model capability fields for non-catalog providers. Model-level media
// capabilities must therefore be declared here, as modelCatalog.overrides
// entries keyed "providerId/modelId" (verified against zcode.cjs 0.16.3:
// parsedConfigFileToRuntimePatch → X2o feeds overrides into the catalog, and
// supportsImages:false makes the agent drop image parts before the request —
// falling back to local OCR — instead of relaying image_url to a text-only
// gateway model, which answers 400).
const ZCODE_CLI_CONFIG_PATH = path.join(os.homedir(), ".zcode", "cli", "config.json");

// ZCode's override-entry schema is passthrough, so this marker survives
// validation and lets OKIT reclaim only the entries it wrote.
const OKIT_OVERRIDE_TAG = "_okitManaged";

interface ZCodeFormat {
  kind: string;
  apiFormat: string;
  baseURL: string;
}

// Map an OKIT-resolved provider (endpoint already pinned by routing.ts) to the
// ZCode provider entry fields. Anthropic endpoints get the trailing /v1
// stripped — ZCode appends /v1/messages itself; OpenAI-style endpoints keep it.
function zcodeFormatFor(provider: Provider): ZCodeFormat {
  const endpoint = provider.endpoints?.[0];
  const type = endpoint?.type || provider.type;
  const protocol = endpoint?.protocol || "chat";
  let baseURL = endpoint?.baseUrl || provider.baseUrl;

  if (type === "anthropic") {
    baseURL = baseURL.replace(/\/v1\/?$/, "");
    return { kind: "anthropic", apiFormat: "anthropic-messages", baseURL };
  }
  if (protocol === "responses") {
    return { kind: "openai", apiFormat: "openai-responses", baseURL };
  }
  return { kind: "openai-compatible", apiFormat: "openai-chat-completions", baseURL };
}

function buildProviderEntry(
  provider: Provider,
  modelNames: Map<string, string>,
  format: ZCodeFormat,
  apiKey?: string,
): Record<string, any> {
  const models: Record<string, any> = {};
  for (const [modelId, name] of modelNames) {
    const limit = modelLimitFor(format.baseURL, modelId);
    models[modelId] = limit
      ? { name: name || modelId, limit }
      : { name: name || modelId };
  }
  const options: Record<string, any> = { baseURL: format.baseURL };
  if (apiKey) options.apiKey = apiKey;

  const opencodeHeaders = gatewayHeadersFor(format.baseURL);

  const entry: Record<string, any> = {
    enabled: true,
    name: provider.name,
    source: "custom",
    kind: format.kind,
    apiFormat: format.apiFormat,
    options,
    models,
  };
  if (opencodeHeaders) {
    // ZCode's openai-compatible request builder honors both entry-level and
    // options-level headers; write both so either code path picks it up.
    entry.headers = opencodeHeaders;
    options.headers = opencodeHeaders;
  }
  return entry;
}

async function readV2Config(): Promise<Record<string, any>> {
  if (await fs.pathExists(ZCODE_CONFIG_PATH)) {
    const content = await fs.readFile(ZCODE_CONFIG_PATH, "utf-8");
    if (content.trim()) {
      try {
        return JSON.parse(content);
      } catch {
        // Corrupted file — start over rather than crash.
      }
    }
  }
  return {};
}

async function writeV2Config(data: Record<string, any>): Promise<void> {
  await fs.ensureDir(path.dirname(ZCODE_CONFIG_PATH));
  await atomicWriteJSON(ZCODE_CONFIG_PATH, data);
}

async function readCliConfig(): Promise<Record<string, any>> {
  if (await fs.pathExists(ZCODE_CLI_CONFIG_PATH)) {
    const content = await fs.readFile(ZCODE_CLI_CONFIG_PATH, "utf-8");
    if (content.trim()) {
      try {
        return JSON.parse(content);
      } catch {
        // Corrupted file — leave it alone; agent will surface its own
        // diagnostics. Writing a fresh file would nuke the user's MCP/plugin
        // config living in the same document.
      }
    }
  }
  return {};
}

async function writeCliConfig(data: Record<string, any>): Promise<void> {
  await fs.ensureDir(path.dirname(ZCODE_CLI_CONFIG_PATH));
  await atomicWriteJSON(ZCODE_CLI_CONFIG_PATH, data);
}

// A model is declared text-only when OKIT has positive capability data for it
// (capabilities present, no "vision"). Models without capability data stay
// untouched — blocking image input for a model that actually supports it
// would silently downgrade it to OCR.
function textOnlyModelIds(provider: Provider): string[] {
  return provider.models
    .filter(m => Array.isArray(m.capabilities) && m.capabilities.length > 0 && !m.capabilities.includes("vision"))
    .map(m => m.id);
}

function ownsOverride(entry: any): boolean {
  return entry && typeof entry === "object" && entry[OKIT_OVERRIDE_TAG] === true;
}

// Mirror the provider's text-only models into cli/config.json
// modelCatalog.overrides. Only OKIT-tagged entries for this provider are
// touched; user-written overrides (same or other keys) are preserved.
async function syncMediaOverrides(providerId: string, provider: Provider): Promise<void> {
  const cfg = await readCliConfig();
  const catalog = cfg.modelCatalog && typeof cfg.modelCatalog === "object" ? cfg.modelCatalog : undefined;
  const overrides = catalog?.overrides && typeof catalog.overrides === "object"
    ? { ...catalog.overrides }
    : {};
  const prefix = `${providerId}/`;

  let dirty = false;
  for (const key of Object.keys(overrides)) {
    if (key.startsWith(prefix) && ownsOverride(overrides[key])) {
      delete overrides[key];
      dirty = true;
    }
  }
  for (const modelId of textOnlyModelIds(provider)) {
    overrides[`${prefix}${modelId}`] = { supportsImages: false, [OKIT_OVERRIDE_TAG]: true };
    dirty = true;
  }
  if (!dirty && !catalog) return;
  if (Object.keys(overrides).length === 0 && !catalog) return;

  cfg.modelCatalog = { ...catalog, overrides };
  await writeCliConfig(cfg);
}

async function clearMediaOverrides(providerId: string): Promise<void> {
  const cfg = await readCliConfig();
  const catalog = cfg.modelCatalog;
  if (!catalog?.overrides || typeof catalog.overrides !== "object") return;
  const prefix = `${providerId}/`;
  const kept = Object.entries(catalog.overrides)
    .filter(([key, value]) => !(key.startsWith(prefix) && ownsOverride(value)));
  if (kept.length === Object.keys(catalog.overrides).length) return;
  cfg.modelCatalog = { ...catalog, overrides: Object.fromEntries(kept) };
  await writeCliConfig(cfg);
}

// OKIT owns an existing entry when the provider id is recorded in its managed
// list, or when the entry already points at this provider's endpoint (legacy
// OKIT writes / identical endpoint re-added via OKIT).
function ownsProviderEntry(
  entry: Record<string, any> | undefined,
  providerId: string,
  format: ZCodeFormat,
  managed: ManagedModels,
): boolean {
  if ((managed[providerId] || []).length > 0) return true;
  return Boolean(entry && typeof entry?.options?.baseURL === "string"
    && entry.options.baseURL === format.baseURL);
}

export class ZCodeAdapter extends BaseAdapter {
  readonly id = "zcode";
  readonly name = "ZCode";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.zcode;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  private async readManaged(): Promise<ManagedModels> {
    const config = await loadUserConfig();
    const managed = (config as any).providers?.zcode?.managedModels;
    return managed && typeof managed === "object" ? managed : {};
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);
    const data = await readV2Config();
    if (typeof data.provider !== "object" || data.provider === null) data.provider = {};
    const managed = await this.readManaged();

    const format = zcodeFormatFor(provider);
    const existing = data.provider[provider.id];
    if (existing && !ownsProviderEntry(existing, provider.id, format, managed)) {
      throw new Error(
        `ZCode 中已存在站点 "${provider.id}"（非 OKIT 写入，可能是手动添加），已跳过以免覆盖。如需 OKIT 管理，请先在 ZCode 中删除该站点。`,
      );
    }

    // provider.models is the card's visible (curated) set, prepared by the
    // caller — never the platform's full catalog, which would flood ZCode's
    // model picker. The model being switched to is always included.
    const names = new Map(provider.models.map(m => [m.id, m.name || m.id]));
    if (!names.has(modelId)) {
      names.set(modelId, provider.models.find(m => m.id === modelId)?.name || modelId);
    }
    data.provider[provider.id] = buildProviderEntry(provider, names, format, apiKey);
    managed[provider.id] = [...names.keys()];

    await writeV2Config(data);
    await syncMediaOverrides(provider.id, provider);
    await updateUserConfig({
      providers: { zcode: { providerId: provider.id, modelId, managedModels: managed } },
    } as any);
  }

  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };
    const data = await readV2Config();
    if (typeof data.provider !== "object" || data.provider === null) data.provider = {};
    const managed = await this.readManaged();

    const written: string[] = [];
    const skipped: string[] = [];
    const apiKeys = new Map<string, string | undefined>();
    // Group model ids per provider so one entry gets one models map.
    const byProvider = new Map<string, { provider: Provider; modelIds: string[] }>();
    for (const { provider, modelId } of entries) {
      if (!byProvider.has(provider.id)) byProvider.set(provider.id, { provider, modelIds: [] });
      byProvider.get(provider.id)!.modelIds.push(modelId);
    }

    for (const [providerId, group] of byProvider) {
      const format = zcodeFormatFor(group.provider);
      const existing = data.provider[providerId];
      if (existing && !ownsProviderEntry(existing, providerId, format, managed)) {
        for (const modelId of group.modelIds) skipped.push(modelId);
        continue;
      }
      if (!apiKeys.has(providerId)) {
        apiKeys.set(providerId, await this.resolveApiKey(group.provider));
      }
      // The models map mirrors what OKIT currently curates for this site:
      // the (caller-filtered) visible set + this batch. managedModels may
      // hold stale ids from older full-list writes — it is ownership
      // tracking, never the source of truth for what to write.
      const names = new Map<string, string>();
      for (const m of group.provider.models) {
        names.set(m.id, m.name || m.id);
      }
      for (const id of group.modelIds) {
        const model = group.provider.models.find(m => m.id === id);
        names.set(id, model?.name || id);
      }
      data.provider[providerId] = buildProviderEntry(group.provider, names, format, apiKeys.get(providerId));
      managed[providerId] = [...new Set([...(managed[providerId] || []), ...group.modelIds])];
      for (const modelId of group.modelIds) written.push(modelId);
    }

    if (written.length > 0) {
      await writeV2Config(data);
      for (const [providerId, group] of byProvider) {
        if (group.modelIds.some(id => written.includes(id))) {
          await syncMediaOverrides(providerId, group.provider);
        }
      }
      // Persist tracking without moving the "current" selection — enabling a
      // site only makes its models available; switching happens in ZCode.
      const config = await loadUserConfig();
      const sel = (config as any).providers?.zcode || {};
      await updateUserConfig({
        providers: {
          zcode: { providerId: sel.providerId, modelId: sel.modelId, managedModels: managed },
        },
      } as any);
    }
    return { written, skipped };
  }

  async listEnabledProviders(): Promise<string[]> {
    const data = await readV2Config();
    if (typeof data.provider !== "object" || data.provider === null) return [];
    return Object.entries(data.provider as Record<string, any>)
      .filter(([, entry]) => entry && entry.enabled !== false)
      .map(([id]) => id);
  }

  // ZCode records the model used by each task in its local sqlite index
  // (~/.zcode/v2/tasks-index.sqlite), format "providerId/modelId$variant".
  // The most recently updated active task is the best proxy for "what the
  // user is using right now" — ZCode has no global current-model field.
  async getActiveModel(): Promise<{ providerId: string; modelId: string } | null> {
    const fallback = async (): Promise<{ providerId: string; modelId: string } | null> => {
      const config = await loadUserConfig();
      const sel = (config as any).providers?.zcode;
      return sel?.providerId && sel?.modelId
        ? { providerId: sel.providerId, modelId: sel.modelId }
        : null;
    };

    const dbPath = path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
    if (!(await fs.pathExists(dbPath))) return fallback();
    try {
      // node:sqlite ships with Node ≥22.5. Resolve it indirectly so pkg's
      // Node 18 binary can still be built; at runtime that binary falls back
      // to the persisted OKIT selection through the catch block below.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const runtimeRequire = eval("require") as NodeRequire;
      const { DatabaseSync } = runtimeRequire("node:" + "sqlite") as {
        DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
          prepare(sql: string): { get(): { model?: string } | undefined };
          close(): void;
        };
      };
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT model FROM tasks WHERE deleted = 0 AND model IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
          .get();
        if (row?.model) {
          const [providerId, modelPart = ""] = row.model.split("/");
          const modelId = modelPart.split("$")[0];
          if (providerId && modelId) return { providerId, modelId };
        }
      } finally {
        db.close();
      }
    } catch {
      // Database locked / sqlite unavailable — fall back to user selection.
    }
    return fallback();
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.zcode || {};
    const managed = await this.readManaged();
    // Nothing OKIT wrote for this provider and it isn't the current selection
    // — nothing to flip.
    if (!(providerId in managed) && sel.providerId !== providerId) return;

    const data = await readV2Config();
    const entry = data.provider?.[providerId];
    if (entry) {
      // Preserve the entry (models + options) — only flip the switch. ZCode's
      // own UI keeps disabled providers in the config and hides them from the
      // model picker, so this is the least surprising state.
      entry.enabled = enabled;
      await writeV2Config(data);
    }

    // A disabled provider can't stay current — clear the selection so the
    // home page shows the switch off. managedModels is kept so re-enabling
    // (switchProvider) continues to own the entry.
    const wasCurrent = sel.providerId === providerId;
    await updateUserConfig({
      providers: {
        zcode: {
          providerId: wasCurrent ? undefined : sel.providerId,
          modelId: wasCurrent ? undefined : sel.modelId,
          managedModels: managed,
        },
      },
    } as any);
  }

  async removeProvider(providerId: string): Promise<void> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.zcode || {};
    const managed = await this.readManaged();
    const data = await readV2Config();
    const hasEntry = typeof data.provider === "object" && data.provider !== null && providerId in data.provider;
    // Owned = tracked in managedModels, the current selection, or a config
    // entry under a non-builtin id. managedModels can lose records to sync
    // overwrites of user.json — the config entry itself (under an OKIT
    // provider id, never a ZCode builtin:*) is evidence OKIT wrote it.
    if (!(providerId in managed) && sel.providerId !== providerId && (providerId.startsWith("builtin:") || !hasEntry)) return;

    if (hasEntry) {
      delete data.provider[providerId];
      await writeV2Config(data);
    }
    await clearMediaOverrides(providerId);

    delete managed[providerId];
    const wasCurrent = sel.providerId === providerId;
    await updateUserConfig({
      providers: {
        zcode: {
          providerId: wasCurrent ? undefined : sel.providerId,
          modelId: wasCurrent ? undefined : sel.modelId,
          managedModels: managed,
        },
      },
    } as any);
  }
}
