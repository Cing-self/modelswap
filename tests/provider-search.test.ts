import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";

// Cross-platform rules (AGENTS.md): isolated HOME for both HOME and
// USERPROFILE; explicit timeouts; presets auto-initialize on first load.

const REPO = path.resolve(__dirname, "..");
const MAIN = path.join(REPO, "dist", "main.js");
const HOME = mkdtempSync(path.join(tmpdir(), "provider-search-test-"));
const CHILD_ENV = { ...process.env, HOME, USERPROFILE: HOME, MODELSWAP_NO_PROMPT: "1" };

function cli(args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: CHILD_ENV, encoding: "utf8", timeout: 30000 });
}

describe("provider search (CLI)", { timeout: 60000 }, () => {
  it("finds a model across platforms with auth state (--json)", () => {
    const result = cli(["provider", "search", "glm", "--json"]);
    expect(result.status).toBe(0);
    const hits = JSON.parse(result.stdout);
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    // presets must be present: zai (智谱) ships glm-family models
    const providers = new Set(hits.map((h: { providerId: string }) => h.providerId));
    expect(providers.has("zai")).toBe(true);
    for (const hit of hits) {
      expect(hit).toHaveProperty("providerId");
      expect(hit).toHaveProperty("modelId");
      expect(typeof hit.hasApiKey).toBe("boolean");
    }
  });

  it("matches provider names too, not just model ids", () => {
    const result = cli(["provider", "search", "deepseek", "--json"]);
    expect(result.status).toBe(0);
    const hits = JSON.parse(result.stdout);
    expect(hits.some((h: { providerId: string }) => h.providerId === "deepseek")).toBe(true);
  });

  it("fails gracefully on an empty query", () => {
    const result = cli(["provider", "search", ""]);
    expect(result.status).not.toBe(0);
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
