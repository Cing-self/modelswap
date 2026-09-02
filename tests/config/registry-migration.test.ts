import fs from "fs-extra";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// registry.ts resolves ~/.modelswap and ~/.okit at import time, so every
// case installs a fresh temp home, re-spies os.homedir, and re-imports the
// module graph under test. Mocking os.homedir (instead of env vars) keeps
// the resolution platform-independent per the CI cross-platform rules.
describe("legacy ~/.okit migration", { timeout: 15000 }, () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "modelswap-migration-test-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.removeSync(home);
  });

  const seedLegacyOkit = () => {
    const legacy = path.join(home, ".okit");
    fs.ensureDirSync(path.join(legacy, "vault"));
    fs.writeFileSync(path.join(legacy, "vault", "master.key"), "0f1e".repeat(16));
    fs.writeFileSync(path.join(legacy, "vault", "secrets.enc"), "iv:tag:cipher");
    fs.writeJsonSync(path.join(legacy, "providers.json"), { version: 2, providers: [] });
    fs.writeJsonSync(path.join(legacy, "user.json"), { language: "zh" });
    return legacy;
  };

  it("copies legacy data into ~/.modelswap when the new dir is absent", async () => {
    seedLegacyOkit();
    vi.resetModules();
    const { migrateLegacyOkitDir } = await import("../../src/config/registry");
    migrateLegacyOkitDir();

    const next = path.join(home, ".modelswap");
    expect(fs.readFileSync(path.join(next, "vault", "secrets.enc"), "utf-8")).toBe("iv:tag:cipher");
    expect(fs.readJsonSync(path.join(next, "providers.json"))).toEqual({ version: 2, providers: [] });
    // The legacy dir is kept as a backup until the user deletes it manually.
    expect(fs.existsSync(path.join(home, ".okit", "user.json"))).toBe(true);
  });

  it("replaces an untouched v1.0.42 dir (fresh vault key only) with the legacy copy", async () => {
    seedLegacyOkit();
    const next = path.join(home, ".modelswap");
    fs.ensureDirSync(path.join(next, "vault"));
    fs.writeFileSync(path.join(next, "vault", "master.key"), "ab".repeat(32));
    vi.resetModules();
    const { migrateLegacyOkitDir } = await import("../../src/config/registry");
    migrateLegacyOkitDir();

    expect(fs.readFileSync(path.join(next, "vault", "master.key"), "utf-8")).toBe("0f1e".repeat(16));
    expect(fs.existsSync(path.join(next, "providers.json"))).toBe(true);
  });

  it("keeps an existing ~/.modelswap that already holds real data", async () => {
    seedLegacyOkit();
    const next = path.join(home, ".modelswap");
    fs.ensureDirSync(path.join(next, "vault"));
    fs.writeJsonSync(path.join(next, "providers.json"), { version: 2, providers: [{ id: "new" }] });
    vi.resetModules();
    const { migrateLegacyOkitDir } = await import("../../src/config/registry");
    migrateLegacyOkitDir();

    expect(fs.readJsonSync(path.join(next, "providers.json"))).toEqual({
      version: 2,
      providers: [{ id: "new" }],
    });
    expect(fs.existsSync(path.join(next, "vault", "secrets.enc"))).toBe(false);
  });

  it("does nothing without a legacy ~/.okit dir", async () => {
    vi.resetModules();
    const { migrateLegacyOkitDir } = await import("../../src/config/registry");
    migrateLegacyOkitDir();
    expect(fs.existsSync(path.join(home, ".modelswap"))).toBe(false);
  });

  it("runs on boot import so entry points migrate before any store loads", async () => {
    seedLegacyOkit();
    vi.resetModules();
    await import("../../src/config/boot");
    expect(fs.existsSync(path.join(home, ".modelswap", "vault", "secrets.enc"))).toBe(true);
  });

  it("VaultStore constructor migrates before deriving a fresh master key", async () => {
    seedLegacyOkit();
    vi.resetModules();
    const { VaultStore } = await import("../../src/vault/store");
    new VaultStore();
    expect(fs.readFileSync(path.join(home, ".modelswap", "vault", "master.key"), "utf-8")).toBe(
      "0f1e".repeat(16)
    );
  });

  it("ensureModelSwapDir migrates and creates logs/cache dirs", async () => {
    seedLegacyOkit();
    vi.resetModules();
    const { ensureModelSwapDir } = await import("../../src/config/registry");
    await ensureModelSwapDir();
    expect(fs.existsSync(path.join(home, ".modelswap", "logs"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".modelswap", "cache"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".modelswap", "providers.json"))).toBe(true);
  });
});
