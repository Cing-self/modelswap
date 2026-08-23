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
import { tomlInlineTable } from "./toml-utils";

const KIMI_CODE_DIR = path.join(os.homedir(), ".kimi-code");
const KIMI_CODE_CONFIG_PATH = path.join(KIMI_CODE_DIR, "config.toml");

// Fallback context size when the model has no known limit.
const DEFAULT_CONTEXT_SIZE = 262144;

// Per-model wire output caps (max_output_size). Baidu Qianfan Token Plan
// rejects max_completion_tokens above 65536 with "400 parameter check failed,
// max_completion_tokens range is [1, 65536]". kimi's built-in model catalog
// knows some of these models (e.g. ernie-5.1) and would otherwise send their
// catalog output limit, which the platform rejects. Pinning the cap keeps
// requests within the platform's range.
const MODEL_OUTPUT_CAPS: Record<string, number> = {
  "qianfan-coding:ernie-5.1": 65536,
};

export class KimiCodeAdapter extends BaseAdapter {
  readonly id = "kimi-code";
  readonly name = "Kimi Code";
  readonly supportedTypes: ProviderType[] = ["openai"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    return { mode: "api_key", hasApiKey: false };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.["kimi-code"];
    if (sel?.providerId && sel?.modelId) return sel;
    return null;
  }

