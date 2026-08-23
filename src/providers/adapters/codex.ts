import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { checkCodexOAuth } from "../auth";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_AUTH_PATH = path.join(CODEX_DIR, "auth.json");

export class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly name = "ChatGPT";
  readonly supportedTypes: ProviderType[] = ["openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    const oauthLoggedIn = await checkCodexOAuth();
    return { mode: "both", hasApiKey: false, oauthLoggedIn };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.codex;
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(CODEX_DIR);
    let toml = "";
    if (await fs.pathExists(CODEX_CONFIG_PATH)) {
      toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
    }

    // Official OpenAI subscription = OAuth mode. Mirror cc-switch's "OpenAI
    // Official" preset which writes an EMPTY config + EMPTY auth: Codex falls
    // back to its native OAuth login + default model catalog. We must strip
    // all third-party residue (model_provider, [model_providers.okit-*],
    // disable_response_storage, web_search, model_catalog_json, OPENAI_API_KEY)
    // so the ChatGPT desktop app uses the subscription, not a stale API key.
    const isOfficial = provider.id === "openai-codex" || provider.id === "openai";

    if (isOfficial) {
      // Set model, strip everything else that only applies to third-party.
      toml = upsertTopLevelTomlKey(toml, "model", tomlString(modelId));
      toml = removeTopLevelTomlKey(toml, "model_provider");
      toml = removeTopLevelTomlKey(toml, "disable_response_storage");
      toml = removeTopLevelTomlKey(toml, "web_search");
      toml = removeTopLevelTomlKey(toml, "model_catalog_json");
      toml = removeTopLevelTomlKey(toml, "api_base");
      // model_reasoning_effort is harmless for official too — keep it so
      // reasoning models behave the same across subscription and API modes.
      // toml = upsertTopLevelTomlKey(toml, "model_reasoning_effort", tomlString("high"));
      // Purge every [model_providers.okit-*] table we may have written.
      toml = removeAllOkitProviderTables(toml);
      // Remove OPENAI_API_KEY from auth.json but PRESERVE OAuth tokens so
      // the subscription stays logged in.
      await removeApiKeyFromAuthJson(CODEX_AUTH_PATH);
      await atomicWrite(CODEX_CONFIG_PATH, toml);
    } else {
      const providerId = getCodexProviderId(provider);
      const openAIEndpoint = getProviderEndpoint(provider, "openai");

      toml = upsertTopLevelTomlKey(toml, "model", tomlString(modelId));
      toml = upsertTopLevelTomlKey(toml, "model_provider", tomlString(providerId));
      // Third-party gateways need these: response storage isn't implemented,
      // web_search_preview tool gets rejected, reasoning effort applies.
      toml = upsertTopLevelTomlKey(toml, "model_reasoning_effort", tomlString("high"));
      toml = upsertTopLevelTomlKey(toml, "disable_response_storage", "true");
      toml = upsertTopLevelTomlKey(toml, "web_search", tomlString("disabled"));
      toml = removeTopLevelTomlKey(toml, "api_base");

      // Codex dropped support for wire_api = "chat" — "responses" is required.
      // requires_openai_auth tells Codex to pull the credential from auth.json's
      // OPENAI_API_KEY. base_url normalization: append /v1 for origin-only URLs.
      //
      // Credential delivery via auth.json (not .env) is critical: the ChatGPT
      // desktop app reads auth.json, NOT .env. cc-switch does the same.
      //
      // http_headers: the opencode.ai gateway rate-limits anonymous traffic
      // separately from the official opencode client (verified 429 without the
      // UA). Codex sends its own UA, so we pin the opencode client's one.
      const providerLines = [
        `name = ${tomlString(provider.name)}`,
        `base_url = ${tomlString(normalizeBaseUrl(openAIEndpoint.baseUrl))}`,
        `wire_api = "responses"`,
        `requires_openai_auth = true`,
      ];
      const gatewayHeaders = gatewayHeadersFor(openAIEndpoint.baseUrl);
      if (gatewayHeaders) {
        providerLines.push(`http_headers = ${tomlInlineTable(gatewayHeaders)}`);
      }
      toml = upsertTomlTable(toml, `model_providers.${providerId}`, providerLines);

      if (apiKey) await upsertAuthJson(CODEX_AUTH_PATH, apiKey);
      await atomicWrite(CODEX_CONFIG_PATH, toml);

      // Generate model-catalogs.json so the user can switch between this
      // provider's models via `/model` inside Codex CLI.
      await writeModelCatalog(provider);
    }

    await updateUserConfig({
      providers: { codex: { providerId: provider.id, modelId } },
    } as any);
  }
}

