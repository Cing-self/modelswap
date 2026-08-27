import { Provider, ProviderModel, ResolvedModel } from "../types";
import { resolveModel } from "../routing";

/**
 * Adapters must consume the shared resolved model facts. Provider-specific
 * request/auth mapping belongs in an adapter; model context/output guesses do
 * not. Web writes attach user-overridden `resolved` facts before calling an
 * adapter, while CLI writes resolve the cached directory metadata here.
 */
export function modelFacts(provider: Provider, model: ProviderModel | string): ResolvedModel {
  const entry = typeof model === "string"
    ? provider.models.find(candidate => candidate.id === model)
    : model;
  if (!entry) {
    const id = typeof model === "string" ? model : model.id;
    return {
      id,
      name: id,
      modalities: { input: [], output: [] },
      source: "default",
      confidence: "low",
    };
  }
  return entry.resolved || resolveModelFacts(provider, entry.id);
}

/**
 * Resolve the canonical model facts used by both adapter writes and CLI
 * selection. Keeping overrides here prevents either caller from growing a
 * second capability table or a subtly different merge order.
 */
export function resolveModelFacts(
  provider: Provider,
  modelId: string,
  override: Partial<ResolvedModel> = {},
): ResolvedModel {
  return resolveModel(provider, modelId, {}, override);
}

export function modelTokenLimit(provider: Provider, model: ProviderModel | string): { context?: number; output?: number } {
  const facts = modelFacts(provider, model);
  return {
    ...(Number.isFinite(facts.context) ? { context: facts.context } : {}),
    ...(Number.isFinite(facts.output) ? { output: facts.output } : {}),
  };
}
