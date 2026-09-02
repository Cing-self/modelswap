import fs from "fs-extra";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig } from "../../config/user";
import { atomicWrite } from "../../utils/atomicWrite";

// Hermes (v0.12+ through v0.20.x) keeps ALL of its config in
// ~/.hermes/config.yaml — NOT config.json. Custom providers live in a
// `custom_providers:` list (entries matched by `name`, mirroring cc-switch's
// hermes adapter) and the active model is the `model.default:` string in
// "provider-name/model-id" form. The previous MODELSWAP adapter wrote a
// config.json with a models.providers/agents.defaults tree that no Hermes
// version ever read.
const HERMES_CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");

export class HermesAdapter extends BaseAdapter {
  readonly id = "hermes";
  readonly name = "Hermes";
  readonly supportedTypes: ProviderType[] = ["anthropic", "openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const state = config.agentProviders?.hermes;
    if (state?.activeProviderId && state?.activeModelId) {
      return { providerId: state.activeProviderId, modelId: state.activeModelId };
    }
    return null;
  }

  async applyConfig(provider: Provider, modelId: string, resolvedModel?: ResolvedModel): Promise<void> {
    // `modelId` is the routed provider-native model ID. The resolved ID is
    // canonical metadata and must never replace it in Hermes config.
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(path.dirname(HERMES_CONFIG_PATH));
    let data: Record<string, any> = {};
    if (await fs.pathExists(HERMES_CONFIG_PATH)) {
      const content = await fs.readFile(HERMES_CONFIG_PATH, "utf-8");
      if (content.trim()) data = (yaml.load(content) as Record<string, any>) || {};
    }

    // Hermes config v12 stores named custom endpoints in `providers`, keyed by
    // a stable identifier. Its legacy `custom_providers` list is deliberately
    // left untouched: Hermes reads it and upgrades it itself, while replacing
    // it here could erase user-managed legacy entries.
    if (typeof data.providers !== "object" || data.providers === null || Array.isArray(data.providers)) {
      data.providers = {};
    }
    const entry: Record<string, any> = {
      api: provider.baseUrl,
      default_model: modelId,
    };
    if (apiKey) entry.api_key = apiKey;
    entry.transport = provider.type === "anthropic" ? "anthropic_messages" : "chat_completions";
    // The opencode.ai gateway rate-limits anonymous traffic separately from the
    // official opencode client (verified 429 without the UA). Hermes sends its
    // own UA, so pin the opencode client's one via extra_headers (see gateway.ts).
    const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
    if (gatewayHeaders) entry.extra_headers = gatewayHeaders;
    const modelFacts: Record<string, any> = {};
    if (Number.isFinite(resolvedModel?.context)) modelFacts.context_length = resolvedModel!.context;
    if (resolvedModel?.modalities.input?.includes("image")) modelFacts.supports_vision = true;
    if (Object.keys(modelFacts).length) entry.models = { [modelId]: modelFacts };
    data.providers[provider.id] = entry;

    // Active model selects the named custom provider and its default model.
    if (typeof data.model !== "object" || data.model === null) data.model = {};
    data.model.default = modelId;
    data.model.provider = `custom:${provider.id}`;
    if (Number.isFinite(resolvedModel?.context)) data.model.context_length = resolvedModel!.context;
    else delete data.model.context_length;
    if (Number.isFinite(resolvedModel?.output)) data.model.max_tokens = resolvedModel!.output;
    else delete data.model.max_tokens;
    if (resolvedModel?.modalities.input?.includes("image")) data.model.supports_vision = true;
    else delete data.model.supports_vision;
    // `reasoning` has no provider-neutral Hermes setting. It is expressed via
    // provider-specific `extra_body`, so emitting one from a boolean fact
    // would be an unsupported guess.

    await atomicWrite(HERMES_CONFIG_PATH, yaml.dump(data, { lineWidth: 120, noRefs: true }));
  }
}
