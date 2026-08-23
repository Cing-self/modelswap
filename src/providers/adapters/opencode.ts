import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";

// OpenCode reads ~/.config/opencode/opencode.json (NOT ~/.opencode/config.json).
// The schema is additive: provider is an object keyed by provider id, each entry
// carries the AI SDK npm package + options + models. Mirrors cc-switch's
// opencode_config.rs + OpenCodeProviderConfig. Previous OKIT version wrote a
// flat {provider, model, apiKey, baseUrl} shape that OpenCode never reads.
//
// OpenCode is the reference opencode client, so for opencode.ai endpoints it
// already sends the right User-Agent itself (its requests stay in the
// official-client quota pool) — the headers written here are a no-op for those
// endpoints but are still applied uniformly. Per-model `limit` matters for
// free-tier models: opencode's own built-in catalog knows the zen limits, but
// OKIT-authored providers (user-added sites) get explicit limits so max_tokens
// never exceeds the gateway cap (see gateway.ts).
const OPENCODE_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

// Map OKIT's protocol type to the AI SDK package OpenCode loads for it.
function npmPackageFor(type: ProviderType): string {
  switch (type) {
    case "anthropic": return "@ai-sdk/anthropic";
    case "openai":
    default: return "@ai-sdk/openai-compatible";
  }
}

export class OpenCodeAdapter extends BaseAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.opencode;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  private async loadConfig(): Promise<Record<string, any>> {
    await fs.ensureDir(path.dirname(OPENCODE_CONFIG_PATH));
    if (await fs.pathExists(OPENCODE_CONFIG_PATH)) {
      const content = await fs.readFile(OPENCODE_CONFIG_PATH, "utf-8");
      if (content.trim()) return JSON.parse(content);
    }
    return {};
  }

  private async saveConfig(data: Record<string, any>): Promise<void> {
    await atomicWriteJSON(OPENCODE_CONFIG_PATH, data);
  }

  // Writes one provider entry (merged, other providers untouched).
  private async writeProviderEntry(data: Record<string, any>, provider: Provider): Promise<void> {
    if (typeof data.provider !== "object" || data.provider === null) data.provider = {};
    if (!("$schema" in data) && Object.keys(data).length === 0) {
      data.$schema = "https://opencode.ai/config.json";
    }

    const apiKey = await this.resolveApiKey(provider);
    const providerEntry: Record<string, any> = {
      npm: npmPackageFor(provider.type),
      name: provider.name,
      options: {
        baseURL: provider.baseUrl,
      },
    };
    if (apiKey) providerEntry.options.apiKey = apiKey;

    const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
    if (gatewayHeaders) providerEntry.options.headers = gatewayHeaders;

    // Models: object keyed by model id. Surface the full list so OpenCode can
    // offer all of them; the active one is chosen via the `model` top-level key.
    // Free-tier models get explicit `limit` so max_tokens never exceeds the
    // gateway cap (see gateway.ts).
    const modelsMap: Record<string, any> = {};
    for (const m of provider.models) {
      const limit = modelLimitFor(provider.baseUrl, m.id);
      modelsMap[m.id] = limit
        ? { name: m.name || m.id, limit }
        : { name: m.name || m.id };
    }
    providerEntry.models = modelsMap;

    (data.provider as Record<string, any>)[provider.id] = providerEntry;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const data = await this.loadConfig();
    await this.writeProviderEntry(data, provider);

    // OpenCode is additive-mode: all configured providers coexist and OpenCode
    // itself picks which one to use (there is no "active provider" concept that
    // OKIT needs to set — mirrors cc-switch where ProviderService::current()
    // returns empty for additive apps). We only ensure this provider + its
    // models are present.

    await this.saveConfig(data);
    await updateUserConfig({
      providers: { opencode: { providerId: provider.id, modelId } },
    } as any);
  }

  // Additive (multi-site): write one site's provider entry without touching
  // any other site. Mirrors the mimo-code adapter so the home-page add flow
  // ("添加" writes the agent config immediately) works the same way.
  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };
    const data = await this.loadConfig();
    const written: string[] = [];
    for (const { provider, modelId } of entries) {
      await this.writeProviderEntry(data, provider);
      written.push(modelId);
    }
    await this.saveConfig(data);
    return { written, skipped: [] };
  }

  // Which OKIT provider ids currently have an entry in opencode's config.
  async listEnabledProviders(): Promise<string[]> {
    const data = await this.loadConfig();
    if (typeof data.provider !== "object" || data.provider === null) return [];
    return Object.keys(data.provider);
  }

  // Remove one site: its provider entry, and the active model if it pointed
  // at that provider.
  async removeProvider(providerId: string): Promise<void> {
    const data = await this.loadConfig();
    if (typeof data.provider !== "object" || data.provider === null) return;
    if (!(providerId in (data.provider as Record<string, any>))) return;

    delete (data.provider as Record<string, any>)[providerId];
    if (typeof data.model === "string" && data.model.split("/")[0] === providerId) {
      delete data.model;
    }
    await this.saveConfig(data);
  }
}
