import mappingJson from "./codex.json";
import { ResolvedModel } from "../types";

export const codexMapping = mappingJson;

type ReasoningLevel = { effort: string; description: string };

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function getCodexReasoningLevels(model?: Partial<ResolvedModel>): ReasoningLevel[] {
  const reasoning = codexMapping.modelMapping.reasoning;
  const accepted = new Set(codexMapping.officialModelSupport.runtimeCatalog.acceptedMappedReasoningEfforts);
  const options = model?.reasoningOptions || [];
  const effortValues = options
    .filter(option => option.type === "effort")
    .flatMap(option => option.values || [])
    .filter(value => accepted.has(value));
  const hasToggle = options.some(option => option.type === "toggle");
  const hasBudget = options.some(option => option.type === "budget_tokens");

  let efforts: string[];
  if (effortValues.length) efforts = effortValues;
  else if (hasToggle) efforts = [reasoning.toggle.off, reasoning.toggle.on];
  else if (hasBudget) efforts = [reasoning.budgetTokens.off, reasoning.budgetTokens.on];
  else if (model?.reasoning === false) efforts = reasoning.fallbackWhenReasoningFalse;
  else if (model?.reasoning === true) efforts = reasoning.fallbackWhenReasoningTrue;
  else efforts = reasoning.fallbackWhenUnknown;

  return unique(efforts).map(effort => ({
    effort,
    description: reasoning.descriptions[effort as keyof typeof reasoning.descriptions] || effort,
  }));
}

export function getCodexDefaultReasoningLevel(model?: Partial<ResolvedModel>): string {
  const supported = new Set(getCodexReasoningLevels(model).map(item => item.effort));
  return codexMapping.modelMapping.reasoning.preferredDefaultOrder.find(level => supported.has(level))
    || [...supported][0]
    || "none";
}

export function getCodexConfigReasoningEffort(model?: Partial<ResolvedModel>): string | null {
  const level = getCodexDefaultReasoningLevel(model);
  const documented = new Set(codexMapping.officialModelSupport.configToml.model_reasoning_effort.values);
  return documented.has(level) ? level : null;
}

const CODEX_INPUT_MODALITIES = new Set(["text", "image", "audio"]);

export function codexInputModalities(input?: string[]): string[] {
  // Codex parses input_modalities as a closed enum (text | image | audio);
  // upstream lists carrying video/pdf variants make the entire catalog fail
  // to load, so keep only the members Codex accepts.
  const list = (input || []).filter(modality => CODEX_INPUT_MODALITIES.has(modality));
  return list.length ? list : ["text"];
}

export function mapModelToCodexCatalog(input: {
  model: Partial<ResolvedModel> & { id: string; name?: string };
  providerName: string;
  priority: number;
  contextOverride?: number;
}): Record<string, unknown> {
  const { model, providerName, priority, contextOverride } = input;
  const defaults = codexMapping.modelMapping.agentDefaults;
  const contextWindow = model.context || contextOverride || codexMapping.modelMapping.fallbacks.contextWindow;
  const supportedReasoningLevels = getCodexReasoningLevels(model);

  return {
    slug: model.id,
    display_name: model.name || model.id,
    description: model.description || `${providerName} · ${model.name || model.id}`,
    default_reasoning_level: getCodexDefaultReasoningLevel(model),
    supported_reasoning_levels: supportedReasoningLevels,
    shell_type: defaults.shell_type,
    visibility: defaults.visibility,
    supported_in_api: defaults.supported_in_api,
    priority,
    base_instructions: "",
    supports_reasoning_summary_parameter: model.reasoning !== false,
    // Compatibility with older custom-catalog examples still accepted by
    // Codex clients in the field.
    supports_reasoning_summaries: model.reasoning !== false,
    default_reasoning_summary: defaults.default_reasoning_summary,
    support_verbosity: defaults.support_verbosity,
    truncation_policy: defaults.truncation_policy,
    supports_parallel_tool_calls: defaults.supports_parallel_tool_calls,
    supports_image_detail_original: defaults.supports_image_detail_original,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: defaults.effective_context_window_percent,
    experimental_supported_tools: defaults.experimental_supported_tools,
    input_modalities: codexInputModalities(model.modalities?.input),
    supports_search_tool: defaults.supports_search_tool,
  };
}
