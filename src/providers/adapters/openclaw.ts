import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

// Map OKIT's protocol type to the OpenClaw `api` field. OpenClaw routes by this
// string, not by an internal type enum. Mirrors cc-switch presets.
function apiProtocolFor(type: ProviderType): string {
  switch (type) {
    case "anthropic": return "anthropic";
    case "openai":
    default: return "openai-completions";
  }
}

export class OpenClawAdapter extends BaseAdapter {
  readonly id = "openclaw";
  readonly name = "OpenClaw";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.openclaw;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(path.dirname(OPENCLAW_CONFIG_PATH));
    let data: Record<string, any> = {};
    if (await fs.pathExists(OPENCLAW_CONFIG_PATH)) {
      const content = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
      data = content.trim() ? JSON.parse(content) : {};
    }

    // models is an object: { mode: "merge", providers: { <id>: {...} } }.
    // Providers are KEYED BY ID (object map), not an array — mirrors cc-switch.
    if (typeof data.models !== "object" || data.models === null) data.models = {};
    if (!data.models.mode) data.models.mode = "merge";
    if (typeof data.models.providers !== "object" || data.models.providers === null) {
      data.models.providers = {};
    }

    const providerEntry: Record<string, any> = {
      baseUrl: provider.baseUrl,
      api: apiProtocolFor(provider.type),
      models: provider.models.map(m => ({
        id: m.id,
        name: m.name || m.id,
      })),
    };
    if (apiKey) providerEntry.apiKey = apiKey;
    data.models.providers[provider.id] = providerEntry;

    // agents.defaults.model (note plural "defaults") is an object:
    // { primary: "provider/model", fallbacks: [...] }. Not agents.default.
    if (typeof data.agents !== "object" || data.agents === null) data.agents = {};
    if (typeof data.agents.defaults !== "object" || data.agents.defaults === null) {
      data.agents.defaults = {};
    }
    data.agents.defaults.model = {
      primary: `${provider.id}/${modelId}`,
      fallbacks: [],
    };

    await atomicWriteJSON(OPENCLAW_CONFIG_PATH, data);
    await updateUserConfig({
      providers: { openclaw: { providerId: provider.id, modelId } },
    } as any);
  }
}
