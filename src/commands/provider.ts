import prompts from "prompts";
import kleur from "kleur";
import { t } from "../config/i18n";
import { loadProviders, addProvider, deleteProvider, getProvider } from "../providers/store";
import { PRESET_PROVIDERS } from "../providers/presets";
import { getAdapters, getAdapter } from "../providers/registry";
import { checkAuthStatus } from "../providers/auth";
import { loadUserConfig, updateUserConfig } from "../config/user";
import { Provider, ProviderModel } from "../providers/types";
import { providerSupportsAdapter, resolveModelRoute } from "../providers/routing";
import { capturePreSwitchSnapshot } from "../providers/snapshots";
import { VaultStore } from "../vault/store";

export async function providerList(options?: { json?: boolean }): Promise<void> {
  const providers = await loadProviders();
  if (providers.length === 0) {
    if (options?.json) {
      process.stdout.write("[]\n");
      return;
    }
    console.log(kleur.yellow(t("providerNoProviders")));
    return;
  }

  if (options?.json) {
    const result = [];
    for (const provider of providers) {
      const auth = await checkAuthStatus(provider);
      result.push({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        auth: {
          hasApiKey: auth.hasApiKey,
          oauthLoggedIn: auth.oauthLoggedIn,
        },
        models: provider.models.map(model => ({ id: model.id, name: model.name || model.id })),
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(kleur.bold(`\n${t("providerListTitle")}:\n`));
  for (const p of providers) {
    const auth = await checkAuthStatus(p);
    const authIcon = auth.hasApiKey ? kleur.green("✓") : kleur.red("✗");
    const typeBadge = kleur.cyan(`[${p.type}]`);
    console.log(`  ${kleur.bold(p.name)}  ${typeBadge}  ${kleur.gray(p.baseUrl)}`);
    console.log(`    ${t("providerAuthApiKey")}: ${authIcon}  ${t("providerId")}: ${kleur.gray(p.id)}`);
    if (p.models.length > 0) {
      const models = p.models.map(m => m.name || m.id).join(", ");
      console.log(`    Models: ${kleur.gray(models)}`);
    }
    console.log();
  }
}

export async function providerCurrent(options?: { json?: boolean }): Promise<void> {
  const providers = await loadProviders();
  const adapters = getAdapters();
  const config = await loadUserConfig();
  const providersConfig = (config as any).providers || {};

  if (options?.json) {
    const result = adapters.map(adapter => {
      const selection = providersConfig[adapter.id];
      const provider = selection?.providerId
        ? providers.find(item => item.id === selection.providerId)
        : undefined;
      return {
        agentId: adapter.id,
        agentName: adapter.name,
        configured: Boolean(selection?.providerId && selection?.modelId),
        providerId: selection?.providerId || null,
        providerName: provider?.name || selection?.providerId || null,
        modelId: selection?.modelId || null,
      };
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log(kleur.bold(`\n${t("providerCurrentTitle")}:\n`));
  for (const adapter of adapters) {
    const sel = providersConfig[adapter.id];
    if (sel?.providerId && sel?.modelId) {
      const provider = providers.find(p => p.id === sel.providerId);
      const name = provider ? provider.name : sel.providerId;
      console.log(`  ${kleur.bold(adapter.name)}: ${kleur.green(name)} / ${kleur.cyan(sel.modelId)}`);
    } else {
      console.log(`  ${kleur.bold(adapter.name)}: ${kleur.gray(t("providerAgentNotConfigured"))}`);
    }
  }
  console.log();
}

export async function providerSwitch(agentId?: string): Promise<void> {
  const providers = await loadProviders();
  if (providers.length === 0) {
    console.log(kleur.yellow(t("providerNoProviders")));
    return;
  }

  const adapters = getAdapters();
  let adapter = agentId ? getAdapter(agentId) : undefined;

  if (!adapter) {
    const response = await prompts({
      type: "select",
      name: "agent",
      message: t("providerSelectAgent"),
      choices: adapters.map(a => ({
        title: `${a.name}  [${a.supportedTypes.join(", ")}]`,
        value: a.id,
      })),
    });
    if (!response.agent) { console.log(kleur.gray(t("providerCancel"))); return; }
    adapter = getAdapter(response.agent);
  }
  if (!adapter) return;

  const compatible = providers.filter(p => providerSupportsAdapter(p, adapter!));
  if (compatible.length === 0) {
    console.log(kleur.yellow(`No compatible providers for ${adapter.name}`));
    return;
  }

  const current = await adapter.getCurrentConfig();

  const provResponse = await prompts({
    type: "select",
    name: "provider",
    message: t("providerSelectProvider"),
    choices: compatible.map(p => ({
      title: `${p.name}${p.id === current?.providerId ? " ✅" : ""}  |  ${p.baseUrl}`,
      value: p.id,
    })),
  });
  if (!provResponse.provider) { console.log(kleur.gray(t("providerCancel"))); return; }

  const selectedProvider = compatible.find(p => p.id === provResponse.provider)!;

  const modelResponse = await prompts({
    type: "select",
    name: "model",
    message: t("providerSelectModel"),
    choices: selectedProvider.models.map(m => ({
      title: `${m.name || m.id}${m.id === current?.modelId ? " ✅" : ""}`,
      value: m.id,
    })),
  });
  if (!modelResponse.model) { console.log(kleur.gray(t("providerCancel"))); return; }

  const route = resolveModelRoute(selectedProvider, modelResponse.model, adapter);
  try {
    await capturePreSwitchSnapshot(adapter.id);
  } catch (snapErr) {
    console.warn(`[providerSwitch] snapshot failed: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
  }
  await adapter.applyConfig(route.provider, route.remoteModelId);
  await updateUserConfig({ providers: { [adapter.id]: { providerId: selectedProvider.id, modelId: modelResponse.model } } } as any);
  console.log(kleur.green(`${t("providerSwitched")}: ${selectedProvider.name} / ${modelResponse.model}`));
}

export async function providerUse(
  providerId: string,
  options?: { agent?: string; model?: string }
): Promise<void> {
  const providers = await loadProviders();
  const provider = providers.find(p => p.id === providerId || p.name === providerId);
  if (!provider) {
    console.log(kleur.red(t("providerNotFound")));
    process.exitCode = 1;
    return;
  }

  const modelId = options?.model || provider.models[0]?.id;
  if (!modelId) {
    console.log(kleur.red("No models available"));
    process.exitCode = 1;
    return;
  }

  const adapters = options?.agent
    ? [getAdapter(options.agent)].filter(Boolean)
    : getAdapters().filter(a => providerSupportsAdapter(provider, a));

  if (adapters.length === 0) {
    console.log(kleur.red("No compatible agents"));
    process.exitCode = 1;
    return;
  }

  for (const adapter of adapters) {
    const route = resolveModelRoute(provider, modelId, adapter!);
    try {
      await capturePreSwitchSnapshot(adapter!.id);
    } catch (snapErr) {
      console.warn(`[providerUse] snapshot failed: ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`);
    }
    await adapter!.applyConfig(route.provider, route.remoteModelId);
    await updateUserConfig({ providers: { [adapter!.id]: { providerId: provider.id, modelId } } } as any);
    console.log(kleur.green(`${adapter!.name}: ${t("providerSwitched")} → ${provider.name} / ${modelId}`));
  }
}

export async function providerAdd(): Promise<void> {
  const presetChoices = PRESET_PROVIDERS.map(p => ({
    title: `${p.name}  [${p.type}]  |  ${p.baseUrl}`,
    value: p.id,
  }));
  presetChoices.push({ title: t("providerPresetCustom"), value: "custom" });

  const presetResponse = await prompts({
    type: "select",
    name: "preset",
    message: t("providerPreset"),
    choices: presetChoices,
  });
  if (!presetResponse.preset) { console.log(kleur.gray(t("providerCancel"))); return; }

  let provider: Provider;

  if (presetResponse.preset !== "custom") {
    const preset = PRESET_PROVIDERS.find(p => p.id === presetResponse.preset)!;
    const apiKeyResponse = await prompts({
      type: "password",
      name: "apiKey",
      message: t("providerApiKey"),
    });
    provider = { ...preset, vaultKey: undefined };

    if (apiKeyResponse.apiKey) {
      const vaultKey = `${preset.id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      try {
        const store = new VaultStore();
        await store.set(vaultKey, String(apiKeyResponse.apiKey).trim(), "providers");
        provider.vaultKey = vaultKey;
      } catch {}
    }
  } else {
    const response = await prompts([
      { type: "text", name: "name", message: t("providerName") },
      { type: "select", name: "type", message: t("providerType"),
        choices: [
          { title: "anthropic", value: "anthropic" },
          { title: "openai", value: "openai" },
        ] },
      { type: "text", name: "baseUrl", message: t("providerBaseUrl") },
      { type: "password", name: "apiKey", message: t("providerApiKey") },
      { type: "text", name: "models", message: t("providerModels") },
    ]);
    if (!response.name || !response.baseUrl) { console.log(kleur.gray(t("providerCancel"))); return; }

    const models: ProviderModel[] = response.models
      ? String(response.models).split(",").map((s: string) => ({ id: s.trim() })).filter((m: ProviderModel) => m.id)
      : [];

    provider = {
      id: String(response.name).toLowerCase().replace(/\s+/g, "-"),
      name: String(response.name).trim(),
      type: response.type,
      baseUrl: String(response.baseUrl).trim(),
      authMode: "api_key",
      models,
    };

    if (response.apiKey) {
      const vaultKey = `${provider.id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      try {
        const store = new VaultStore();
        await store.set(vaultKey, String(response.apiKey).trim(), "providers");
        provider.vaultKey = vaultKey;
      } catch {}
    }
  }

  await addProvider(provider);
  console.log(kleur.green(`${t("providerAdded")}: ${provider.name}`));
}

export async function providerDeleteAction(name: string): Promise<void> {
  const providers = await loadProviders();
  const provider = providers.find(p => p.id === name || p.name === name);
  if (!provider) {
    console.log(kleur.red(t("providerNotFound")));
    process.exitCode = 1;
    return;
  }

  const confirm = await prompts({
    type: "confirm",
    name: "ok",
    message: `${t("providerConfirmDelete")} ${provider.name}?`,
    initial: false,
  });
  if (!confirm.ok) { console.log(kleur.gray(t("providerCancel"))); return; }

  await deleteProvider(provider.id);
  console.log(kleur.green(`${t("providerDeleted")}: ${provider.name}`));
}

export async function providerAuth(options?: { json?: boolean }): Promise<void> {
  const providers = await loadProviders();
  if (options?.json) {
    const result = [];
    for (const provider of providers) {
      const status = await checkAuthStatus(provider);
      result.push({
        providerId: provider.id,
        providerName: provider.name,
        hasApiKey: status.hasApiKey,
        oauthLoggedIn: status.oauthLoggedIn ?? null,
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(kleur.bold(`\n${t("providerAuthTitle")}:\n`));
  for (const p of providers) {
    const status = await checkAuthStatus(p);
    const parts: string[] = [];
    if (status.hasApiKey) {
      parts.push(`${t("providerAuthApiKey")} ✓`);
    }
    if (status.oauthLoggedIn !== undefined) {
      parts.push(`${t("providerAuthOAuth")} ${status.oauthLoggedIn ? kleur.green(t("providerAuthLoggedIn")) : kleur.red(t("providerAuthNotLoggedIn"))}`);
    }
    if (parts.length === 0) {
      parts.push(kleur.red(t("providerAuthNone")));
    }
    console.log(`  ${kleur.bold(p.name)}: ${parts.join(" | ")}`);
  }
  console.log();
}