function getProviderEndpoint(provider: Provider, type: ProviderType) {
  const endpoints = provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }];
  const endpoint = endpoints.find(ep => ep.type === type);
  if (!endpoint?.baseUrl) throw new Error(`${provider.name} 缺少 ${type} endpoint`);
  return endpoint;
}

const MODEL_CATALOG_DIR = path.join(CODEX_DIR, "model-catalogs");
const MODEL_CATALOG_PATH = path.join(MODEL_CATALOG_DIR, "model-catalogs.json");
const MODEL_CATALOG_REF = "~/.codex/model-catalogs/model-catalogs.json";

// Write ~/.codex/model-catalogs/model-catalogs.json with one entry per model on
// the active provider, then add `model_catalog_json` to config.toml so Codex
// loads it. This lets the user run `/model` inside Codex CLI to switch models
// without returning to OKIT. Schema follows Xiaomi MiMo's documented format
// (https://mimo.mi.com/docs/zh-CN/tokenplan/integration/codex-configuration),
// which is Codex's native model-catalog shape.
async function writeModelCatalog(provider: Provider): Promise<void> {
  // Read the user's visible-models list for this provider (models ADDED on
  // the card — inclusion model). Pre-migration configs fall back to the
  // legacy exclusion computation so the catalog stays correct either way.
  const userConfig = await loadUserConfig() as any;
  const visibleIds = userConfig.codexCatalogVisibleMigrated && userConfig.codexCatalogVisible
    ? new Set<string>(userConfig.codexCatalogVisible[provider.id] || [])
    : new Set<string>(
        (provider.models || [])
          .map(m => m.id)
          .filter(id => !(userConfig.codexCatalogExcluded?.[provider.id] || []).includes(id)),
      );

  // Build the catalog from the visible models. Each entry carries the fields
  // Codex requires; unknown capabilities default to safe values. Gateway
  // models (opencode.ai / openrouter.ai free tiers) get their real context
  // window from gateway.ts so Codex doesn't overshoot.
  const included = provider.models.filter(m => visibleIds.has(m.id));
  const entries = included.map((m, i) => {
    const limit = modelLimitFor(provider.baseUrl, m.id);
    const contextWindow = limit?.context ?? 128000;
    return {
      slug: m.id,
      display_name: m.name || m.id,
      description: `${provider.name} · ${m.name || m.id}`,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "none", description: "Disable Thinking" },
        { effort: "high", description: "Enabled Thinking" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: i,
      base_instructions: "",
      supports_reasoning_summaries: true,
      default_reasoning_summary: "none",
      support_verbosity: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: 95,
      // Third-party coding endpoints generally don't support the web_search tool
      // (it triggers "tool type not supported by this gateway"), so opt out.
      experimental_supported_tools: [] as string[],
      input_modalities: ["text"],
      supports_search_tool: false,
    };
  });

  await fs.ensureDir(MODEL_CATALOG_DIR);
  await atomicWriteJSON(MODEL_CATALOG_PATH, { models: entries });

  // Add the catalog pointer to config.toml (idempotent upsert).
  let toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
  toml = upsertTopLevelTomlKey(toml, "model_catalog_json", tomlString(MODEL_CATALOG_REF));
  await atomicWrite(CODEX_CONFIG_PATH, toml);
}

// Append /v1 for origin-only base URLs (no path after host), preserve URLs that
// already have a path or end in /v1. Mirrors cc-switch's to_codex provider.
function normalizeBaseUrl(url: string): string {
  if (!url) return url;
  if (/\/v\d+\/?$/.test(url)) return url;          // already ends with /v1, /v2…
  try {
    const parsed = new URL(url);
    // origin-only = no path (or just "/")
    if (!parsed.pathname || parsed.pathname === "/") {
      return url.replace(/\/?$/, "") + "/v1";
    }
  } catch { /* not a URL — return as-is */ }
  return url;
}

