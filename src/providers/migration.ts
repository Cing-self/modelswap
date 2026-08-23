import fs from "fs-extra";
import path from "path";
import { OKIT_DIR } from "../config/registry";
import { Provider, ProviderModel } from "./types";
import { loadProviders, saveProviders } from "./store";
import { VaultStore } from "../vault/store";

const CLAUDE_PROFILES_PATH = path.join(OKIT_DIR, "claude-profiles.json");
const PROVIDERS_PATH = path.join(OKIT_DIR, "providers.json");

type ClaudeProfile = {
  name: string;
  baseUrl: string;
  authToken: string;
  models: string[];
};

export async function migrateIfNeeded(): Promise<boolean> {
  if (await fs.pathExists(PROVIDERS_PATH)) return false;
  if (!(await fs.pathExists(CLAUDE_PROFILES_PATH))) return false;

  try {
    const content = await fs.readFile(CLAUDE_PROFILES_PATH, "utf-8");
    const profiles: ClaudeProfile[] = JSON.parse(content);
    if (!Array.isArray(profiles)) return false;

    const store = new VaultStore();
    const providers: Provider[] = [];

    for (const profile of profiles) {
      if (!profile.name || !profile.baseUrl) continue;

      const id = profile.name.toLowerCase().replace(/\s+/g, "-");
      const models: ProviderModel[] = (profile.models || []).map(m => ({ id: m }));

      let vaultKey: string | undefined;
      if (profile.authToken) {
        vaultKey = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        try {
          await store.set(vaultKey, profile.authToken, "providers");
        } catch {}
      }

      providers.push({
        id,
        name: profile.name,
        type: "anthropic",
        baseUrl: profile.baseUrl,
        vaultKey,
        authMode: profile.authToken ? "api_key" : "oauth",
        models,
      });
    }

    await saveProviders(providers);
    return true;
  } catch {
    return false;
  }
}
