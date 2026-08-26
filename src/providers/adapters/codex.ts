import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor, modelLimitFor } from "./gateway";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { checkCodexOAuth } from "../auth";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";
import {
  codexMapping,
  getCodexConfigReasoningEffort,
  mapModelToCodexCatalog,
} from "../mappings/codex-mapping";
import { appendLog } from "../../web/api/log-writer";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const CODEX_AUTH_PATH = path.join(CODEX_DIR, "auth.json");
const OKIT_AUTH_HELPER_DIR = path.join(CODEX_DIR, ".okit-auth");

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
    const state = config.agentProviders?.codex;
    if (state?.activeProviderId && state?.activeModelId) {
      return { providerId: state.activeProviderId, modelId: state.activeModelId };
    }
    return null;
  }

  async applyConfig(provider: Provider, modelId: string, resolvedModel?: ResolvedModel): Promise<void> {
    modelId = resolvedModel?.id || modelId;
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
      toml = removeTopLevelTomlKey(toml, "model_context_window");
      toml = removeTopLevelTomlKey(toml, "model_supports_reasoning_summaries");
      toml = removeTopLevelTomlKey(toml, "api_base");
      // model_reasoning_effort is harmless for official too — keep it so
      // reasoning models behave the same across subscription and API modes.
      // toml = upsertTopLevelTomlKey(toml, "model_reasoning_effort", tomlString("high"));
      // Purge every [model_providers.okit-*] table we may have written.
      toml = removeAllOkitProviderTables(toml);
      // auth.json belongs to Codex itself (OAuth and user-managed OpenAI
      // credentials).  OKIT never writes third-party keys there anymore.
      await fs.remove(OKIT_AUTH_HELPER_DIR);
      await atomicWrite(CODEX_CONFIG_PATH, toml);
    } else {
      const providerId = getCodexProviderId(provider);
      const openAIEndpoint = getProviderEndpoint(provider, "openai");

      toml = upsertTopLevelTomlKey(toml, "model", tomlString(modelId));
      toml = upsertTopLevelTomlKey(toml, "model_provider", tomlString(providerId));
      // Third-party gateways need these: response storage isn't implemented,
      // web_search_preview tool gets rejected, reasoning effort applies.
      const reasoningEffort = getCodexConfigReasoningEffort(resolvedModel);
      toml = reasoningEffort
        ? upsertTopLevelTomlKey(toml, "model_reasoning_effort", tomlString(reasoningEffort))
        : removeTopLevelTomlKey(toml, "model_reasoning_effort");
      toml = resolvedModel?.context
        ? upsertTopLevelTomlKey(toml, "model_context_window", String(resolvedModel.context))
        : removeTopLevelTomlKey(toml, "model_context_window");
      toml = resolvedModel?.reasoning === undefined
        ? removeTopLevelTomlKey(toml, "model_supports_reasoning_summaries")
        : upsertTopLevelTomlKey(toml, "model_supports_reasoning_summaries", String(resolvedModel.reasoning));
      toml = upsertTopLevelTomlKey(toml, "disable_response_storage", String(codexMapping.thirdPartyDefaults.disableResponseStorage));
      toml = upsertTopLevelTomlKey(toml, "web_search", tomlString(codexMapping.thirdPartyDefaults.webSearch));
      toml = removeTopLevelTomlKey(toml, "api_base");

      // Codex dropped support for wire_api = "chat" — "responses" is required.
      // Third-party credentials must be scoped to this provider.  In
      // particular, requires_openai_auth makes Codex send the logged-in
      // ChatGPT OAuth token to the gateway, which is both incorrect and a
      // frequent source of 401s.  The documented provider auth.command form
      // avoids that cross-provider credential leak.
      //
      // http_headers: the opencode.ai gateway rate-limits anonymous traffic
      // separately from the official opencode client (verified 429 without the
      // UA). Codex sends its own UA, so we pin the opencode client's one.
      const providerLines = [
        `name = ${tomlString(provider.name)}`,
        `base_url = ${tomlString(normalizeBaseUrl(openAIEndpoint.baseUrl))}`,
        `wire_api = ${tomlString(codexMapping.thirdPartyDefaults.wireApi)}`,
      ];
      const gatewayHeaders = gatewayHeadersFor(openAIEndpoint.baseUrl);
      if (gatewayHeaders) {
        providerLines.push(`http_headers = ${tomlInlineTable(gatewayHeaders)}`);
      }
      const providerTable = `model_providers.${providerId}`;
      toml = removeLegacyProviderAuthTables(toml, providerTable);
      toml = upsertTomlTable(toml, providerTable, providerLines);

      if (apiKey) {
        const helperPath = providerAuthHelperPath(providerId);
        await writeProviderAuthHelper(helperPath, apiKey);
        toml = upsertTomlTable(toml, `${providerTable}.auth`, [
          `command = ${tomlString(helperPath)}`,
        ]);
        // Remove only the stale value OKIT used to own.  Never remove a
        // different user-managed OPENAI_API_KEY or OAuth session.
        await removeManagedApiKeyFromAuthJson(CODEX_AUTH_PATH, apiKey);
      }
      await atomicWrite(CODEX_CONFIG_PATH, toml);

      // Generate model-catalogs.json so the user can switch between this
      // provider's models via `/model` inside Codex CLI.
      await writeModelCatalog(provider);
    }

    await updateUserConfig({
      agentProviders: {
        codex: {
          activeProviderId: provider.id,
          activeModelId: modelId,
          sites: {
            [provider.id]: { modelIds: [...new Set([...(provider.models || []).map(item => item.id), modelId])] },
          },
        },
      },
    });
  }

  // A custom site is only physically removed on an explicit delete. Merely
  // switching to the official subscription leaves its recoverable catalog on
  // disk, while deletion must leave no model/provider residue behind.
  async removeProvider(providerId: string): Promise<void> {
    if (!(await fs.pathExists(CODEX_CONFIG_PATH))) {
      await fs.remove(MODEL_CATALOG_PATH);
      return;
    }
    let toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
    const providerKey = `okit-${sanitizeTomlKey(providerId)}`;
    toml = removeProviderTableFamily(toml, `model_providers.${providerKey}`);
    await fs.remove(providerAuthHelperPath(providerKey));
    if (!/\[model_providers\.okit-[^\]]+\]/.test(toml)) {
      toml = removeTopLevelTomlKey(toml, "model_catalog_json");
      await fs.remove(MODEL_CATALOG_PATH);
    }
    await atomicWrite(CODEX_CONFIG_PATH, toml);
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
  // The Codex catalog mirrors this Agent site's selected models. The global
  // provider directory must never decide what appears in /model.
  const userConfig = await loadUserConfig();
  const visibleIds = new Set<string>(
    userConfig.agentProviders?.codex?.sites?.[provider.id]?.modelIds || (provider.models || []).map(m => m.id),
  );

  // Build the catalog from the visible models. Each entry carries the fields
  // Codex requires; unknown capabilities default to safe values. Gateway
  // models (opencode.ai / openrouter.ai free tiers) get their real context
  // window from gateway.ts so Codex doesn't overshoot.
  const included = provider.models.filter(m => visibleIds.has(m.id));
  const entries = included.map((m, i) => {
    const limit = modelLimitFor(provider.baseUrl, m.id);
    const modelFacts = m.resolved || {
      id: m.id,
      name: m.name || m.id,
      ...(m.meta?.description ? { description: m.meta.description } : {}),
      ...(m.meta?.context ? { context: m.meta.context } : {}),
      modalities: {
        input: m.meta?.modalities?.input || (m.meta?.attachment ? ["text", "image"] : ["text"]),
        output: m.meta?.modalities?.output || ["text"],
      },
      ...(m.meta?.reasoning === undefined ? {} : { reasoning: m.meta.reasoning }),
      ...(m.meta?.reasoningOptions ? { reasoningOptions: m.meta.reasoningOptions } : {}),
    };
    return mapModelToCodexCatalog({
      model: modelFacts,
      providerName: provider.name,
      priority: i,
      contextOverride: limit?.context,
    });
  });

  await fs.ensureDir(MODEL_CATALOG_DIR);
  await atomicWriteJSON(MODEL_CATALOG_PATH, { models: entries });

  // Add the catalog pointer to config.toml (idempotent upsert).
  let toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
  toml = upsertTopLevelTomlKey(toml, "model_catalog_json", tomlString(MODEL_CATALOG_REF));
  await atomicWrite(CODEX_CONFIG_PATH, toml);

  // Persist a safe, inspectable mapping trace. Never include credentials,
  // auth commands or raw provider responses in this diagnostic event.
  appendLog("codex-model-mapping", provider.id, true, {
    mappingVersion: codexMapping.schemaVersion,
    providerId: provider.id,
    modelCount: entries.length,
    models: entries.map((entry: any) => ({
      id: entry.slug,
      contextWindow: entry.context_window,
      maxContextWindow: entry.max_context_window,
      inputModalities: entry.input_modalities,
      defaultReasoning: entry.default_reasoning_level,
      reasoningLevels: (entry.supported_reasoning_levels || []).map((level: any) => level.effort),
      reasoningSummaries: entry.supports_reasoning_summary_parameter,
      verbosity: entry.support_verbosity,
      parallelToolCalls: entry.supports_parallel_tool_calls,
      searchTool: entry.supports_search_tool,
    })),
  });
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

