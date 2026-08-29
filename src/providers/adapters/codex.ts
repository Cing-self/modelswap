import fs from "fs-extra";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { BaseAdapter } from "./base";
import { gatewayHeadersFor } from "./gateway";
import { modelFacts } from "./model-facts";
import { AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { loadUserConfig } from "../../config/user";
import { checkCodexOAuth } from "../auth";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";
import {
  codexEndpointSupport,
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
  readonly supportedTypes: ProviderType[] = ["openai", "responses"];

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
      const openAIEndpoint = getProviderEndpoint(provider, "responses", "openai");

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
      const auth = provider.vaultKey ? await resolveVaultAuthCommand(provider.vaultKey) : null;
      if (auth?.key && responsesEndpointProbe) {
        const probeUrl = `${normalizeBaseUrl(codexResponsesBaseUrl(openAIEndpoint.baseUrl)).replace(/\/+$/, "")}/responses`;
        const status = await responsesEndpointProbe(probeUrl, auth.key, provider.models?.[0]?.id);
        if (status === 404) {
          throw new Error(`${provider.name} 无法配置给 Codex：其 OpenAI 端点不支持 Codex 要求的 Responses 协议（${probeUrl} 返回 404）。该站点可继续用于 Claude 等支持 Chat 协议的 Agent。`);
        }
      }
      const providerLines = [
        `name = ${tomlString(provider.name)}`,
        `base_url = ${tomlString(normalizeBaseUrl(codexResponsesBaseUrl(openAIEndpoint.baseUrl)))}`,
        `wire_api = ${tomlString(codexMapping.thirdPartyDefaults.wireApi)}`,
      ];
      const gatewayHeaders = gatewayHeadersFor(openAIEndpoint.baseUrl);
      if (gatewayHeaders) {
        providerLines.push(`http_headers = ${tomlInlineTable(gatewayHeaders)}`);
      }
      const providerTable = `model_providers.${providerId}`;
      toml = removeLegacyProviderAuthTables(toml, providerTable);
      toml = upsertTomlTable(toml, providerTable, providerLines);

      if (provider.vaultKey && auth) {
        toml = upsertTomlTable(toml, `${providerTable}.auth`, [
          `command = ${tomlString(auth.command)}`,
          `args = ${tomlStringArray(auth.args)}`,
        ]);
      } else {
        toml = removeTomlTable(toml, `${providerTable}.auth`);
      }
      toml = removeStaleModelsTable(toml);
      await atomicWrite(CODEX_CONFIG_PATH, toml);

      // Generate model-catalogs.json so the user can switch between this
      // provider's models via `/model` inside Codex CLI.
      await writeModelCatalog(provider);
    }

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
    toml = removeStaleModelsTable(toml);
    await atomicWrite(CODEX_CONFIG_PATH, toml);
  }
}

