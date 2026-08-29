import fs from "fs-extra";
import path from "path";
import os from "os";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor } from "./gateway";
import { modelFacts } from "./model-facts";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig, patchAgentSelection } from "../../config/user";
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
    // The routed second parameter is the endpoint's request ID. ResolvedModel
    // keeps canonical metadata and must not replace it.
    await fs.ensureDir(CODEX_DIR);
    let toml = "";
    if (await fs.pathExists(CODEX_CONFIG_PATH)) {
      toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
    }

    // Official OpenAI subscription = OAuth mode. Only clear the ACTIVE
    // third-party selection. Keep every [model_providers.okit-*] registration:
    // existing Codex conversations persist their provider id, and deleting the
    // table makes those conversations impossible to reopen ("provider not
    // found"). A registration is removed only when the user removes that site.
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
      // Remove the legacy shared API key from auth.json but preserve OAuth
      // tokens. Third-party providers now use their own Vault-backed auth
      // command, so switching providers never overwrites another site's key.
      await removeApiKeyFromAuthJson(CODEX_AUTH_PATH);
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
      // base_url normalization appends /v1 for origin-only URLs. Authentication
      // is a provider-specific command below, backed by OKIT's encrypted Vault;
      // this keeps multiple providers resumable without writing keys to TOML.
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

      if (provider.vaultKey) {
        const auth = codexVaultAuthCommand(provider.vaultKey);
        toml = upsertTomlTable(toml, `${providerTable}.auth`, [
          `command = ${tomlString(auth.command)}`,
          `args = ${tomlStringArray(auth.args)}`,
        ]);
      } else {
        toml = removeTomlTable(toml, `${providerTable}.auth`);
      }
      await atomicWrite(CODEX_CONFIG_PATH, toml);

      // Generate model-catalogs.json so the user can switch between this
      // provider's models via `/model` inside Codex CLI.
      await writeModelCatalog(provider);
    }

    await patchAgentSelection("codex", {
          activeProviderId: provider.id,
          activeModelId: modelId,
          sites: {
            [provider.id]: { modelIds: [...new Set([...(provider.models || []).map(item => item.id), modelId])] },
          },
    });
  }

  async removeProvider(providerId: string): Promise<void> {
    if (!(await fs.pathExists(CODEX_CONFIG_PATH))) return;
    const codexProviderId = providerId.startsWith("okit-")
      ? providerId
      : getCodexProviderId({ id: providerId } as Provider);
    let toml = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
    toml = removeTomlTable(toml, `model_providers.${codexProviderId}.auth`);
    toml = removeTomlTable(toml, `model_providers.${codexProviderId}`);
    const removedWasActive = readTopLevelTomlKey(toml, "model_provider") === codexProviderId;
    const hasOtherOkitProviders = /\[model_providers\.okit-[^\]]+\]/.test(toml);
    if (removedWasActive || !hasOtherOkitProviders) {
      toml = removeTopLevelTomlKey(toml, "model_provider");
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
  // window from the shared resolved model facts so Codex doesn't overshoot.
  const included = provider.models.filter(m => visibleIds.has(m.id));
  const entries = included.map((m, i) => {
    const resolvedFacts = modelFacts(provider, m);
    return mapModelToCodexCatalog({
      model: resolvedFacts,
      providerName: provider.name,
      priority: i,
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

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(headers: Record<string, string>): string {
  const pairs = Object.entries(headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTopLevelTomlKey(toml: string, key: string): string | undefined {
  const lines = toml.split("\n");
  const tableStart = lines.findIndex(line => line.trim().startsWith("["));
  const top = lines.slice(0, tableStart === -1 ? lines.length : tableStart);
  const match = top.find(line => new RegExp(`^\\s*${escapeRegex(key)}\\s*=`).test(line));
  return match?.match(/=\s*"([^"]+)"/)?.[1];
}

function removeTomlTable(toml: string, tableName: string): string {
  const lines = toml.split("\n");
  const header = new RegExp(`^\\s*\\[${escapeRegex(tableName)}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) return toml;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function codexVaultAuthCommand(vaultKey: string): { command: string; args: string[] } {
  // The adapter runs from dist/providers/adapters in both CLI and desktop
  // builds, so dist/main.js is a stable entry point for the existing raw
  // `okit vault get` command. Packaged Electron can execute that entry point
  // as Node when ELECTRON_RUN_AS_NODE is set through `env`.
  const cliEntry = path.join(__dirname, "..", "..", "main.js");
  if (process.versions.electron && process.platform !== "win32") {
    return {
      command: "/usr/bin/env",
      args: ["ELECTRON_RUN_AS_NODE=1", process.execPath, cliEntry, "vault", "get", vaultKey],
    };
  }
  if (process.versions.electron && process.platform === "win32") {
    const invocation = `set ELECTRON_RUN_AS_NODE=1&&"${process.execPath}" "${cliEntry}" vault get "${vaultKey}"`;
    return { command: "cmd.exe", args: ["/d", "/s", "/c", invocation] };
  }
  return { command: process.execPath, args: [cliEntry, "vault", "get", vaultKey] };
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
