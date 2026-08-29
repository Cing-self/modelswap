import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const provider = {
    id: "gateway", name: "Gateway", type: "openai" as const,
    baseUrl: "https://gateway.example/v1", authMode: "api_key" as const,
    models: [{ id: "canonical", name: "Canonical", meta: {
      source: "modelsdev" as const, confidence: "high" as const,
      context: 200000, output: 8192, reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    } }],
  };
  const routedProvider = { ...provider, baseUrl: "https://gateway.example/routed" };
  const adapter = {
    id: "openclaw", name: "OpenClaw", supportedTypes: ["openai" as const],
    getCurrentConfig: vi.fn(async () => null),
    applyConfig: vi.fn(async () => undefined),
  };
  return { provider, routedProvider, adapter };
});

const prompts = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: prompts }));
vi.mock("../../src/providers/store", () => ({
  loadProviders: vi.fn(async () => [fixture.provider]), addProvider: vi.fn(), deleteProvider: vi.fn(), getProvider: vi.fn(),
}));
vi.mock("../../src/providers/presets", () => ({ PRESET_PROVIDERS: [] }));
vi.mock("../../src/providers/registry", () => ({
  getAdapters: vi.fn(() => [fixture.adapter]), getAdapter: vi.fn(() => fixture.adapter),
}));
vi.mock("../../src/providers/auth", () => ({ checkAuthStatus: vi.fn() }));
const loadUserConfig = vi.fn(async () => ({
  modelOverrides: { gateway: { canonical: { name: "User override", context: 64000 } } },
}));
vi.mock("../../src/config/user", () => ({ loadUserConfig, patchAgentSelection: vi.fn(async () => undefined) }));
vi.mock("../../src/providers/routing", () => ({
  providerSupportsAdapter: vi.fn(() => true),
  resolveModelRoute: vi.fn(() => ({ provider: fixture.routedProvider, remoteModelId: "remote-canonical" })),
}));
vi.mock("../../src/providers/adapters/model-facts", () => ({
  resolveModelFacts: vi.fn((_provider, modelId, override) => ({
    id: modelId, name: "Canonical", context: 200000, output: 8192,
    modalities: { input: ["text", "image"], output: ["text"] }, reasoning: true,
    source: "modelsdev", confidence: "high", ...override,
  })),
}));
vi.mock("../../src/providers/snapshots", () => ({ capturePreSwitchSnapshot: vi.fn(async () => undefined) }));
vi.mock("../../src/vault/store", () => ({ VaultStore: vi.fn() }));

const { providerSwitch, providerUse } = await import("../../src/commands/provider");

beforeEach(() => {
  fixture.adapter.applyConfig.mockClear();
  fixture.adapter.getCurrentConfig.mockClear();
  prompts.mockReset();
});

describe("provider CLI resolved-model propagation", () => {
  it("provider switch passes the same override-resolved facts as the Web path", async () => {
    prompts
      .mockResolvedValueOnce({ provider: "gateway" })
      .mockResolvedValueOnce({ model: "canonical" });

    await providerSwitch("openclaw");

    expect(fixture.adapter.applyConfig).toHaveBeenCalledWith(
      fixture.routedProvider,
      "remote-canonical",
      expect.objectContaining({
        id: "canonical", name: "User override", context: 64000, output: 8192,
        reasoning: true, modalities: { input: ["text", "image"], output: ["text"] },
      }),
      expect.objectContaining({
        canonical: expect.objectContaining({ id: "canonical", name: "User override", context: 64000 }),
      }),
    );
  });

  it("provider use passes the same override-resolved facts and routed model ID", async () => {
    await providerUse("gateway", { agent: "openclaw", model: "canonical" });

    expect(fixture.adapter.applyConfig).toHaveBeenCalledWith(
      fixture.routedProvider,
      "remote-canonical",
      expect.objectContaining({ id: "canonical", name: "User override", context: 64000 }),
      expect.objectContaining({
        canonical: expect.objectContaining({ id: "canonical", name: "User override", context: 64000 }),
      }),
    );
  });
});
