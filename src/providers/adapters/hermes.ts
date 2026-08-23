import fs from "fs-extra";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite } from "../../utils/atomicWrite";

// Hermes (v0.12+ through v0.20.x) keeps ALL of its config in
// ~/.hermes/config.yaml — NOT config.json. Custom providers live in a
// `custom_providers:` list (entries matched by `name`, mirroring cc-switch's
// hermes adapter) and the active model is the `model.default:` string in
// "provider-name/model-id" form. The previous OKIT adapter wrote a
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
    const sel = (config as any).providers?.hermes;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(path.dirname(HERMES_CONFIG_PATH));
    let data: Record<string, any> = {};
    if (await fs.pathExists(HERMES_CONFIG_PATH)) {
      const content = await fs.readFile(HERMES_CONFIG_PATH, "utf-8");
      if (content.trim()) data = (yaml.load(content) as Record<string, any>) || {};
    }

    // custom_providers list keyed by display name; replace our entry in place
    // and leave any others (user-entered or from Hermes itself) untouched.
    if (!Array.isArray(data.custom_providers)) data.custom_providers = [];
    const entry: Record<string, any> = {
      name: provider.name,
      base_url: provider.baseUrl,
    };
    if (apiKey) entry.api_key = apiKey;
    // api_mode is only meaningful for Anthropic-protocol endpoints; Hermes
    // treats OpenAI-compatible URLs as the default transport.
    if (provider.type === "anthropic") entry.api_mode = "anthropic_messages";
    // The opencode.ai gateway rate-limits anonymous traffic separately from the
    // official opencode client (verified 429 without the UA). Hermes sends its
    // own UA, so pin the opencode client's one via extra_headers (see gateway.ts).
    const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
    if (gatewayHeaders) entry.extra_headers = gatewayHeaders;
    const idx = data.custom_providers.findIndex(
      (p: any) => p && typeof p === "object" && p.name === provider.name,
    );
    if (idx >= 0) data.custom_providers[idx] = entry;
    else data.custom_providers.push(entry);

    // Active model: "provider-name/model-id" string under model.default.
    if (typeof data.model !== "object" || data.model === null) data.model = {};
    data.model.default = `${provider.name}/${modelId}`;
    // Hermes routes requests via model.provider + model.base_url, NOT the
    // custom_providers list (which only feeds the provider picker). Without
    // these keys a stale built-in provider (e.g. `zai`) keeps winning and
    // traffic never reaches the third-party endpoint. Docs: custom endpoints
    // set model.provider = "custom" with an explicit base_url/api_key.
    data.model.provider = "custom";
    data.model.base_url = provider.baseUrl;
    if (apiKey) data.model.api_key = apiKey;
    if (provider.type === "anthropic") data.model.api_mode = "anthropic_messages";

    await atomicWrite(HERMES_CONFIG_PATH, yaml.dump(data, { lineWidth: 120, noRefs: true }));
    await updateUserConfig({
      providers: { hermes: { providerId: provider.id, modelId } },
    } as any);
  }
}