function getCodexProviderId(provider: Provider): string {
  return provider.id === "openai" ? "openai" : `okit-${sanitizeTomlKey(provider.id)}`;
}

function sanitizeTomlKey(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function upsertTopLevelTomlKey(toml: string, key: string, value: string): string {
  const lines = toml.split("\n");
  let tableStart = lines.findIndex(line => line.trim().startsWith("["));
  if (tableStart === -1) tableStart = lines.length;

  for (let i = 0; i < tableStart; i++) {
    if (new RegExp(`^\\s*${escapeRegex(key)}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }

  lines.splice(tableStart, 0, `${key} = ${value}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function removeTopLevelTomlKey(toml: string, key: string): string {
  const lines = toml.split("\n");
  let tableStart = lines.findIndex(line => line.trim().startsWith("["));
  if (tableStart === -1) tableStart = lines.length;
  return [
    ...lines.slice(0, tableStart).filter(line => !new RegExp(`^\\s*${escapeRegex(key)}\\s*=`).test(line)),
    ...lines.slice(tableStart),
  ].join("\n");
}

function upsertTomlTable(toml: string, tableName: string, lines: string[]): string {
  const header = `[${tableName}]`;
  const tableLines = [header, ...lines];
  const sourceLines = toml.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const tableStart = sourceLines.findIndex(line => headerRegex.test(line));

  if (tableStart >= 0) {
    let tableEnd = tableStart + 1;
    while (tableEnd < sourceLines.length && !/^\s*\[/.test(sourceLines[tableEnd])) {
      tableEnd++;
    }

    const before = sourceLines.slice(0, tableStart);
    const after = sourceLines.slice(tableEnd);
    while (before.length && before[before.length - 1].trim() === "") before.pop();
    while (after.length && after[0].trim() === "") after.shift();

    return [
      ...before,
      ...(before.length ? [""] : []),
      ...tableLines,
      ...(after.length ? ["", ...after] : [""]),
    ].join("\n");
  }

  return `${toml.trimEnd()}\n\n${tableLines.join("\n")}\n`;
}

function tomlString(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlInlineTable(headers: Record<string, string>): string {
  const pairs = Object.entries(headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Write OPENAI_API_KEY into ~/.codex/auth.json. Codex CLI and the ChatGPT
// desktop app both read credentials from here when requires_openai_auth=true.
// Preserve any existing keys (e.g. OAuth tokens) the user may have set up.
async function upsertAuthJson(authPath: string, apiKey: string): Promise<void> {
  let auth: Record<string, unknown> = {};
  if (await fs.pathExists(authPath)) {
    try {
      auth = JSON.parse(await fs.readFile(authPath, "utf-8"));
    } catch {
      // Corrupt auth.json — start fresh with just the key.
      auth = {};
    }
  }
  auth["OPENAI_API_KEY"] = apiKey;
  await atomicWriteJSON(authPath, auth);
}

// Remove OPENAI_API_KEY from auth.json, preserving OAuth tokens and any other
// fields. Called when switching back to the official OpenAI subscription so
// Codex falls back to OAuth instead of a stale third-party key.
async function removeApiKeyFromAuthJson(authPath: string): Promise<void> {
  if (!(await fs.pathExists(authPath))) return;
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(await fs.readFile(authPath, "utf-8"));
  } catch {
    return; // corrupt — leave it alone
  }
  if ("OPENAI_API_KEY" in auth) {
    delete auth["OPENAI_API_KEY"];
    await atomicWriteJSON(authPath, auth);
  }
}

// Remove every [model_providers.okit-*] table from the TOML. OKIT-prefixed
// provider ids are our namespace; anything else (e.g. user-defined or Azure)
// is left untouched. Each table spans from its [header] to the next [header]
// or EOF.
function removeAllOkitProviderTables(toml: string): string {
  const lines = toml.split("\n");
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      const tableName = headerMatch[1];
      skipping = tableName.startsWith("model_providers.okit");
    }
    if (!skipping) result.push(line);
  }
  // Trim trailing blank lines left by removed tables.
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
