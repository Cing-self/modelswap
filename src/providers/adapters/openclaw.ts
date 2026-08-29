import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig } from "../../config/user";
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
    const state = config.agentProviders?.openclaw;
    if (state?.activeProviderId && state?.activeModelId) {
      return { providerId: state.activeProviderId, modelId: state.activeModelId };
    }
    return null;
  }

  async applyConfig(provider: Provider, modelId: string, resolvedModel?: ResolvedModel): Promise<void> {
    // Keep the routed model ID: ResolvedModel.id is canonical and may differ
    // from the actual ID this endpoint accepts.
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
      models: provider.models.map(m => {
        // The selected model facts come from the same ResolvedModel passed by
        // Web and CLI.  Other selected entries can carry their own facts from
        // the Web multi-model write.
        const isSelected = m.id === modelId || Boolean(resolvedModel && m.resolved?.id === resolvedModel.id);
        const facts = isSelected ? (resolvedModel || m.resolved) : m.resolved;
        return {
          // Web's selected provider list carries canonical IDs, while a
          // routed provider already carries remote IDs. Both must materialize
          // the selected entry under the route's native request ID.
          id: isSelected ? modelId : m.id,
          name: facts?.name || m.name || m.id,
          ...(typeof facts?.reasoning === "boolean" ? { reasoning: facts.reasoning } : {}),
          ...(facts?.modalities.input?.length ? { input: facts.modalities.input } : {}),
          ...(Number.isFinite(facts?.context) ? { contextWindow: facts!.context } : {}),
          ...(Number.isFinite(facts?.output) ? { maxTokens: facts!.output } : {}),
        };
      }),
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
  }
}
