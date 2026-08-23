import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite } from "../../utils/atomicWrite";

// MiMo Code (Xiaomi, @mimo-ai/cli) is a fork of OpenCode, so its user config
// (~/.config/mimocode/mimocode.jsonc) uses the same additive schema: a
// `provider` object map (AI SDK npm package + options + models) plus a
// top-level `model = "<providerId>/<modelId>"`. Only the first `/` separates
// the provider id from the model id. apiKey lives in `options.apiKey`.
const MIMO_CODE_DIR = path.join(os.homedir(), ".config", "mimocode");
const MIMO_CODE_CONFIG_PATH = path.join(MIMO_CODE_DIR, "mimocode.jsonc");

// Map OKIT's protocol type to the AI SDK package MiMo Code loads for it.
function npmPackageFor(type: ProviderType): string {
  switch (type) {
    case "anthropic": return "@ai-sdk/anthropic";
    case "openai":
    default: return "@ai-sdk/openai-compatible";
  }
}

// JSONC -> JSON: strip // and /* */ comments and trailing commas, keeping
// string contents intact. Config files MiMo Code writes may contain comments.
function stripJsonc(content: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (i < content.length) {
    const ch = content[i];
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j])) j++;
      if (content[j] === "}" || content[j] === "]") {
        i++;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

export class MimoCodeAdapter extends BaseAdapter {
  readonly id = "mimo-code";
  readonly name = "MiMo Code";
  readonly supportedTypes: ProviderType[] = ["openai", "anthropic"];

  // Models keyed by the upstream model id (ids containing `/` are fine — only
  // the first `/` in `model` separates provider from model). Free-tier models
  // get explicit `limit` so max_tokens never exceeds the gateway cap.
  private buildModelsMap(provider: Provider): Record<string, any> {
    const modelsMap: Record<string, any> = {};
    for (const m of provider.models) {
      const limit = modelLimitFor(provider.baseUrl, m.id);
      modelsMap[m.id] = limit
        ? { name: m.name || m.id, limit }
        : { name: m.name || m.id };
    }
    return modelsMap;
  }

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.["mimo-code"];
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  private async loadConfig(): Promise<Record<string, any>> {
    if (!(await fs.pathExists(MIMO_CODE_CONFIG_PATH))) return {};
    const content = await fs.readFile(MIMO_CODE_CONFIG_PATH, "utf-8");
    if (!content.trim()) return {};
    try {
      return JSON.parse(stripJsonc(content));
    } catch {
      return {};
    }
  }

  private async saveConfig(data: Record<string, any>): Promise<void> {
    await fs.ensureDir(MIMO_CODE_DIR);
    await atomicWrite(MIMO_CODE_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);
    const data = await this.loadConfig();

    if (typeof data.provider !== "object" || data.provider === null) data.provider = {};
    if (!("$schema" in data) && Object.keys(data).length === 0) {
      data.$schema = "https://mimo.xiaomi.com/mimocode/config.json";
    }

    const providerEntry: Record<string, any> = {
      name: provider.name,
      npm: npmPackageFor(provider.type),
      only_configured_models: true,
      options: {
        baseURL: provider.baseUrl,
      },
    };
    if (apiKey) providerEntry.options.apiKey = apiKey;

    const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
    if (gatewayHeaders) providerEntry.options.headers = gatewayHeaders;

    providerEntry.models = this.buildModelsMap(provider);

    (data.provider as Record<string, any>)[provider.id] = providerEntry;
    data.model = `${provider.id}/${modelId}`;

    await this.saveConfig(data);
    await updateUserConfig({
      providers: { "mimo-code": { providerId: provider.id, modelId } },
    } as any);
  }

  // Additive (multi-site): write one site's provider entry without touching
  // any other site or the active model selection.
  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };

    const data = await this.loadConfig();
    if (typeof data.provider !== "object" || data.provider === null) data.provider = {};
    if (!("$schema" in data) && Object.keys(data).length === 0) {
      data.$schema = "https://mimo.xiaomi.com/mimocode/config.json";
    }

    const written: string[] = [];
    const apiKeys = new Map<string, string>();
    for (const { provider, modelId } of entries) {
      if (!apiKeys.has(provider.id)) {
        apiKeys.set(provider.id, (await this.resolveApiKey(provider)) || "");
      }
      const existing = (data.provider as Record<string, any>)[provider.id];
      const providerEntry: Record<string, any> = {
        name: provider.name,
        npm: npmPackageFor(provider.type),
        only_configured_models: true,
        options: existing?.options && typeof existing.options === "object"
          ? { ...existing.options, baseURL: provider.baseUrl }
          : { baseURL: provider.baseUrl },
      };
      const apiKey = apiKeys.get(provider.id);
      if (apiKey) providerEntry.options.apiKey = apiKey;

      const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
      if (gatewayHeaders) providerEntry.options.headers = gatewayHeaders;

      providerEntry.models = this.buildModelsMap(provider);

      (data.provider as Record<string, any>)[provider.id] = providerEntry;
      written.push(modelId);
    }

    await this.saveConfig(data);
    return { written, skipped: [] };
  }

  // Which OKIT provider ids currently have an entry in mimo's config.
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