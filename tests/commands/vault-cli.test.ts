import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Exercises the real commander wiring end to end: each case spawns a child
// node with ts-node against an isolated HOME (both HOME and USERPROFILE —
// Windows os.homedir() reads USERPROFILE). Cold ts-node compilation can
// exceed vitest's default timeout.
describe("vault CLI metadata commands", { timeout: 60000 }, () => {
  const root = path.resolve(__dirname, "../..");
  const run = (home: string, args: string[], input?: string): string => execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", path.join(root, "src/main.ts"), ...args],
    { env: { ...process.env, HOME: home, USERPROFILE: home, MODELSWAP_NO_PROMPT: "1" }, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] },
  );

  function newHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "modelswap-vault-cli-"));
    fs.mkdirSync(home, { recursive: true });
    return home;
  }

  it("set with --group/--desc round-trips through list --json, normalized", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "v1", "--group", "搜索引擎数据源", "--desc", "Bing Webmaster API Key"]);
    const list = JSON.parse(run(home, ["vault", "list", "--json"]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "BING_API_KEY", group: "搜索引擎数据源", description: "Bing Webmaster API Key" });
  });

  it("re-set without --group/--desc preserves existing metadata", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "v1", "--group", "搜索引擎数据源", "--desc", "bing"]);
    run(home, ["vault", "set", "BING_API_KEY", "v2"]);
    const list = JSON.parse(run(home, ["vault", "list", "--json"]));
    expect(list[0]).toMatchObject({ key: "BING_API_KEY", group: "搜索引擎数据源", description: "bing" });
    // The rotated value reached the store (masked output is value-derived).
    expect(list[0].masked).not.toContain("v1");
  });

  it("set normalizes alias groups through the shared group-meta module", () => {
    const home = newHome();
    run(home, ["vault", "set", "SOMETHING_ELSE", "v1", "--group", "StepFun"]);
    const list = JSON.parse(run(home, ["vault", "list", "--json"]));
    expect(list[0].group).toBe("阶跃星辰");
  });

  it("mv renames keeping metadata and removes the old key", () => {
    const home = newHome();
    run(home, ["vault", "set", "OLD_KEY", "secret-value", "--group", "搜索引擎数据源", "--desc", "note"]);
    run(home, ["vault", "mv", "OLD_KEY", "NEW_KEY"]);
    const list = JSON.parse(run(home, ["vault", "list", "--json"]));
    expect(list.map((s: { key: string }) => s.key)).toEqual(["NEW_KEY"]);
    expect(list[0]).toMatchObject({ group: "搜索引擎数据源", description: "note" });
    expect(run(home, ["vault", "get", "NEW_KEY"], "")).toBe("secret-value");
  });

  it("mv refuses an existing target", () => {
    const home = newHome();
    run(home, ["vault", "set", "A_KEY", "1"]);
    run(home, ["vault", "set", "B_KEY", "2"]);
    expect(() => run(home, ["vault", "mv", "A_KEY", "B_KEY"])).toThrow(/B_KEY/);
  });

  it("groups lists distinct groups with counts, json supported", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "1", "--group", "搜索引擎数据源"]);
    run(home, ["vault", "set", "GSC_OAUTH", "1", "--group", "搜索引擎数据源"]);
    run(home, ["vault", "set", "FEISHU_APP", "1", "--group", "飞书开放平台"]);
    run(home, ["vault", "set", "UNGROUPED", "1"]);
    const groups = JSON.parse(run(home, ["vault", "groups", "--json"]));
    expect(groups).toContainEqual({ group: "搜索引擎数据源", count: 2 });
    expect(groups).toContainEqual({ group: "飞书开放平台", count: 1 });
    expect(groups.some((g: { group: string }) => g.group === "")).toBe(false);
  });

  it("search matches key, desc and group; json supported", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "1", "--group", "搜索引擎数据源", "--desc", "Bing Webmaster API Key"]);
    run(home, ["vault", "set", "FEISHU_APP", "1", "--group", "飞书开放平台"]);
    expect(JSON.parse(run(home, ["vault", "search", "bing", "--json"]))[0].key).toBe("BING_API_KEY");
    expect(JSON.parse(run(home, ["vault", "search", "webmaster", "--json"]))[0].key).toBe("BING_API_KEY");
    expect(JSON.parse(run(home, ["vault", "search", "飞书", "--json"]))[0].key).toBe("FEISHU_APP");
    expect(JSON.parse(run(home, ["vault", "search", "no-such-thing", "--json"]))).toEqual([]);
  });

  it("list --group filters by normalized group", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "1", "--group", "搜索引擎数据源"]);
    run(home, ["vault", "set", "FEISHU_APP", "1", "--group", "飞书开放平台"]);
    const list = JSON.parse(run(home, ["vault", "list", "--group", "搜索引擎数据源", "--json"]));
    expect(list.map((s: { key: string }) => s.key)).toEqual(["BING_API_KEY"]);
  });

  it("inject --group exports every key of the group", () => {
    const home = newHome();
    run(home, ["vault", "set", "BING_API_KEY", "b-value", "--group", "搜索引擎数据源"]);
    run(home, ["vault", "set", "GSC_OAUTH", "g-value", "--group", "搜索引擎数据源"]);
    run(home, ["vault", "set", "FEISHU_APP", "f-value", "--group", "飞书开放平台"]);
    const out = run(home, ["vault", "inject", "--group", "搜索引擎数据源"]);
    expect(out).toContain("export BING_API_KEY='b-value'");
    expect(out).toContain("export GSC_OAUTH='g-value'");
    expect(out).not.toContain("FEISHU_APP");
  });
});