/** Remove only an old key that this provider's previous OKIT write owned. */
async function removeManagedApiKeyFromAuthJson(authPath: string, apiKey: string): Promise<void> {
  if (!(await fs.pathExists(authPath))) return;
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(await fs.readFile(authPath, "utf-8"));
  } catch {
    return; // corrupt — leave it alone
  }
  if (auth["OPENAI_API_KEY"] === apiKey) {
    delete auth["OPENAI_API_KEY"];
    await atomicWriteJSON(authPath, auth);
  }
}

function providerAuthHelperPath(providerId: string): string {
  return path.join(OKIT_AUTH_HELPER_DIR, `${sanitizeTomlKey(providerId)}.sh`);
}

async function writeProviderAuthHelper(helperPath: string, apiKey: string): Promise<void> {
  await fs.ensureDir(path.dirname(helperPath));
  await atomicWrite(helperPath, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(apiKey)}\n`, { mode: 0o700 });
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

/** Remove a provider and all its nested tables (for example .auth). */
function removeProviderTableFamily(toml: string, tableName: string): string {
  const lines = toml.split("\n");
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) skipping = headerMatch[1] === tableName || headerMatch[1].startsWith(`${tableName}.`);
    if (!skipping) result.push(line);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Strip only obsolete auth subtables before adding the canonical one. */
function removeLegacyProviderAuthTables(toml: string, tableName: string): string {
  const lines = toml.split("\n");
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      const name = headerMatch[1];
      skipping = name === `${tableName}.auth` || (name.startsWith(`${tableName}.`) && /auth/i.test(name));
    }
    if (!skipping) result.push(line);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
