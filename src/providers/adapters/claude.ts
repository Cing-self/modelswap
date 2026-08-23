import fs from "fs-extra";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { BaseAdapter } from "./base";
import { AgentSelection, AuthStatus, Provider, ProviderType } from "../types";
import { loadUserConfig, updateUserConfig } from "../../config/user";
import { checkClaudeOAuth } from "../auth";
import { atomicWrite, atomicWriteJSON } from "../../utils/atomicWrite";

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
// OAuth login token stored by `claude /login`. When switching to a third-party
// provider we must remove it — otherwise Claude Code sees both an OAuth token
// and ANTHROPIC_API_KEY and refuses to start ("Auth conflict"). We back it up
// so switching back to the official provider can restore it without re-login.
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CLAUDE_CREDENTIALS_BACKUP = path.join(os.homedir(), ".claude", ".credentials.json.okit-backup");

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Claude Code exposes two credential variables with different wire semantics:
// ANTHROPIC_API_KEY/apiKeyHelper sends x-api-key, while
// ANTHROPIC_AUTH_TOKEN sends Authorization: Bearer. Several compatible
// gateways document only the latter, so credential delivery must follow the
// selected endpoint instead of applying one header to every provider.
function usesAnthropicBearerAuth(baseUrl: string): boolean {
  return [
    /^https?:\/\/(?:coding(?:-intl)?\.dashscope\.aliyuncs\.com|token-plan\.cn-beijing\.maas\.aliyuncs\.com)\//i,
    /^https?:\/\/(?:open\.bigmodel\.cn|api\.z\.ai)\/api\/anthropic\/?$/i,
    /^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/(?:coding|plan)\/?$/i,
  ].some(pattern => pattern.test(String(baseUrl || '').trim()));
}

