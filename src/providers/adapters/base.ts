import { AgentAdapter, AgentSelection, AuthStatus, Provider, ProviderType, ResolvedModel } from "../types";
import { VaultStore } from "../../vault/store";

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly supportedTypes: ProviderType[];
  abstract detectOAuthStatus(): Promise<AuthStatus>;
  abstract getCurrentConfig(): Promise<AgentSelection | null>;
  abstract applyConfig(
    provider: Provider,
    modelId: string,
    resolvedModel?: ResolvedModel,
    resolvedModels?: Record<string, ResolvedModel>,
  ): Promise<void>;

  async resolveApiKey(provider: Provider): Promise<string | undefined> {
    if (provider.vaultKey) {
      try {
        const store = new VaultStore();
        const value = await store.get(provider.vaultKey);
        if (value) return value;
      } catch {}
    }
    return undefined;
  }
}
