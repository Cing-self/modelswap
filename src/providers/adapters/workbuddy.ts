import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { modelFacts } from "./model-facts";
import { AgentSelection, AuthStatus, ManagedModels, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";

const WORKBUDDY_DIR = path.join(os.homedir(), ".workbuddy");
const WORKBUDDY_MODELS_PATH = path.join(WORKBUDDY_DIR, "models.json");

// WorkBuddy models.json is a TOP-LEVEL ARRAY of custom model entries — the
// format WorkBuddy's own UI writes. (A legacy {models: [...], availableModels:
// [...]} wrapper is still accepted by WorkBuddy's loader, but OKIT always
// writes the native array form and NEVER the availableModels field: that field
// is a whitelist over the whole model catalog — when non-empty, every model
// not listed (including all WorkBuddy presets) is hidden from the UI.)
//
// WorkBuddy is an ADDITIVE agent: entries from every source coexist and the
// user switches between them inside WorkBuddy's own model picker. OKIT must
// therefore never modify or remove entries it did not write. Ownership is
// tracked in user.json (managedModels, keyed by OKIT providerId); entries at
// the same endpoint base URL are adopted as OKIT's own so configs written by
// older OKIT versions (before tracking existed) keep working.
//
// Entries carry capability flags only when the shared resolved model has an
// explicit fact. Unknown is intentionally omitted; adapters must not turn a
// model-name guess into a persisted runtime capability.

function chatUrlFor(provider: Provider): string {
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  return baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
}

// Compare endpoints by base URL so entries whose URL lacks (or repeats) the
// /chat/completions suffix still count as the same endpoint. WorkBuddy and
// its template UI write both forms interchangeably.
function endpointBase(url: unknown): string {
  return typeof url === "string"
    ? url.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "")
    : "";
}

type WorkBuddyModelEntry = Record<string, any>;

async function readModelsFile(): Promise<WorkBuddyModelEntry[]> {
  if (await fs.pathExists(WORKBUDDY_MODELS_PATH)) {
    const content = await fs.readFile(WORKBUDDY_MODELS_PATH, "utf-8");
    if (content.trim()) {
      try {
        const parsed = JSON.parse(content);
        // Native format: top-level array. Legacy wrapper: {models: [...]}.
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.models)) return parsed.models;
      } catch {
        // Corrupted file — start over rather than crash.
      }
    }
  }
  return [];
}

async function writeModelsFile(models: WorkBuddyModelEntry[]): Promise<void> {
  await fs.ensureDir(WORKBUDDY_DIR);
  await atomicWriteJSON(WORKBUDDY_MODELS_PATH, models);
}

