import {
  Platform,
  PlatformAuthMethod,
  PlatformEndpoint,
  PlatformModel,
  PlatformOffering,
  Provider,
} from "./types";
import { PROVIDER_FAMILIES } from "./metadata";
import { modelAvailability, providerEndpointEntries, providerExecutionMode } from "./routing";

type FamilyDefinition = {
  family: string;
  plans?: {
    label: string;
    providerId: string;
    type?: PlatformOffering["type"];
    entitlement?: PlatformOffering["entitlement"];
  }[];
  ids: string[];
};

function offeringType(label: string, provider: Provider): string {
  if (providerExecutionMode(provider) === "agent_native") return "agent_subscription";
  const endpoints = providerEndpointEntries(provider).map(entry => entry.endpoint);
  const plan = endpoints.find(endpoint => endpoint.plan)?.plan;
  if (plan === "coding") return "coding_plan";
  if (plan === "token") return "token_plan";
  if (plan === "agent") return "agent_plan";
  if (plan === "go") return "go_plan";
  const normalized = label.toLowerCase();
  if (normalized.includes("coding")) return "coding_plan";
  if (normalized.includes("token")) return "token_plan";
  if (normalized.includes("agent") || normalized.includes("oauth")) return "agent_plan";
  if (normalized.includes("go")) return "go_plan";
  return "api";
}

function authMethodsFor(provider: Provider): PlatformAuthMethod[] {
  const methods: PlatformAuthMethod[] = [];
  if (provider.authMode === "api_key" || provider.authMode === "both") {
    methods.push({
      id: `${provider.id}:api-key`,
      type: "api_key",
      label: "API Key",
      providerId: provider.id,
      credentialRef: provider.vaultKey,
      status: provider.vaultKey
        ? provider.authVerified === true && (!provider.authVerifiedKey || provider.authVerifiedKey === provider.vaultKey)
          ? "verified"
          : provider.authVerified === false ? "invalid" : "configured"
        : "unconfigured",
      verifiedAt: provider.authVerifiedAt,
      verifiedEndpointId: provider.authVerifiedEndpointIds?.[0],
    });
  }
  if (provider.authMode === "oauth" || provider.authMode === "both") {
    methods.push({
      id: `${provider.id}:oauth`,
      type: "oauth",
      label: "OAuth",
      providerId: provider.id,
      status: "unconfigured",
    });
  }
  return methods;
}

function buildPlatform(name: string, members: Provider[], family?: FamilyDefinition): Platform {
  const offerings: PlatformOffering[] = [];
  const endpoints: PlatformEndpoint[] = [];
  const authMethods = members.flatMap(authMethodsFor);
  const models = new Map<string, PlatformModel>();

  for (const provider of members) {
    const endpointEntries = providerEndpointEntries(provider);
    const executionMode = providerExecutionMode(provider);
    const plan = family?.plans?.find(item => item.providerId === provider.id);
    const offeringId = provider.id;
    const endpointIds: string[] = [];
    const authMethodIds = authMethods.filter(method => method.providerId === provider.id).map(method => method.id);

    endpointEntries.forEach(({ id: endpointId, endpoint }) => {
      endpointIds.push(endpointId);
      endpoints.push({
        id: endpointId,
        name: `${endpoint.type.toUpperCase()} ${endpoint.protocol || ""}`.trim(),
        offeringId,
        baseUrl: endpoint.baseUrl,
        protocol: {
          family: endpoint.type,
          mode: endpoint.type === "openai"
            ? endpoint.protocol || "chat"
            : endpoint.type === "anthropic" ? "messages" : "generate-content",
        },
        authMethodIds,
        modelDiscovery: { type: "remote", path: "/models" },
      });
    });

    offerings.push({
      id: offeringId,
      type: plan?.type || offeringType(plan?.label || "API", provider),
      label: plan?.label || "API 平台",
      providerId: provider.id,
      endpointIds,
      authMethodIds,
      executionMode,
      nativeAgentIds: executionMode === "agent_native" ? provider.nativeAgentIds : undefined,
      entitlement: plan?.entitlement,
    });

    for (const model of provider.models) {
      const existing = models.get(model.id) || {
        id: model.id,
        name: model.name || model.id,
        capabilities: model.capabilities,
        availability: [],
      };
      for (const availability of modelAvailability(provider, model)) {
        existing.availability.push({
          offeringId,
          endpointIds: availability.endpointId ? [availability.endpointId] : [],
          executionMode: availability.executionMode,
          nativeAgentIds: availability.nativeAgentIds,
          remoteModelId: availability.remoteModelId,
          status: availability.status,
          source: availability.source,
          discoveredAt: availability.discoveredAt,
          lastSeenAt: availability.lastSeenAt,
        });
      }
      models.set(model.id, existing);
    }
  }

  return {
    id: members[0]?.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    providerIds: members.map(member => member.id),
    offerings,
    authMethods,
    endpoints,
    models: Array.from(models.values()),
  };
}

export function buildPlatforms(
  providers: Provider[],
  families: FamilyDefinition[] = PROVIDER_FAMILIES,
): Platform[] {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const assigned = new Set<string>();
  const platforms: Platform[] = [];

  for (const family of families) {
    const members = family.ids.map(id => byId.get(id)).filter((provider): provider is Provider => Boolean(provider));
    if (!members.length) continue;
    members.forEach(member => assigned.add(member.id));
    platforms.push(buildPlatform(family.family, members, family));
  }

  for (const provider of providers) {
    if (!assigned.has(provider.id)) platforms.push(buildPlatform(provider.name, [provider]));
  }

  return platforms;
}
