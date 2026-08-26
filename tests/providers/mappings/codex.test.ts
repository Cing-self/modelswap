import { describe, expect, it } from "vitest";
import {
  codexMapping,
  getCodexConfigReasoningEffort,
  getCodexReasoningLevels,
  mapModelToCodexCatalog,
} from "../../../src/providers/mappings/codex-mapping";

describe("Codex agent mapping", () => {
  it("records official providers, provider fields, model config and runtime catalog capabilities", () => {
    expect(codexMapping.officialProviderSupport.reservedBuiltIns.map(item => item.id)).toEqual([
      "openai",
      "ollama",
      "lmstudio",
    ]);
    expect(codexMapping.officialProviderSupport.documentedBuiltIns.map(item => item.id)).toContain("amazon-bedrock");
    expect(codexMapping.officialProviderSupport.customProvider.fields).toMatchObject({
      base_url: "string",
      wire_api: "responses",
      "auth.command": "string",
      supports_websockets: "boolean",
    });
    expect(codexMapping.officialModelSupport.configToml).toHaveProperty("model_context_window");
    expect(codexMapping.officialModelSupport.configToml).toHaveProperty("model_reasoning_effort");
    expect(codexMapping.officialModelSupport.runtimeCatalog.observedFields).toEqual(expect.arrayContaining([
      "supported_reasoning_levels",
      "context_window",
      "input_modalities",
      "support_verbosity",
      "truncation_policy",
      "tool_mode",
    ]));
    expect(codexMapping.officialModelSupport.runtimeCatalog.observedOfficialModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-5.6-sol", reasoning: expect.arrayContaining(["max", "ultra"]) }),
      expect.objectContaining({ id: "gpt-5.3-codex-spark", inputModalities: ["text"] }),
    ]));
  });

  it("maps models.dev facts to the Codex catalog without inventing tool support", () => {
    const entry = mapModelToCodexCatalog({
      providerName: "DeepSeek",
      priority: 2,
      model: {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        description: "Reasoning model",
        context: 196608,
        modalities: { input: ["text", "image"], output: ["text"] },
        tool: true,
        reasoning: true,
        reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
    });

    expect(entry).toMatchObject({
      slug: "deepseek-v4-pro",
      display_name: "DeepSeek V4 Pro",
      description: "Reasoning model",
      default_reasoning_level: "high",
      context_window: 196608,
      max_context_window: 196608,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: false,
      supports_reasoning_summary_parameter: true,
    });
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Light reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "Enabled Thinking" },
    ]);
    expect(codexMapping.modelMapping.notMapped.tool).toContain("does not prove");
  });

  it("converts toggle and budget reasoning to the documented lossy on/off profile", () => {
    expect(getCodexReasoningLevels({ reasoning: true, reasoningOptions: [{ type: "toggle" }] })).toEqual([
      { effort: "none", description: "Disable Thinking" },
      { effort: "high", description: "Enabled Thinking" },
    ]);
    expect(getCodexReasoningLevels({ reasoning: true, reasoningOptions: [{ type: "budget_tokens", min: 1024, max: 32768 }] })).toEqual([
      { effort: "none", description: "Disable Thinking" },
      { effort: "high", description: "Enabled Thinking" },
    ]);
  });

  it("only emits a top-level reasoning effort when Codex documents that value", () => {
    expect(getCodexConfigReasoningEffort({
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["max"] }],
    })).toBeNull();
    expect(getCodexConfigReasoningEffort({
      reasoning: true,
      reasoningOptions: [{ type: "effort", values: ["low", "high"] }],
    })).toBe("high");
  });
});