export class WorkBuddyAdapter extends BaseAdapter {
  readonly id = "workbuddy";
  readonly name = "WorkBuddy";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const state = config.agentProviders?.workbuddy;
    if (state?.activeProviderId && state?.activeModelId) {
      return { providerId: state.activeProviderId, modelId: state.activeModelId };
    }
    // Read-only compatibility for callers that still pass an in-memory legacy
    // config; loadUserConfig migrates persisted files before normal use.
    const legacy = (config as any).providers?.workbuddy;
    if (legacy?.providerId && legacy?.modelId) return legacy;
    return null;
  }

  private async readManaged(): Promise<ManagedModels> {
    const config = await loadUserConfig();
    const sites = config.agentProviders?.workbuddy?.sites || {};
    if (Object.keys(sites).length > 0) {
      return Object.fromEntries(Object.entries(sites).map(([providerId, site]) => [providerId, [...(site.modelIds || [])]]));
    }
    const legacy = (config as any).providers?.workbuddy?.managedModels;
    return legacy && typeof legacy === "object" ? legacy : {};
  }

  private async persistState(managed: ManagedModels, active?: AgentSelection | null): Promise<void> {
    const config = await loadUserConfig();
    const previous = config.agentProviders?.workbuddy || { sites: {} };
    const sites: Record<string, any> = { ...previous.sites };
    for (const providerId of Object.keys(sites)) {
      if (!(providerId in managed)) sites[providerId] = null;
    }
    for (const [providerId, modelIds] of Object.entries(managed)) {
      sites[providerId] = { ...sites[providerId], modelIds: [...new Set(modelIds)], enabled: true };
    }
    const next = {
      ...previous,
      ...(active?.providerId ? { activeProviderId: active.providerId } : {}),
      ...(active?.modelId ? { activeModelId: active.modelId } : {}),
      sites,
    };
    if (active === null) {
      next.activeProviderId = undefined;
      next.activeModelId = undefined;
    }
    await updateUserConfig({ agentProviders: { workbuddy: next } } as any);
  }

  private upsertEntry(
    models: WorkBuddyModelEntry[],
    provider: Provider,
    modelId: string,
    apiKey?: string,
  ): WorkBuddyModelEntry {
    const chatUrl = chatUrlFor(provider);
    const model = provider.models.find(m => m.id === modelId);
    const resolved = modelFacts(provider, modelId);

    let entry = models.find(m => m.id === modelId);
    if (!entry) {
      entry = { id: modelId };
      models.push(entry);
    }
    entry.name = model?.name || modelId;
    entry.vendor = provider.name;
    entry.url = chatUrl;
    if (apiKey) {
      entry.apiKey = apiKey;
    }

    if (resolved.tool !== undefined) entry.supportsToolCall = resolved.tool;
    else delete entry.supportsToolCall;
    if (resolved.modalities.input.length > 0) entry.supportsImages = resolved.modalities.input.some(value => /image|video/i.test(value));
    else delete entry.supportsImages;
    if (resolved.reasoning !== undefined) entry.supportsReasoning = resolved.reasoning;
    else delete entry.supportsReasoning;
    if (resolved.context !== undefined) entry.maxInputTokens = resolved.context;
    else delete entry.maxInputTokens;
    if (resolved.output !== undefined) entry.maxOutputTokens = resolved.output;
    else delete entry.maxOutputTokens;
    const effort = resolved.reasoningOptions?.find(option => option.type === "effort" && Array.isArray(option.values));
    if (resolved.reasoning && effort?.values?.length) {
      entry.reasoning = {
        defaultEffort: effort.values.includes("high") ? "high" : effort.values[0],
        supportedEfforts: effort.values,
      };
    } else {
      delete entry.reasoning;
    }
    return entry;
  }

  // OKIT owns an existing entry when the model id is recorded in its managed
  // list, or when the entry already points at this provider's endpoint (legacy
  // OKIT writes / identical endpoint re-added via OKIT).
  private ownsEntry(entry: WorkBuddyModelEntry | undefined, modelId: string, providerId: string, managed: ManagedModels, chatUrl: string): boolean {
    if ((managed[providerId] || []).includes(modelId)) return true;
    return Boolean(entry && endpointBase(entry.url) === endpointBase(chatUrl));
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);
    const models = await readModelsFile();
    const managed = await this.readManaged();

    const chatUrl = chatUrlFor(provider);
    const entry = models.find(m => m.id === modelId);
    if (entry && !this.ownsEntry(entry, modelId, provider.id, managed, chatUrl)) {
      throw new Error(
        `WorkBuddy 中已存在模型 "${modelId}"（非 OKIT 写入，可能是官方预设），已跳过以免覆盖。如需 OKIT 管理，请先在 WorkBuddy 中删除该模型。`,
      );
    }

    this.upsertEntry(models, provider, modelId, apiKey);
    managed[provider.id] = [...new Set([...(managed[provider.id] || []), modelId])];

    await writeModelsFile(models);
    await this.persistState(managed, { providerId: provider.id, modelId });
  }

  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };
    const models = await readModelsFile();
    const managed = await this.readManaged();

    const written: string[] = [];
    const skipped: string[] = [];
    const apiKeys = new Map<string, string | undefined>();
    for (const { provider, modelId } of entries) {
      const entry = models.find(m => m.id === modelId);
      if (entry && !this.ownsEntry(entry, modelId, provider.id, managed, chatUrlFor(provider))) {
        skipped.push(modelId);
        continue;
      }
      if (!apiKeys.has(provider.id)) {
        apiKeys.set(provider.id, await this.resolveApiKey(provider));
      }
      this.upsertEntry(models, provider, modelId, apiKeys.get(provider.id));
      managed[provider.id] = [...new Set([...(managed[provider.id] || []), modelId])];
      written.push(modelId);
    }

    if (written.length > 0) {
      await writeModelsFile(models);
      await this.persistState(managed, await this.getCurrentConfig());
    }
    return { written, skipped };
  }

  async listEnabledProviders(): Promise<string[]> {
    // WorkBuddy config has no enabled flag — an entry present IS enabled.
    // OKIT-managed provider ids are the ones we know were written and still
    // own entries for.
    return Object.keys(await this.readManaged());
  }

  async removeProvider(providerId: string): Promise<void> {
    const sel = await this.getCurrentConfig();
    const managed = await this.readManaged();
    const ids = managed[providerId] || [];
    if (!(providerId in managed) && sel?.providerId !== providerId) return;

    // Keep entries still claimed by another OKIT provider (shared model ids
    // between merged families, e.g. kimi/moonshot).
    const claimedByOther = (id: string) =>
      Object.entries(managed).some(([pid, list]) => pid !== providerId && list.includes(id));

    const models = await readModelsFile();
    const kept = models.filter(m => !(ids.includes(m.id) && !claimedByOther(m.id)));

    delete managed[providerId];

    await writeModelsFile(kept);
    const wasCurrent = sel?.providerId === providerId;
    await this.persistState(managed, wasCurrent ? null : sel);
  }
}