// Detect whether Claude Code has an OAuth session in macOS Keychain. Claude
// Code stores its OAuth token under the "Claude Code-credentials" service. We
// don't read the secret (that would prompt for keychain access) — we only
// check whether the entry exists, so we know to use apiKeyHelper to avoid the
// "Auth conflict" error.
function hasKeychainOAuth(): boolean {
  if (os.platform() !== "darwin") return false;
  try {
    execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export class ClaudeAdapter extends BaseAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly supportedTypes: ProviderType[] = ["anthropic"];

  async detectOAuthStatus(): Promise<AuthStatus> {
    const oauthLoggedIn = await checkClaudeOAuth();
    return { mode: "both", hasApiKey: false, oauthLoggedIn };
  }

  async getCurrentConfig(): Promise<AgentSelection | null> {
    const config = await loadUserConfig();
    const sel = (config as any).providers?.claude;
    if (sel?.providerId && sel?.modelId) return sel;
    // Fallback to legacy claude config
    if (config.claude?.name && config.claude?.model) {
      return { providerId: config.claude.name.toLowerCase(), modelId: config.claude.model };
    }
    return null;
  }

  async applyConfig(provider: Provider, modelId: string): Promise<void> {
    const apiKey = await this.resolveApiKey(provider);
    // Claude Code speaks the Anthropic Messages API protocol, so we MUST use an
    // anthropic-type endpoint. A single base URL can't serve both protocols
    // (Anthropic Messages and OpenAI Chat are different request shapes). If the
    // provider doesn't declare an anthropic endpoint, it doesn't support Claude
    // Code — bail out rather than write a broken config.
    const anthropicEndpoint = provider.endpoints?.find(e => e.type === "anthropic");
    // Providers without explicit endpoints (e.g. the official Anthropic preset)
    // carry their base URL at the top level — treat that as the anthropic URL.
    const effectiveBaseUrl = anthropicEndpoint?.baseUrl
      || (provider.type === "anthropic" ? provider.baseUrl : undefined);
    if (!effectiveBaseUrl) {
      throw new Error(`${provider.name} 没有声明 Anthropic 协议端点，不支持 Claude Code`);
    }
    // "Official" is determined by the base URL only — NOT by whether an API key
    // is bound. A user may have set a key on the Anthropic preset; switching
    // back to it must still clear the custom-routing fields (BASE_URL, MODEL,
    // AUTH_TOKEN, DEFAULT_*_MODEL) so Claude Code resumes its native behavior.
    // If a key is present on the official preset we keep it as ANTHROPIC_API_KEY
    // (the field Claude Code reads for native key auth), separate from the
    // ANTHROPIC_AUTH_TOKEN used by third-party gateways.
    const isOfficial = effectiveBaseUrl === "https://api.anthropic.com";

    await fs.ensureDir(path.dirname(CLAUDE_SETTINGS_PATH));
    let data: Record<string, any> = {};
    if (await fs.pathExists(CLAUDE_SETTINGS_PATH)) {
      const content = await fs.readFile(CLAUDE_SETTINGS_PATH, "utf-8");
      data = content.trim() ? JSON.parse(content) : {};
    }

    // Two official modes require opposite credential handling:
    // - OAuth (Claude Pro/Max subscription): restore OAuth token, clear API key
    // - API key (Anthropic platform): set API key, move OAuth token aside
    // Third-party: always move OAuth token aside (key delivered via apiKeyHelper).
    const isSubscription = isOfficial && provider.authMode === "oauth";
    if (isSubscription) {
      // Restore OAuth credentials so the user doesn't re-login.
      if (await fs.pathExists(CLAUDE_CREDENTIALS_BACKUP)) {
        await fs.move(CLAUDE_CREDENTIALS_BACKUP, CLAUDE_CREDENTIALS_PATH, { overwrite: true });
      }
    } else {
      // API platform or third-party — move OAuth token aside to avoid conflict.
      if (await fs.pathExists(CLAUDE_CREDENTIALS_PATH)) {
        await fs.move(CLAUDE_CREDENTIALS_PATH, CLAUDE_CREDENTIALS_BACKUP, { overwrite: true });
      }
    }

    const env = (typeof data.env === "object" && data.env) ? { ...data.env } : {};

    if (isOfficial) {
      // Clear all custom-routing fields so the CLI uses its native behavior.
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_MODEL;
      delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete data.apiKeyHelper;
      if (isSubscription) {
        // Subscription = pure OAuth. No API key in env.
        delete env.ANTHROPIC_API_KEY;
      } else if (apiKey) {
        // API platform. If the user has an OAuth session in keychain, setting
        // ANTHROPIC_API_KEY directly triggers "Auth conflict". Use apiKeyHelper
        // instead — it delivers the key via x-api-key without triggering the
        // conflict check (same trick we use for third-party providers).
        const hasOAuth = await hasKeychainOAuth();
        if (hasOAuth) {
          const helperPath = path.join(os.homedir(), ".claude", ".okit-key-helper.sh");
          await atomicWrite(helperPath, `#!/bin/sh\necho ${shellQuote(apiKey)}\n`, { mode: 0o700 });
          data.apiKeyHelper = helperPath;
          delete env.ANTHROPIC_API_KEY;
        } else {
          env.ANTHROPIC_API_KEY = apiKey;
        }
      } else {
        delete env.ANTHROPIC_API_KEY;
      }
    } else {
      env.ANTHROPIC_BASE_URL = effectiveBaseUrl;
      // ANTHROPIC_MODEL is the primary model. The three DEFAULT_*_MODEL keys
      // let custom providers map each Anthropic tier (haiku/sonnet/opus) to a
      // different backing model so the CLI never 404s when it falls back to a
      // smaller variant. If the user configured per-provider tier overrides
      // (claudeTierMaps in user.json), use them; otherwise default every tier
      // to the selected model (same behavior as cc-switch).
      const tierMap = (await loadUserConfig()).claudeTierMaps?.[provider.id];
      env.ANTHROPIC_MODEL = modelId;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = tierMap?.haiku || modelId;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = tierMap?.sonnet || modelId;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = tierMap?.opus || modelId;
      // Deliver the credential using the header semantics required by this
      // endpoint. Bearer gateways use ANTHROPIC_AUTH_TOKEN; x-api-key gateways
      // use apiKeyHelper so an existing Claude OAuth session does not trigger
      // the "both a token and an API key" conflict.
      if (apiKey) {
        if (usesAnthropicBearerAuth(effectiveBaseUrl)) {
          env.ANTHROPIC_AUTH_TOKEN = apiKey;
          delete data.apiKeyHelper;
        } else {
          const helperPath = path.join(os.homedir(), ".claude", ".okit-key-helper.sh");
          await atomicWrite(helperPath, `#!/bin/sh\necho ${shellQuote(apiKey)}\n`, { mode: 0o700 });
          data.apiKeyHelper = helperPath;
          delete env.ANTHROPIC_AUTH_TOKEN;
        }
      } else {
        delete data.apiKeyHelper;
        delete env.ANTHROPIC_AUTH_TOKEN;
      }
      // Never leave ANTHROPIC_API_KEY in env — that's what triggers the conflict.
      delete env.ANTHROPIC_API_KEY;
    }

    if (Object.keys(env).length === 0) delete data.env;
    else data.env = env;

    await atomicWriteJSON(CLAUDE_SETTINGS_PATH, data);

    // Save selection to both new and legacy paths
    await updateUserConfig({
      providers: { claude: { providerId: provider.id, modelId } },
      claude: { name: provider.name, model: modelId },
    } as any);
  }
}
