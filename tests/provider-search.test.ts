import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";

// Cross-platform rules (AGENTS.md): isolated HOME for both HOME and
// USERPROFILE; explicit timeouts; presets auto-initialize on first load.

const REPO = path.resolve(__dirname, "..");
const MAIN = path.join(REPO, "dist", "main.js");
const HOME = mkdtempSync(path.join(tmpdir(), "provider-search-test-"));
mkdirSync(path.join(HOME, ".modelswap"), { recursive: true });
const CHILD_ENV = { ...process.env, HOME, USERPROFILE: HOME, MODELSWAP_NO_PROMPT: "1" };

function cli(args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: CHILD_ENV, encoding: "utf8", timeout: 30000 });
}

// Presets initialize with empty model lists in a fresh HOME (the catalog
// cache under ~/.modelswap/cache does not exist yet), so seed one provider
// with explicit models — search runs over provider.models.
const MODELS = [
  { id: "glm-5", name: "GLM-5" },
  { id: "glm-5-flash", name: "GLM-5 Flash" },
  { id: "test-sonnet", name: "Test Sonnet" },
];

describe("provider search (CLI)", { timeout: 60000 }, () => {
  it("finds a model across platforms with auth state (--json)", () => {
    writeFileSync(
      path.join(HOME, ".modelswap", "providers.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "search-test",
            name: "Search Test Platform",
            type: "openai",
            baseUrl: "https://example.invalid/v1",
            models: MODELS,
          },
        ],
      }),
    );
    const result = cli(["provider", "search", "glm", "--json"]);
    expect(result.status).toBe(0);
    const hits = JSON.parse(result.stdout);
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    const providers = new Set(hits.map((h: { providerId: string }) => h.providerId));
    expect(providers.has("search-test")).toBe(true);
    for (const hit of hits) {
      expect(hit).toHaveProperty("providerId");
      expect(hit).toHaveProperty("modelId");
      expect(typeof hit.hasApiKey).toBe("boolean");
      expect(["exact", "prefix", "partial"]).toContain(hit.match);
    }
    // query "glm": seeded glm-5 is a series (prefix) hit
    expect(hits[0].modelId).toBe("glm-5");
    expect(hits[0].match).toBe("prefix");
    // query "glm-5": the exact id must be flagged exact and rank first
    const exactResult = cli(["provider", "search", "glm-5", "--json"]);
    const exactHits = JSON.parse(exactResult.stdout);
    expect(exactHits[0].modelId).toBe("glm-5");
    expect(exactHits[0].match).toBe("exact");
  });

  it("matches provider names too, not just model ids", () => {
    const result = cli(["provider", "search", "search-test", "--json"]);
    expect(result.status).toBe(0);
    const hits = JSON.parse(result.stdout);
    expect(hits.some((h: { providerId: string }) => h.providerId === "search-test")).toBe(true);
  });

  it("fails gracefully on an empty query", () => {
    const result = cli(["provider", "search", ""]);
    expect(result.status).not.toBe(0);
  });

  it("--exact returns only exact ids and hints when none match", () => {
    const exact = cli(["provider", "search", "glm-5", "--exact", "--json"]);
    expect(exact.status).toBe(0);
    const exactHits = JSON.parse(exact.stdout);
    expect(exactHits.length).toBeGreaterThan(0);
    for (const h of exactHits) expect(h.match).toBe("exact");

    const none = cli(["provider", "search", "sonnet", "--exact"]); // fuzzy hits exist, exact does not
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("没有精确命中");
  });

  it("reports no-match without failing", () => {
    const result = cli(["provider", "search", "zz-no-such-model-zz"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("没有匹配");
  });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});