// The ChatGPT desktop app persists its own picker preference under [models]
// (`default` + `default_reasoning_effort`). When the referenced okit
// provider's site has been removed, the stale default keeps pointing at a
// dead provider table. Drop the table only for okit references that no
// longer resolve; anything else (including app-owned non-okit values) stays
// untouched so we never fight the app's own preference.
export function removeStaleModelsTable(toml: string): string {
  const match = toml.match(/\[models\]\s*\n[^[]*?default\s*=\s*"([^"]+)"/);
  if (!match) return toml;
  const referenced = match[1];
  if (!referenced.startsWith("okit-")) return toml;
  const escaped = referenced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\[model_providers\\.${escaped}\\]`).test(toml)) return toml;
  return removeTomlTable(toml, "models");
}

function getProviderEndpoint(provider: Provider, ...types: ProviderType[]) {
  const endpoints = provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }];
  for (const type of types) {
    const endpoint = endpoints.find(ep => ep.type === type);
    if (endpoint?.baseUrl) return endpoint;
  }
  throw new Error(`${provider.name} 缺少 ${types.join("/")} endpoint`);
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

// Verified OpenAI-Responses endpoints for coding plans whose
// OpenAI-compatible URL only serves chat completions. Codex requires the
// Responses wire API; pointing it at the chat URL 404s on every request.
function codexResponsesBaseUrl(baseUrl: string): string {
  return codexEndpointSupport(baseUrl).responsesBaseUrl ?? baseUrl;
}

type VaultCommand = { command: string; args: string[] };

// A packaged desktop build can be older than this adapter and ship a bundled
// CLI that predates `vault get`; it then prints the help screen instead of the
// key and Codex signs requests with no Authorization header at all. Probe each
// candidate once and fall back; only a bare single-line key is acceptable.
export function vaultKeyLooksReal(stdout: string): boolean {
  const text = stdout.trim();
  return text.length >= 20 && !text.includes("\n") && !/[█║╚╝═│]/.test(text) && !/^usage/i.test(text);
}

function liveVaultKeyProbe(candidate: VaultCommand): string | null {
  try {
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf-8", timeout: 15000 });
    if (result.status !== 0) return null;
    const stdout = String(result.stdout || "").trim();
    return vaultKeyLooksReal(stdout) ? stdout : null;
  } catch {
    return null;
  }
}

type VaultKeyProbe = (candidate: VaultCommand) => string | null;
let vaultKeyProbe: VaultKeyProbe = liveVaultKeyProbe;

/** Test seam: replace the live vault command probe. */
export function setVaultProbeForTests(probe: VaultKeyProbe | null): void {
  vaultKeyProbe = probe ?? liveVaultKeyProbe;
}

export function pickVaultCommand(candidates: VaultCommand[]): { command: VaultCommand; key: string | null } {
  for (const candidate of candidates) {
    const key = vaultKeyProbe(candidate);
    if (key) return { command: candidate, key };
  }
  return { command: candidates[0], key: null };
}

async function resolveVaultAuthCommand(vaultKey: string): Promise<VaultCommand & { key: string | null }> {
  const primary = codexVaultAuthCommand(vaultKey);
  // Probing spawns the CLI once per apply; only the desktop (Electron) path
  // needs that (fallback candidates + /responses endpoint gate). Plain CLI
  // builds always execute the entry point they ship with, so the primary is
  // returned as-is to keep applies fast.
  const probing = process.versions.electron || vaultKeyProbe !== liveVaultKeyProbe;
  if (!probing) return { ...primary, key: null };
  const candidates: VaultCommand[] = [primary];
  if (process.platform === "win32") {
    candidates.push({ command: "cmd.exe", args: ["/d", "/s", "/c", `okit vault get "${vaultKey}"`] });
  } else {
    candidates.push({ command: "okit", args: ["vault", "get", vaultKey] });
  }
  const chosen = pickVaultCommand(candidates);
  if (!chosen.key) {
    appendLog("codex-vault-auth-probe", vaultKey, false, "no vault command produced a bare key; Codex will start without Authorization until the packaged CLI or the okit binary understands `vault get`");
  }
  return { ...chosen.command, key: chosen.key };
}

// Live probe of the OpenAI-Responses endpoint with the resolved credential.
// Returns the HTTP status, or null when the probe could not run (offline etc.)
// — apply proceeds and Codex surfaces whatever the real request yields.
async function liveResponsesEndpointProbe(baseUrl: string, apiKey: string, model?: string): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || "test", input: "hi", max_output_tokens: 8 }),
      signal: AbortSignal.timeout(10000),
    });
    return response.status;
  } catch {
    return null;
  }
}

type ResponsesEndpointProbe = (baseUrl: string, apiKey: string, model?: string) => Promise<number | null>;
let responsesEndpointProbe: ResponsesEndpointProbe | null = null;

/** Test seam: replace the live /responses endpoint probe. */
export function setResponsesEndpointProbeForTests(probe: ResponsesEndpointProbe | null): void {
  responsesEndpointProbe = probe;
}

function activeResponsesEndpointProbe(): ResponsesEndpointProbe | null {
  if (responsesEndpointProbe) return responsesEndpointProbe;
  // The dashboard (Electron) is the flow where a clear refusal matters; CLI
  // and CI runs skip the live probe entirely.
  return process.versions.electron ? liveResponsesEndpointProbe : null;
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
