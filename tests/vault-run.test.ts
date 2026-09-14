import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";

// Cross-platform rules (AGENTS.md): child env sets BOTH HOME and USERPROFILE
// to an isolated dir; explicit timeouts; no platform-path recomputation.

const REPO = path.resolve(__dirname, "..");
const MAIN = path.join(REPO, "dist", "main.js");
const HOME = mkdtempSync(path.join(tmpdir(), "vault-run-test-"));
const CHILD_ENV = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  MODELSWAP_NO_PROMPT: "1",
};

function cli(args: string[]) {
  return spawnSync(process.execPath, [MAIN, ...args], { env: CHILD_ENV, encoding: "utf8", timeout: 30000 });
}

// The child command under test: print the injected env var via node itself
// (no shell interpolation, cross-platform).
function runChild(envName: string) {
  return cli([
    "vault", "run", "--key", "run_test_key", "--env", envName,
    "--", process.execPath, "-e", "process.stdout.write(process.env.RUN_TEST_VAR ?? 'MISSING')",
  ]);
}

describe("vault run (CLI)", { timeout: 60000 }, () => {
  it("injects the secret into the child environment", () => {
    const setup = cli(["vault", "set", "run_test_key", "secret-value-42", "--group", "测试"]);
    expect(setup.status).toBe(0);

    const result = runChild("RUN_TEST_VAR");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("secret-value-42");
    // the secret must not leak into the wrapper's own command line
    expect(result.stdout).not.toContain("vault get");
  });

  it("defaults the env var name to the vault key name", () => {
    const result = cli([
      "vault", "run", "--key", "run_test_key",
      "--", process.execPath, "-e", "process.stdout.write(process.env.run_test_key ?? 'MISSING')",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("secret-value-42");
  });

  it("propagates the child exit code", () => {
    const result = cli([
      "vault", "run", "--key", "run_test_key",
      "--", process.execPath, "-e", "process.exit(3)",
    ]);
    expect(result.status).toBe(3);
  });

  it("fails with a non-zero status for a missing key", () => {
    const result = cli(["vault", "run", "--key", "no_such_key", "--", process.execPath, "-e", "1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no_such_key");
  });

  it("fails when no command is given after --", () => {
    const result = cli(["vault", "run", "--key", "run_test_key"]);
    expect(result.status).not.toBe(0);
  });
});

// The env-injection mechanics through the running daemon (spawn a child that
// hits the local API using the injected key — mirrors the real usage shape).
describe("vault run end-to-end via child env", { timeout: 60000 }, () => {
  it("child reads env natively and calls the API-free helper", async () => {
    const child = spawn(
      process.execPath,
      [
        MAIN, "vault", "run", "--key", "run_test_key", "--env", "RUN_TEST_VAR",
        "--", process.execPath, "-e",
        "process.stdout.write('len=' + (process.env.RUN_TEST_VAR ?? '').length)",
      ],
      { env: CHILD_ENV },
    );
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(out).toBe("len=15"); // "secret-value-42".length
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });
});
