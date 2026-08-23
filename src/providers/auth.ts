import fs from "fs-extra";
import path from "path";
import os from "os";
import { AuthStatus, Provider } from "./types";
import { VaultStore } from "../vault/store";

export async function checkAuthStatus(provider: Provider): Promise<AuthStatus> {
  const hasApiKey = await checkVaultKey(provider.vaultKey);

  if (provider.authMode === "oauth") {
    return { mode: "oauth", hasApiKey, oauthLoggedIn: false };
  }

  if (provider.authMode === "api_key") {
    return { mode: "api_key", hasApiKey };
  }

  // 'both' mode
  return { mode: "both", hasApiKey };
}

export async function checkVaultKey(vaultKey?: string): Promise<boolean> {
  if (!vaultKey) return false;
  try {
    const store = new VaultStore();
    const value = await store.get(vaultKey);
    return !!value;
  } catch {
    return false;
  }
}

export async function checkClaudeOAuth(): Promise<boolean> {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    if (!(await fs.pathExists(credPath))) return false;
    const content = await fs.readFile(credPath, "utf-8");
    const data = JSON.parse(content);
    return !!(data.claudeApiKey || data.accessToken || data.apiKey);
  } catch {
    return false;
  }
}

export async function checkCodexOAuth(): Promise<boolean> {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    if (!(await fs.pathExists(authPath))) return false;
    const content = await fs.readFile(authPath, "utf-8");
    const data = JSON.parse(content);
    return data.auth_mode === "chatgpt" && !!(data.tokens?.access_token);
  } catch {
    return false;
  }
}
