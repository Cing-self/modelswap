import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { atomicWrite } from "../../utils/atomicWrite";
import { ModelCapabilities, resolveModelCapabilities } from "../capabilities";
import { loadProviders } from "../store";
import {
  escapeRegex,
  getTableKeyValue,
  normalizeToml,
  removeTableKey,
  sanitizeTomlKey,
  stripMatchingTables,
  tomlInlineTable,
  tomlString,
  upsertTableKey,
  upsertTomlTable,
} from "./toml-utils";

// Grok Build (xAI) reads ~/.grok/config.toml (or $GROK_HOME/config.toml).
// Custom models are registered as `[model.<id>]` tables; `[models] default`
// names the active one. Model tables may carry an inline `api_key` (docs list
// it; env_key is preferred but needs an env var OKIT cannot set persistently).
// Multi-site (additive) works like kimi-code: many `[model.okit-*]` tables
// coexist and only `[models] default` selects which one is active.
const GROK_DIR = path.join(os.homedir(), ".grok");
const GROK_CONFIG_PATH = path.join(GROK_DIR, "config.toml");

const DEFAULT_CONTEXT_SIZE = 1000000;

function getModelAlias(providerId: string, modelId: string): string {
  return `okit-${sanitizeTomlKey(providerId)}-${sanitizeTomlKey(modelId)}`;
}

function modelTablePattern(providerId: string): RegExp {
  return new RegExp(`^\\s*\\[model\\.${escapeRegex(getModelAlias(providerId, ""))}[a-zA-Z0-9_-]*\\]\\s*(?:#.*)?$`);
}

// The wire protocol grok speaks for an endpoint: anthropic-type providers use
// the Anthropic Messages protocol, responses-protocol OpenAI endpoints use
// Responses, everything else uses plain chat_completions.
function getApiBackend(provider: Provider): string {
  const endpoints = provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }];
  const endpoint = endpoints.find(ep => ep.type === provider.type) || endpoints[0];
  if (provider.type === "anthropic") return "messages";
  return endpoint?.protocol === "responses" ? "responses" : "chat_completions";
}

// ERNIE-family models reject JSON Schema union types (`"type": ["integer", "null"]`)
// that grok embeds in its tool definitions. Route them through OKIT's local
// sanitizing proxy (src/web/api/grok-proxy.js), which rewrites union types to
// a single type before forwarding to the upstream endpoint.
const GROK_PROXY_ORIGIN = "http://127.0.0.1:3780/api/grok-proxy";

function needsToolSchemaProxy(modelId: string): boolean {
  return /ernie/i.test(modelId);
}

function effectiveBaseUrl(provider: Provider, modelId: string): string {
  if (!needsToolSchemaProxy(modelId)) return provider.baseUrl;
  return `${GROK_PROXY_ORIGIN}/${encodeURIComponent(provider.baseUrl)}`;
}

function buildModelTable(provider: Provider, apiKey: string | undefined, modelId: string): string[] {
  const caps = resolveModelCapabilities(modelId);
  // Gateway free-tier models (opencode.ai / openrouter.ai) get their real
  // context window from gateway.ts so grok doesn't overfill the context (see
  // gateway.ts). grok's model tables have no output-limit field, so only
  // context is applied here.
  const gatewayLimit = modelLimitFor(provider.baseUrl, modelId);
  const table = [
    `model = ${tomlString(modelId)}`,
    `base_url = ${tomlString(effectiveBaseUrl(provider, modelId))}`,
    `name = ${tomlString(`${provider.name} ${modelId}`)}`,
    `api_backend = ${tomlString(getApiBackend(provider))}`,
    `context_window = ${gatewayLimit?.context ?? caps.maxInputTokens ?? DEFAULT_CONTEXT_SIZE}`,
  ];
  if (apiKey) table.push(`api_key = ${tomlString(apiKey)}`);
  // The opencode.ai gateway rate-limits anonymous traffic separately from the
  // official opencode client (verified 429 without the UA). grok sends its own
  // UA, so pin the opencode client's one via extra_headers (see gateway.ts).
  const gatewayHeaders = gatewayHeadersFor(provider.baseUrl);
  if (gatewayHeaders) table.push(`extra_headers = ${tomlInlineTable(gatewayHeaders)}`);
  return table;
}

