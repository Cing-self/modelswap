import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pkg from "../../package.json";
import {
  PACKAGE_NAME,
  queryLatestVersion,
  installPackage,
  upgradeSelf,
  compareVersions,
  UpgradeDeps,
} from "../../src/commands/upgrade";

// Derive versions from package.json so these tests survive version bumps.
const CURRENT = pkg.version;
const NEWER = (() => {
  const [maj, min, pat] = CURRENT.split(".").map(n => parseInt(n, 10));
  return `${maj}.${min}.${pat + 1}`;
})();

function makeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps & {
  calls: { cmd: string; args: string[] }[];
  logs: string[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const logs: string[] = [];
  const recordRun = overrides.run ?? (async () => ({ stdout: "" }));
  return {
    calls,
    logs,
    run: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return recordRun(cmd, args);
    },
    exit: overrides.exit ?? ((code: number) => {
      process.exitCode = code;
    }),
    log: (m: string) => logs.push(m),
    logError: (m: string) => logs.push(m),
  } as any;
}

describe("modelswap upgrade", () => {
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("uses the scoped npm package name modelswap", () => {
    expect(PACKAGE_NAME).toBe("modelswap");
  });

  it("queryLatestVersion shells out via the npm CLI with the package name", async () => {
    const deps = makeDeps({
      run: async (cmd, args) => ({ stdout: "2.3.0" }),
    });
    const version = await queryLatestVersion(deps);
    expect(version).toBe("2.3.0");
    expect(deps.calls[0]).toEqual({ cmd: "npm", args: ["view", PACKAGE_NAME, "version"] });
  });

  it("queryLatestVersion returns null when npm view fails", async () => {
    const deps = makeDeps({
      run: async () => {
        throw new Error("network down");
      },
    });
    const version = await queryLatestVersion(deps);
    expect(version).toBeNull();
  });

  it("installPackage runs npm install -g with the package name at latest", async () => {
    const deps = makeDeps({
      run: async () => ({ stdout: "" }),
    });
    const ok = await installPackage(deps);
    expect(ok).toBe(true);
    expect(deps.calls[0]).toEqual({ cmd: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] });
  });

  it("installPackage returns false and logs on failure", async () => {
    const deps = makeDeps({
      run: async () => {
        throw new Error("EACCES permission denied");
      },
    });
    const ok = await installPackage(deps);
    expect(ok).toBe(false);
    expect(deps.logs.some((l) => l.includes("升级失败"))).toBe(true);
  });

  it("exits 0 and skips install when already the latest version", async () => {
    const exit = vi.fn();
    const deps = makeDeps({
      run: async () => ({ stdout: CURRENT }),
      exit,
    });
    await upgradeSelf(deps);
    expect(deps.calls.filter((c) => c.cmd === "npm" && c.args[0] === "install").length).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("refuses to downgrade when the registry holds an older version", async () => {
    // The public registry briefly held only a placeholder 0.0.1 — a 2.3.0
    // install must not "upgrade" itself down to it.
    const exit = vi.fn();
    const deps = makeDeps({
      run: async (cmd, args) => {
        if (args[0] === "view") return { stdout: "0.0.1" };
        return { stdout: "" };
      },
      exit,
    });
    await upgradeSelf(deps);
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("installs and exits 0 when a newer version exists", async () => {
    const exit = vi.fn();
    const deps = makeDeps({
      run: async (cmd, args) => {
        if (args[0] === "view") return { stdout: NEWER };
        return { stdout: "" };
      },
      exit,
    });
    await upgradeSelf(deps);
    expect(deps.calls.some((c) => c.args[0] === "install")).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when the version query fails", async () => {
    const exit = vi.fn();
    const deps = makeDeps({
      run: async () => {
        throw new Error("npm view failed");
      },
      exit,
    });
    await upgradeSelf(deps);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when the install fails", async () => {
    const exit = vi.fn();
    const deps = makeDeps({
      run: async (cmd, args) => {
        if (args[0] === "view") return { stdout: NEWER };
        throw new Error("EACCES permission denied");
      },
      exit,
    });
    await upgradeSelf(deps);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("never invokes sudo", async () => {
    const deps = makeDeps({
      run: async (cmd, args) => {
        if (args[0] === "view") return { stdout: NEWER };
        return { stdout: "" };
      },
    });
    await upgradeSelf(deps);
    expect(deps.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  it("compares dotted versions numerically per segment", () => {
    expect(compareVersions("2.3.0", "2.3.0")).toBe(0);
    expect(compareVersions("2.3.1", "2.3.0")).toBeGreaterThan(0);
    expect(compareVersions("2.3.0", "2.10.0")).toBeLessThan(0); // numeric, not lexicographic
    expect(compareVersions("v3.0.0", "2.99.99")).toBeGreaterThan(0);
    expect(compareVersions("2.3", "2.3.0")).toBe(0);
  });
});
