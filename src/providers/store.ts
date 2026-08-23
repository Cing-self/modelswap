import fs from "fs-extra";
import path from "path";
import { OKIT_DIR } from "../config/registry";
import { backupImportantData } from "../config/backup";
import { Provider, ProvidersData } from "./types";
import { PRESET_PROVIDERS } from "./presets";
import { buildPlatforms } from "./platforms";
import {
  PRESET_AUTH_MODE_MIGRATIONS,
  PRESET_BASE_URL_MIGRATIONS,
  PRESET_ENDPOINT_BASE_URL_MIGRATIONS,
  PRESET_MODEL_ID_MIGRATIONS,
  RETIRED_PRESET_PROVIDER_IDS,
} from "./metadata";
import { atomicWriteJSON } from "../utils/atomicWrite";

const PROVIDERS_PATH = path.join(OKIT_DIR, "providers.json");
// These used to be bundled presets. Retire them on load as well as removing
// them from the source list so existing OKIT installations match the UI.
const PRESET_ENDPOINT_PLAN_MIGRATIONS = new Map([
  ["opencode-go", { from: ["go", "agent"], to: "coding" }],
  ["qianfan-coding", { from: ["coding"], to: "token" }],
]);

export async function loadProviders(): Promise<Provider[]> {
  if (!(await fs.pathExists(PROVIDERS_PATH))) {
    await saveProviders(PRESET_PROVIDERS as Provider[]);
    return [...PRESET_PROVIDERS] as Provider[];
  }
  try {
    const content = await fs.readFile(PROVIDERS_PATH, "utf-8");
    const data: ProvidersData = JSON.parse(content);
    if (!Array.isArray(data.providers)) throw new Error("providers.json 中的 providers 必须是数组");
    const providers = data.providers
      .filter(isValidProvider)
      .filter(provider => !RETIRED_PRESET_PROVIDER_IDS.has(provider.id));

    // Merge new presets: add missing ones, update name changes, and apply
    // narrowly-scoped endpoint migrations for known broken built-in defaults.
    const existingIds = new Set(providers.map(p => p.id));
    let changed = providers.length !== data.providers.length;
    for (const preset of PRESET_PROVIDERS as Provider[]) {
      const existing = providers.find(p => p.id === preset.id);
      if (!existing) {
        providers.push(preset);
        changed = true;
      } else {
        const migration = PRESET_BASE_URL_MIGRATIONS.get(preset.id);
        if (migration) {
          if (existing.baseUrl === migration.from) {
            existing.baseUrl = migration.to;
            changed = true;
          }
          // Model Management reads `endpoints` when it is present. Migrate the
          // same known stale URL there too; otherwise the card looks updated
          // while its connection test still calls the old endpoint.
          if (Array.isArray(existing.endpoints)) {
            let endpointChanged = false;
            existing.endpoints = existing.endpoints.map(endpoint => {
              if (endpoint && endpoint.type === preset.type && endpoint.baseUrl === migration.from) {
                endpointChanged = true;
                return { ...endpoint, baseUrl: migration.to };
              }
              return endpoint;
            });
            if (endpointChanged) changed = true;
          }
        }
        const endpointMigrations = PRESET_ENDPOINT_BASE_URL_MIGRATIONS.get(preset.id);
        if (endpointMigrations?.length && Array.isArray(existing.endpoints)) {
          let endpointChanged = false;
          existing.endpoints = existing.endpoints.map(endpoint => {
            const endpointMigration = endpointMigrations.find(candidate =>
              endpoint
              && endpoint.baseUrl === candidate.from
              && (!candidate.type || endpoint.type === candidate.type),
            );
            if (endpointMigration) {
              endpointChanged = true;
              return { ...endpoint, baseUrl: endpointMigration.to };
            }
            return endpoint;
          });
          if (endpointChanged) changed = true;
        }
        const planMigration = PRESET_ENDPOINT_PLAN_MIGRATIONS.get(preset.id);
        if (planMigration && Array.isArray(existing.endpoints)) {
          let endpointChanged = false;
          existing.endpoints = existing.endpoints.map(endpoint => {
            if (endpoint?.plan && planMigration.from.includes(endpoint.plan)) {
              endpointChanged = true;
              return { ...endpoint, plan: planMigration.to as "coding" | "token" | "go" };
            }
            return endpoint;
          });
          if (endpointChanged) changed = true;
        }
        const authModeMigration = PRESET_AUTH_MODE_MIGRATIONS.get(preset.id);
        if (authModeMigration && existing.authMode === authModeMigration.from) {
          existing.authMode = authModeMigration.to as "api_key";
          changed = true;
        }
        // Sync endpoints that exist in the preset but are missing from the
        // stored provider (e.g. a newly-declared anthropic-compatible endpoint
        // added after the user's providers.json was first initialized). Only
        // ADDS missing endpoint types — never removes or overwrites user edits.
        if (Array.isArray(preset.endpoints)) {
          const existingTypes = new Set((existing.endpoints || []).map(e => e.type));
          for (const presetEp of preset.endpoints) {
            if (presetEp && !existingTypes.has(presetEp.type)) {
              existing.endpoints = [...(existing.endpoints || []), presetEp];
              changed = true;
            }
          }
          // Older builds may already have the correct built-in URL but lack
          // its newer protocol/plan metadata. Fill only missing fields on an
          // exact URL+type match; never rewrite a customized endpoint.
          let endpointMetadataChanged = false;
          existing.endpoints = (existing.endpoints || []).map(endpoint => {
            const presetEndpoint = preset.endpoints?.find(candidate =>
              candidate.type === endpoint.type
              && candidate.baseUrl === endpoint.baseUrl
              && (!endpoint.protocol || !candidate.protocol || candidate.protocol === endpoint.protocol),
            );
            if (!presetEndpoint) return endpoint;
            const next = { ...endpoint };
            if (!next.protocol && presetEndpoint.protocol) {
              next.protocol = presetEndpoint.protocol;
              endpointMetadataChanged = true;
            }
            if (!next.plan && presetEndpoint.plan) {
              next.plan = presetEndpoint.plan;
              endpointMetadataChanged = true;
            }
            return next;
          });
          if (endpointMetadataChanged) changed = true;
        }
        if (existing.name !== preset.name) {
          existing.name = preset.name;
          changed = true;
        }
        // Sync per-model capability declarations the preset carries but the
        // stored instance lacks (matched by model id). Models discovered from
        // a live gateway/catalog endpoint come back with no capability data —
        // filling from the preset is what lets agent adapters gate image
        // input for known text-only models. Only fills missing; user-set
        // capabilities are never overwritten.
        if (Array.isArray(preset.models) && preset.models.length > 0) {
          const capsById = new Map(
            preset.models
              .filter(m => Array.isArray(m.capabilities) && m.capabilities.length > 0)
              .map(m => [m.id, m.capabilities as string[]]),
          );
          if (capsById.size > 0 && Array.isArray(existing.models)) {
            let capsChanged = false;
            existing.models = existing.models.map(model => {
              const caps = capsById.get(model.id);
              if (caps && !Array.isArray(model.capabilities)) {
                capsChanged = true;
                return { ...model, capabilities: [...caps] };
              }
              return model;
            });
            if (capsChanged) changed = true;
          }
        }
        if (preset.executionMode && existing.executionMode !== preset.executionMode) {
          existing.executionMode = preset.executionMode;
          changed = true;
        }
        if (preset.executionMode === "agent_native" && Array.isArray(existing.endpoints)) {
          delete existing.endpoints;
          changed = true;
        }
        if (preset.nativeAgentIds && JSON.stringify(existing.nativeAgentIds) !== JSON.stringify(preset.nativeAgentIds)) {
          existing.nativeAgentIds = [...preset.nativeAgentIds];
          changed = true;
        }
        if (preset.cliOnly === true && existing.cliOnly !== true) {
          existing.cliOnly = true;
          changed = true;
        }
        if (preset.authMode === "none" && existing.authMode !== "none" && !existing.vaultKey) {
          existing.authMode = "none";
          changed = true;
        }
        const modelSnapshots = PRESET_MODEL_ID_MIGRATIONS.get(preset.id) || [];
        const existingModelIds = existing.models.map(model => model.id);
        if (modelSnapshots.some(snapshot => JSON.stringify(snapshot) === JSON.stringify(existingModelIds))) {
          existing.models = preset.models.map(model => ({ ...model }));
          changed = true;
        }
        if (
          preset.id === "qianfan-coding"
          && existing.models.some(model => ["kimi-k2.5", "deepseek-v3.2", "minimax-m2.5", "ernie-4.5-turbo-20260402"].includes(model.id))
        ) {
          existing.models = preset.models.map(model => ({ ...model }));
          changed = true;
        }
        if (
          preset.id === "xiaomi-coding"
          && existing.models.length === 4
          && existing.models.every(model => ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.5-asr", "mimo-v2.5-tts"].includes(model.id))
        ) {
          existing.models = preset.models.map(model => ({ ...model }));
          changed = true;
        }
      }
    }

    // Coding Plan uses a separate API-key scope. Older builds put the Coding
    // endpoint beside the regular Qianfan endpoint, which made one ordinary
    // key look partially broken forever. Keep the regular provider regular;
    // the dedicated qianfan-coding preset owns that endpoint now.
    const qianfan = providers.find(provider => provider.id === "qianfan");
    if (qianfan && Array.isArray(qianfan.endpoints)) {
      const filtered = qianfan.endpoints.filter(endpoint =>
        !/^https?:\/\/qianfan\.baidubce\.com\/v2\/(?:coding|tokenplan\/personal)\/?$/i.test(endpoint.baseUrl),
      );
      if (filtered.length !== qianfan.endpoints.length) {
        if (filtered.length) qianfan.endpoints = filtered;
        else delete qianfan.endpoints;
        if (qianfan.baseUrl === "https://qianfan.baidubce.com/v2/coding") {
          qianfan.baseUrl = "https://qianfan.baidubce.com/v2";
        }
        changed = true;
      }
    }
    if (changed) await saveProviders(providers);

    return providers;
  } catch (error) {
    throw new Error(`无法读取 providers.json：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveProviders(providers: Provider[]): Promise<void> {
  await fs.ensureDir(OKIT_DIR);
  await backupImportantData("providers");
  const data: ProvidersData = { providers, platforms: buildPlatforms(providers) };
  await atomicWriteJSON(PROVIDERS_PATH, data);
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const providers = await loadProviders();
  return providers.find(p => p.id === id);
}

export async function addProvider(provider: Provider): Promise<void> {
  const providers = await loadProviders();
  const idx = providers.findIndex(p => p.id === provider.id);
  if (idx >= 0) {
    providers[idx] = provider;
  } else {
    providers.push(provider);
  }
  await saveProviders(providers);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const providers = await loadProviders();
  const idx = providers.findIndex(p => p.id === id);
  if (idx < 0) return false;
  providers.splice(idx, 1);
  await saveProviders(providers);
  return true;
}

function isValidProvider(value: any): value is Provider {
  return (
    value &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.baseUrl === "string" &&
    Array.isArray(value.models) &&
    value.models.every((m: any) => typeof m.id === "string")
  );
}