export class GrokAdapter extends BaseAdapter {
  readonly id = "grok";
  readonly name = "Grok Build";
  readonly supportedTypes: ProviderType[] = ["openai", "anthropic"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.grok;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(GROK_DIR);
    let toml = "";
    if (await fs.pathExists(GROK_CONFIG_PATH)) {
      toml = await fs.readFile(GROK_CONFIG_PATH, "utf-8");
    }
    // Multi-site mode: only rewrite THIS provider's model tables so other
    // enabled sites and grok's own settings stay intact.
    toml = stripMatchingTables(toml, [modelTablePattern(provider.id)]);

    const modelIds = new Set<string>();
    for (const m of provider.models || []) modelIds.add(m.id);
    modelIds.add(modelId);

    for (const id of modelIds) {
      toml = upsertTomlTable(toml, `model.${getModelAlias(provider.id, id)}`, buildModelTable(provider, apiKey, id));
    }
    toml = upsertTableKey(toml, "models", "default", tomlString(getModelAlias(provider.id, modelId)));

    await atomicWrite(GROK_CONFIG_PATH, normalizeToml(toml));
    await updateUserConfig({
      providers: { grok: { providerId: provider.id, modelId } },
    } as any);
  }

  // Additive (multi-site): write one site's model tables without touching
  // any other site or the active default.
  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };

    await fs.ensureDir(GROK_DIR);
    let toml = "";
    if (await fs.pathExists(GROK_CONFIG_PATH)) {
      toml = await fs.readFile(GROK_CONFIG_PATH, "utf-8");
    }

    const written: string[] = [];
    const apiKeys = new Map<string, string>();
    for (const { provider, modelId } of entries) {
      if (!apiKeys.has(provider.id)) {
        apiKeys.set(provider.id, (await this.resolveApiKey(provider)) || "");
      }
      toml = upsertTomlTable(
        toml,
        `model.${getModelAlias(provider.id, modelId)}`,
        buildModelTable(provider, apiKeys.get(provider.id) || undefined, modelId),
      );
      written.push(modelId);
    }

    await atomicWrite(GROK_CONFIG_PATH, normalizeToml(toml));
    return { written, skipped: [] };
  }

  // Which OKIT provider ids currently have a model table in grok's config.
  // Alias->provider is ambiguous (ids may shadow each other), so match the
  // longest known provider id first.
  async listEnabledProviders(): Promise<string[]> {
    if (!(await fs.pathExists(GROK_CONFIG_PATH))) return [];
    const toml = await fs.readFile(GROK_CONFIG_PATH, "utf-8");
    const providers = await loadProviders();
    const ids = [...new Map(providers.map(p => [p.id, p])).keys()].sort((a, b) => b.length - a.length);
    const found = new Set<string>();
    for (const line of toml.split("\n")) {
      const m = line.match(/^\s*\[model\.([a-zA-Z0-9_-]+)\]\s*(?:#.*)?$/);
      if (!m) continue;
      for (const pid of ids) {
        if (m[1].startsWith(`okit-${sanitizeTomlKey(pid)}-`)) {
          found.add(pid);
          break;
        }
      }
    }
    return [...found];
  }

  // Remove one site: its model tables, and the active default if it pointed
  // at one of them.
  async removeProvider(providerId: string): Promise<void> {
    if (!(await fs.pathExists(GROK_CONFIG_PATH))) return;
    const toml = await fs.readFile(GROK_CONFIG_PATH, "utf-8");
    const stripped = stripMatchingTables(toml, [modelTablePattern(providerId)]);
    if (stripped === toml) return;

    let out = stripped;
    const defaultModel = getTableKeyValue(out, "models", "default");
    if (typeof defaultModel === "string" && defaultModel.startsWith(`${getModelAlias(providerId, "")}`)) {
      out = removeTableKey(out, "models", "default");
    }
    await atomicWrite(GROK_CONFIG_PATH, out);
  }
}