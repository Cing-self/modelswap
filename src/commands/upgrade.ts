import kleur from "kleur";
import execa from "execa";

export const PACKAGE_NAME = "@cing-self/okit-cli";

export interface UpgradeDeps {
  run: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  exit: (code: number) => void;
  log: (message: string) => void;
  logError: (message: string) => void;
}

const defaultDeps: UpgradeDeps = {
  run: (cmd, args) => execa(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }) as unknown as Promise<{ stdout: string }>,
  exit: (code) => {
    process.exitCode = code;
  },
  log: (message) => console.log(message),
  logError: (message) => console.error(message),
};

/** Compare two dotted versions (e.g. "1.0.0" vs "1.10.1"). Returns <0 / 0 / >0. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const va = norm(a);
  const vb = norm(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function queryLatestVersion(
  deps: UpgradeDeps = defaultDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.run("npm", ["view", PACKAGE_NAME, "version"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function installPackage(
  deps: UpgradeDeps = defaultDeps,
): Promise<boolean> {
  try {
    // install @latest (not `update`) so upgrades can cross major versions.
    await deps.run("npm", ["install", "-g", `${PACKAGE_NAME}@latest`]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logError(kleur.red(`✗ 升级失败: ${message}`));
    return false;
  }
}

export async function upgradeSelf(deps: UpgradeDeps = defaultDeps): Promise<void> {
  deps.log(kleur.cyan("\n⬆️  Upgrading OKIT...\n"));

  let currentVersion = "0.0.0";
  try {
    const pkg = await import("../../package.json");
    currentVersion = pkg.version;
  } catch {
    /* fall through; treated as unknown current version */
  }
  deps.log(kleur.gray(`当前版本: ${currentVersion}`));

  const latestVersion = await queryLatestVersion(deps);
  if (!latestVersion) {
    deps.logError(kleur.red("✗ 无法查询 NPM 最新版本，升级中止"));
    deps.exit(1);
    return;
  }

  // Guard against downgrades: the registry can briefly hold an OLDER version
  // than a local development / pre-release install (e.g. placeholder 0.0.1).
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    deps.log(kleur.green(`✓ 已是最新版本（本地 ${currentVersion} ≥ npm ${latestVersion}）`));
    deps.exit(0);
    return;
  }

  deps.log(kleur.gray(`最新版本: ${latestVersion}`));
  deps.log(kleur.gray(`正在升级 ${PACKAGE_NAME}...`));

  const ok = await installPackage(deps);
  if (!ok) {
    deps.exit(1);
    return;
  }

  deps.log(kleur.green("✓ OKIT 升级成功"));
  deps.exit(0);
}