  // config.toml sometimes carries leftovers from other tools' formats — a
  // bare [models] table (a string "default" key inside the models map makes
  // kimi drop EVERY model alias: /model shows nothing, `kimi provider list`
  // reports models=0) and singular [model.<alias>] tables (self-contained
  // definitions kimi doesn't read). Strip both on every write.
  private stripForeignTables(toml: string): string {
    let out = toml.replace(/\[models\]\s*\n(?:[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*[^\n]*\n)*\n?/g, '');
    out = out.replace(/\[model\.[^\]]+\]\n(?:[^\[]*\n)*?(?=\n\[|\Z)/g, '');
    return out;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);

    await fs.ensureDir(KIMI_CODE_DIR);
    let toml = "";
    if (await fs.pathExists(KIMI_CODE_CONFIG_PATH)) {
      toml = await fs.readFile(KIMI_CODE_CONFIG_PATH, "utf-8");
    }
    toml = this.stripForeignTables(stripLegacyV1Keys(toml));
    // Multi-site mode: only rewrite THIS provider's tables so other enabled
    // sites (other okit-* provider/model tables) stay intact.
    toml = stripProviderTables(toml, getKimiCodeProviderId(provider), `okit-${sanitizeTomlKey(provider.id)}`);

    const providerId = getKimiCodeProviderId(provider);
    const openAIEndpoint = getProviderEndpoint(provider, "openai");
    const providerType = getProviderType(provider, openAIEndpoint);

    toml = upsertTomlTable(toml, `providers.${providerId}`, buildProviderTable(provider, openAIEndpoint.baseUrl, providerType, apiKey));
    toml = upsertProviderHeaders(toml, providerId, gatewayHeadersFor(provider.baseUrl));

    // Register every model of the provider so kimi's /model picker has real
    // choices, not just the currently selected one. The selected model is
    // always included even if it's not in the provider's model list.
    const modelIds = new Set<string>();
    for (const m of provider.models || []) modelIds.add(m.id);
    modelIds.add(modelId);

    for (const id of modelIds) {
      toml = upsertTomlTable(
        toml,
        `models.${getModelAlias(provider.id, id)}`,
        buildModelTable(provider, providerId, providerType, id),
      );
    }

    toml = upsertTopLevelTomlKey(toml, "default_model", tomlString(getModelAlias(provider.id, modelId)));
    await atomicWrite(KIMI_CODE_CONFIG_PATH, toml);
    await this.healModelFields();

    await updateUserConfig({
      providers: { "kimi-code": { providerId: provider.id, modelId } },
    } as any);
  }

  // Kimi Code re-serializes config.toml when it saves (thinking toggle,
  // /model switch, session create) and drops the REQUIRED `model` field from
  // every [models.*] entry whose provider is not the current default's —
  // breaking those models ("must define a wire-facing name"). Restore the
  // missing fields from OKIT's provider store. Alias->model id is lossy
  // (dots become dashes), so match each alias segment against the provider's
  // model list. Returns whether the config was modified.
  async healModelFields(): Promise<boolean> {
    if (!(await fs.pathExists(KIMI_CODE_CONFIG_PATH))) return false;
    const toml = await fs.readFile(KIMI_CODE_CONFIG_PATH, "utf-8");
    const providers = await loadProviders();
    const byId = new Map(providers.map(p => [p.id, p]));

    const resolveModelId = (alias: string): string | null => {
      // Longest id first: "xiaomi" is a prefix of "xiaomi-coding" and would
      // otherwise swallow the longer provider's aliases.
      const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
      for (const pid of ids) {
        const prefix = `okit-${sanitizeTomlKey(pid)}-`;
        if (!alias.startsWith(prefix)) continue;
        const seg = alias.slice(prefix.length);
        const provider = byId.get(pid);
        return provider?.models?.find(m => sanitizeTomlKey(m.id) === seg)?.id ?? null;
      }
      return null;
    };

    const source = toml.split("\n");
    const out: string[] = [];
    let changed = false;
    let i = 0;
    while (i < source.length) {
      const line = source[i];
      const header = line.match(/^\[models\.([a-zA-Z0-9_-]+)\]\s*(?:#.*)?$/);
      if (!header) {
        out.push(line);
        i++;
        continue;
      }
      let j = i + 1;
      const body: string[] = [];
      while (j < source.length && !/^\s*\[/.test(source[j])) {
        body.push(source[j]);
        j++;
      }
      out.push(line);
      if (!body.some(l => /^model\s*=/.test(l))) {
        const modelId = resolveModelId(header[1]);
        if (modelId) {
          out.push(`model = ${tomlString(modelId)}`);
          changed = true;
        }
      }
      out.push(...body);
      i = j;
    }

    if (!changed) return false;
    await atomicWrite(KIMI_CODE_CONFIG_PATH, out.join("\n"));
    return true;
  }

  // Additive (multi-site) support: write one site's provider table + model
  // tables without touching any other site's entries or the default model.
  // Used when the user adds a provider to the home list.
  async applyModels(entries: Array<{ provider: Provider; modelId: string }>): Promise<{ written: string[]; skipped: string[] }> {
    if (entries.length === 0) return { written: [], skipped: [] };

    await fs.ensureDir(KIMI_CODE_DIR);
    let toml = "";
    if (await fs.pathExists(KIMI_CODE_CONFIG_PATH)) {
      toml = await fs.readFile(KIMI_CODE_CONFIG_PATH, "utf-8");
    }
    toml = this.stripForeignTables(stripLegacyV1Keys(toml));

    const written: string[] = [];
    const apiKeys = new Map<string, string>();
    for (const { provider, modelId } of entries) {
      const providerId = getKimiCodeProviderId(provider);
      const openAIEndpoint = getProviderEndpoint(provider, "openai");
      const providerType = getProviderType(provider, openAIEndpoint);
      if (!apiKeys.has(provider.id)) {
        apiKeys.set(provider.id, (await this.resolveApiKey(provider)) || "");
      }
      const apiKey = apiKeys.get(provider.id);
      toml = upsertTomlTable(
        toml,
        `providers.${providerId}`,
        buildProviderTable(provider, openAIEndpoint.baseUrl, providerType, apiKey),
      );
      toml = upsertProviderHeaders(toml, providerId, gatewayHeadersFor(provider.baseUrl));
      toml = upsertTomlTable(
        toml,
        `models.${getModelAlias(provider.id, modelId)}`,
        buildModelTable(provider, providerId, providerType, modelId),
      );
      written.push(modelId);
    }

    await atomicWrite(KIMI_CODE_CONFIG_PATH, toml);
    await this.healModelFields();
    return { written, skipped: [] };
  }

  // Which OKIT provider ids currently have a provider table in kimi's config.
  // A table present = the site is enabled (kimi has no per-site enabled flag).
  async listEnabledProviders(): Promise<string[]> {
    if (!(await fs.pathExists(KIMI_CODE_CONFIG_PATH))) return [];
    const toml = await fs.readFile(KIMI_CODE_CONFIG_PATH, "utf-8");
    const ids: string[] = [];
    for (const line of toml.split("\n")) {
      const m = line.match(/^\s*\[providers\.([a-zA-Z0-9_-]+)\]\s*(?:#.*)?$/);
      if (!m) continue;
      const id = m[1];
      // The `kimi` table hosts OKIT's kimi official presets (kimi-coding /
      // moonshot) — they share kimi's built-in provider slot.
      if (id === "kimi") {
        if (!ids.includes("kimi-coding")) ids.push("kimi-coding");
        continue;
      }
      if (id.startsWith("okit-")) {
        const real = id.slice(5);
        if (!ids.includes(real)) ids.push(real);
      }
    }
    return ids;
  }

  // Remove one site: its provider table, its model tables, and (if it owned
  // the default model) the default_model key so kimi falls back to its
  // built-in model instead of a dangling alias.
  async removeProvider(providerId: string): Promise<void> {
    if (!(await fs.pathExists(KIMI_CODE_CONFIG_PATH))) return;
    const toml = await fs.readFile(KIMI_CODE_CONFIG_PATH, "utf-8");
    const tableProviderId = getKimiCodeProviderIdFromId(providerId);
    const aliasPrefix = `okit-${sanitizeTomlKey(providerId)}`;
    const stripped = stripProviderTables(toml, tableProviderId, aliasPrefix);
    if (stripped === toml) return;

    let out = stripped;
    const defaultModel = getTopLevelTomlValue(out, "default_model");
    if (typeof defaultModel === "string" && defaultModel.startsWith(`${aliasPrefix}-`)) {
      out = removeTopLevelTomlKey(out, "default_model");
    }
    await atomicWrite(KIMI_CODE_CONFIG_PATH, out);
  }
}

function buildProviderTable(provider: Provider, baseUrl: string, providerType: string, apiKey?: string): string[] {
  const lines = [
    `type = ${tomlString(providerType)}`,
    `base_url = ${tomlString(baseUrl)}`,
    ...(apiKey ? [`api_key = ${tomlString(apiKey)}`] : []),
  ];
  // custom_headers is NOT emitted inline: kimi rewrites config.toml and
  // normalizes inline header tables into [providers.<id>.custom_headers]
  // sub-tables — writing the inline form after kimi normalized creates a
  // duplicate key that breaks TOML parsing ("No providers configured").
  // Callers emit the sub-table form via upsertProviderHeaders instead.
  return lines;
}

// Emit (or remove) the [providers.<id>.custom_headers] sub-table — the form
// kimi itself normalizes to. Never mix with an inline table on the same key.
function upsertProviderHeaders(toml: string, providerId: string, headers: Record<string, string> | null | undefined): string {
  const subTable = `providers.${providerId}.custom_headers`;
  const subRegex = new RegExp("\\n?\\[\\s*" + escapeRegex(subTable) + "\\s*\\]\\s*\\n(?:[^\\[]*\\n)*", "g");
  let out = toml.replace(subRegex, "\n");
  const provRegex = new RegExp("(\\[\\s*" + escapeRegex(`providers.${providerId}`) + "\\s*\\]\\s*\\n)((?:[^\\[]*\\n)?)", "m");
  out = out.replace(provRegex, (_m: string, head: string, body: string) =>
    head + body.split("\n").filter(l => !/^\s*custom_headers\s*=/.test(l)).join("\n"));
  if (headers && Object.keys(headers).length) {
    const lines = Object.entries(headers).map(([k, v]) => `${k} = ${tomlString(String(v))}`);
    out = upsertTomlTable(out, subTable, lines);
  }
  return out;
}

function buildModelTable(provider: Provider, providerId: string, providerType: string, modelId: string): string[] {
  const caps = resolveModelCapabilities(modelId);
  // Gateway free-tier models (opencode.ai / openrouter.ai) get explicit token
  // windows so max_tokens never exceeds what the endpoint accepts (see
  // gateway.ts). Without this, max_context_size would come from capability
  // metadata and max_output_size would be unset — letting kimi send the
  // platform-rejected defaults.
  const gatewayLimit = modelLimitFor(provider.baseUrl, modelId);
  // Catalog metadata (models.dev) wins over capability heuristics — real
  // context/output limits instead of name-based guesses.
  const meta = (provider.models || []).find(x => x.id === modelId)?.meta;
  const maxContext = gatewayLimit?.context ?? meta?.context ?? caps.maxInputTokens ?? DEFAULT_CONTEXT_SIZE;
  const table = [
    `provider = ${tomlString(providerId)}`,
    `model = ${tomlString(modelId)}`,
    `protocol = ${tomlString(getWireProtocol(providerType))}`,
    `max_context_size = ${maxContext}`,
  ];
  const outputCap = gatewayLimit?.output ?? meta?.output ?? MODEL_OUTPUT_CAPS[`${provider.id}:${modelId}`];
  if (outputCap) table.push(`max_output_size = ${outputCap}`);
  const capabilities = getCapabilities(modelId, caps);
  if (capabilities.length) {
    table.push(`capabilities = [${capabilities.map(tomlString).join(", ")}]`);
  }
  table.push(`display_name = ${tomlString(`${provider.name} ${modelId}`)}`);
  return table;
}


function getProviderEndpoint(provider: Provider, type: ProviderType) {
  const endpoints = provider.endpoints || [{ type: provider.type, baseUrl: provider.baseUrl }];
  const endpoint = endpoints.find(ep => ep.type === type);
  if (!endpoint?.baseUrl) throw new Error(`${provider.name} 缺少 ${type} endpoint`);
  return endpoint;
}

// Provider `type` must use the canonical values from the Kimi Code docs
// (`kimi` / `openai` / `openai_responses` / ...). The legacy alias
// `openai_legacy` is accepted for reading, but kimi treats it as a foreign
// type and strips the required `model` field from that provider's model
// entries when it rewrites config.toml — breaking them on the next switch.
function getProviderType(provider: Provider, endpoint: { protocol?: string }): string {
  if (provider.id === "kimi-coding" || provider.id === "moonshot") return "kimi";
  return endpoint.protocol === "responses" ? "openai_responses" : "openai";
}

// The wire protocol a model speaks; the v2 engine rejects models without it.
function getWireProtocol(providerType: string): string {
  if (providerType === "kimi") return "kimi";
  if (providerType === "openai_responses") return "openai_responses";
  return "openai";
}

function getKimiCodeProviderId(provider: Provider): string {
  return getKimiCodeProviderIdFromId(provider.id);
}

function getKimiCodeProviderIdFromId(providerId: string): string {
  if (providerId === "kimi-coding" || providerId === "moonshot") return "kimi";
  return `okit-${sanitizeTomlKey(providerId)}`;
}

function getModelAlias(providerId: string, modelId: string): string {
  return `okit-${sanitizeTomlKey(providerId)}-${sanitizeTomlKey(modelId)}`;
}

function getCapabilities(modelId: string, caps: ModelCapabilities): string[] {
  const out: string[] = [];
  if (modelId.toLowerCase().includes("thinking")) out.push("always_thinking");
  else if (caps.supportsReasoning) out.push("thinking");
  if (caps.supportsImages) out.push("image_in");
  return out;
}

// Kimi Code v1 (Claude Code fork lineage) used `model` / `model_provider` and
// a `[model_providers.*]` table. The v2 engine ignores those keys entirely
// (they show up as "Unknown top-level keys" in `kimi doctor`), so OKIT strips
// them when rewriting so the config stays clean for the v2 format.
function stripLegacyV1Keys(toml: string): string {
  const source = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of source) {
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    if (/^\s*\[model_providers(?:\..*)?\]\s*(?:#.*)?$/.test(line)) {
      skipping = true;
      continue;
    }
    if (/^\s*(?:model|model_provider)\s*=/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Removes the OKIT-managed tables of ONE provider (its [providers.<id>] table
// and its [models.okit-<providerId>-*] aliases) so a switch can rewrite that
// site fresh. Tables of OTHER enabled sites and non-okit tables (kimi's own
// [thinking], [services.*], hand-written providers) are left untouched — that
// is what makes multi-site (additive) configs work.
function stripProviderTables(toml: string, tableProviderId: string, aliasPrefix: string): string {
  const source = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  const providerHeader = new RegExp(`^\\s*\\[providers\\.${escapeRegex(tableProviderId)}\\]\\s*(?:#.*)?$`);
  const modelsHeader = new RegExp(`^\\s*\\[models\\.${escapeRegex(aliasPrefix)}-[a-zA-Z0-9_-]*\\]\\s*(?:#.*)?$`);
  for (const line of source) {
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    if (providerHeader.test(line) || modelsHeader.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function getTopLevelTomlValue(toml: string, key: string): string | null {
  const regex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`);
  for (const line of toml.split("\n")) {
    const m = line.match(regex);
    if (m) return m[1];
  }
  return null;
}

function removeTopLevelTomlKey(toml: string, key: string): string {
  const regex = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const out = toml.split("\n").filter(line => !regex.test(line));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
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

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}