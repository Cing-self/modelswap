import {
  AgentAdapter,
  ExecutionMode,
  Provider,
  ProviderEndpoint,
  ProviderModel,
  ProviderModelAvailability,
  ProviderType,
  ResolvedModel,
} from "./types";

export interface ResolvedModelRoute {
  executionMode: ExecutionMode;
  provider: Provider;
  model: ProviderModel;
  remoteModelId: string;
  endpointId?: string;
}

export function providerExecutionMode(provider: Provider): ExecutionMode {
  if (provider.executionMode) return provider.executionMode;
  // Legacy bundled subscriptions used `cliOnly`; OAuth alone is not enough to
  // infer native execution because a custom HTTP offering may still use OAuth.
  return provider.cliOnly === true ? "agent_native" : "http_endpoint";
}

function generatedEndpointId(providerId: string, endpoint: ProviderEndpoint): string {
  const identity = [endpoint.type, endpoint.protocol || "", endpoint.plan || "", endpoint.baseUrl.replace(/\/+$/, "")].join("|");
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${providerId}:endpoint:${(hash >>> 0).toString(36)}`;
}

export function providerEndpointEntries(provider: Provider): Array<{ id: string; endpoint: ProviderEndpoint }> {
  if (providerExecutionMode(provider) === "agent_native") return [];
  const endpoints = provider.endpoints?.length
    ? provider.endpoints
    : provider.baseUrl ? [{ type: provider.type, baseUrl: provider.baseUrl } as ProviderEndpoint] : [];
  return endpoints
    .filter(endpoint => Boolean(endpoint?.baseUrl))
    .map(endpoint => ({
      id: endpoint.id || generatedEndpointId(provider.id, endpoint),
      endpoint,
    }));
}

export function providerSupportsAdapter(provider: Provider, adapter: Pick<AgentAdapter, "id" | "supportedTypes">): boolean {
  if (providerExecutionMode(provider) === "agent_native") {
    return Boolean(provider.nativeAgentIds?.includes(adapter.id));
  }
  return providerEndpointEntries(provider).some(({ endpoint }) => adapter.supportedTypes.includes(endpoint.type));
}

function legacyAvailability(provider: Provider, model: ProviderModel): ProviderModelAvailability[] {
  const executionMode = providerExecutionMode(provider);
  if (executionMode === "agent_native") {
    return [{
      executionMode,
      nativeAgentIds: provider.nativeAgentIds,
      remoteModelId: model.id,
      status: "available",
      source: "static",
    }];
  }

  const endpoints = providerEndpointEntries(provider);
  if (endpoints.length === 1) {
    return [{
      executionMode,
      endpointId: endpoints[0].id,
      remoteModelId: model.id,
      status: "available",
      source: "static",
    }];
  }

  return [{
    executionMode,
    remoteModelId: model.id,
    status: "unknown",
    source: "legacy_unknown",
  }];
}

export function modelAvailability(provider: Provider, model: ProviderModel): ProviderModelAvailability[] {
  return model.availability?.length ? model.availability : legacyAvailability(provider, model);
}

export function resolveModelRoute(provider: Provider, modelId: string, adapter: Pick<AgentAdapter, "id" | "supportedTypes">): ResolvedModelRoute {
  const model = provider.models.find(candidate => candidate.id === modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);

  const executionMode = providerExecutionMode(provider);
  const allAvailability = modelAvailability(provider, model);
  const availability = allAvailability
    .filter(item => item.status === "available" || item.status === "unknown");

  if (executionMode === "agent_native") {
    if (!provider.nativeAgentIds?.includes(adapter.id)) {
      throw new Error(`${provider.name} 仅支持原生 Agent：${provider.nativeAgentIds?.join(", ") || "未配置"}`);
    }
    const native = availability.find(item =>
      item.executionMode === "agent_native"
      && (!item.nativeAgentIds?.length || item.nativeAgentIds.includes(adapter.id)),
    );
    if (!native) throw new Error(`${modelId} 当前不可用于 ${adapter.id}`);
    return {
      executionMode,
      provider: { ...provider, endpoints: undefined },
      model,
      remoteModelId: native.remoteModelId,
    };
  }

  const endpoints = providerEndpointEntries(provider);
  const byId = new Map(endpoints.map(entry => [entry.id, entry.endpoint]));
  const hasRecordedEndpointSource = allAvailability.some(item =>
    item.executionMode === "http_endpoint"
    && Boolean(item.endpointId)
    && item.source !== "legacy_unknown",
  );
  const explicit = availability.find(item => {
    if (item.executionMode !== "http_endpoint" || !item.endpointId) return false;
    const endpoint = byId.get(item.endpointId);
    return endpoint ? adapter.supportedTypes.includes(endpoint.type) : false;
  });
  // A discovered/manual availability record is the source of truth. Falling
  // back to another protocol endpoint would claim the model exists somewhere
  // it was never observed. Only legacy records without an endpoint may use a
  // compatibility fallback until the provider is synchronized once.
  const fallback = hasRecordedEndpointSource
    ? undefined
    : endpoints.find(({ endpoint }) => adapter.supportedTypes.includes(endpoint.type));
  const selectedEndpointId = explicit?.endpointId || fallback?.id;
  const selectedEndpoint = selectedEndpointId ? byId.get(selectedEndpointId) : undefined;
  if (!selectedEndpoint || !selectedEndpointId) {
    throw new Error(`${provider.name} 没有适用于 ${adapter.id} 的模型来源端点`);
  }

  const remoteModelId = explicit?.remoteModelId || model.id;
  return {
    executionMode,
    endpointId: selectedEndpointId,
    model,
    remoteModelId,
    provider: {
      ...provider,
      type: selectedEndpoint.type as ProviderType,
      baseUrl: selectedEndpoint.baseUrl,
      endpoints: [{ ...selectedEndpoint, id: selectedEndpointId }],
      models: provider.models.map(candidate => candidate.id === model.id
        ? { ...candidate, id: remoteModelId }
        : candidate),
    },
  };
}

/**
 * Merge model facts in the only permitted order. Callers pass the profile
 * facts (for example a vendor-specific Codex limit) and explicitly saved user
 * overrides; a model's models.dev metadata is already attached as `meta`.
 * This makes adapters independent of display-only model arrays.
 */
export function resolveModel(
  provider: Provider,
  modelId: string,
  profile: Partial<ResolvedModel> = {},
  override: Partial<ResolvedModel> = {},
): ResolvedModel {
  const model = provider.models.find(candidate => candidate.id === modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);
  const catalog = model.meta;
  const base: ResolvedModel = {
    id: model.id,
    name: model.name || model.id,
    ...(catalog?.description ? { description: catalog.description } : {}),
    ...(catalog?.family ? { family: catalog.family } : {}),
    ...(Number.isFinite(catalog?.context) ? { context: catalog!.context } : {}),
    ...(Number.isFinite(catalog?.input) ? { input: catalog!.input } : {}),
    ...(Number.isFinite(catalog?.output) ? { output: catalog!.output } : {}),
    modalities: {
      input: catalog?.modalities?.input || (catalog?.attachment ? ["text", "image"] : []),
      output: catalog?.modalities?.output || [],
    },
    ...(catalog?.toolCall === undefined ? {} : { tool: catalog.toolCall }),
    ...(catalog?.reasoning === undefined ? {} : { reasoning: catalog.reasoning }),
    ...(catalog?.reasoningOptions ? { reasoningOptions: catalog.reasoningOptions } : {}),
    ...(catalog?.structuredOutput === undefined ? {} : { structuredOutput: catalog.structuredOutput }),
    ...(catalog?.temperature === undefined ? {} : { temperature: catalog.temperature }),
    ...(catalog?.interleaved ? { interleaved: catalog.interleaved } : {}),
    ...(catalog?.knowledge ? { knowledge: catalog.knowledge } : {}),
    ...(catalog?.releaseDate ? { releaseDate: catalog.releaseDate } : {}),
    ...(catalog?.lastUpdated ? { lastUpdated: catalog.lastUpdated } : {}),
    ...(catalog?.openWeights === undefined ? {} : { openWeights: catalog.openWeights }),
    ...(catalog?.status ? { status: catalog.status } : {}),
    ...(catalog?.cost ? { cost: catalog.cost } : {}),
    ...(catalog?.providerConfig ? { providerConfig: catalog.providerConfig } : {}),
    ...(catalog?.experimental ? { experimental: catalog.experimental } : {}),
    source: catalog?.source === "modelsdev" || catalog?.source === "remote" ? catalog.source : "default",
    confidence: catalog?.source === "modelsdev" ? "high" : catalog?.source === "remote" ? "medium" : "low",
  };
  return {
    ...base,
    ...profile,
    ...override,
    modalities: {
      ...base.modalities,
      ...(profile.modalities || {}),
      ...(override.modalities || {}),
    },
  };
}
