import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import kleur from "kleur";
import execa from "execa";

export const PACKAGE_NAME = "@cing-self/okit-cli";
const GITHUB_REPO = "Cing-self/okit";

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

/**
 * True when running from the standalone pkg binary (install.sh). In that mode
 * `npm update -g` would silently "succeed" while leaving the old binary in
 * place, so the upgrade must instead download the new release artifact.
 */
export function isBinaryInstall(): boolean {
  return typeof (process as { pkg?: unknown }).pkg !== "undefined" || __dirname.startsWith("/snapshot/");
}

/** Compare two dotted versions (e.g. "2.3.0" vs "2.10.1"). Returns <0 / 0 / >0. */
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

// ─── Standalone-binary self-update ────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "okit-upgrade" };
  const token = process.env.OKIT_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchGithubJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function verifySha256(file: string, checksumFile: string): boolean {
  const expected = fs.readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return actual.toLowerCase() === expected.toLowerCase();
}

async function upgradeBinary(deps: UpgradeDeps = defaultDeps): Promise<void> {
  deps.log(kleur.gray("检测到独立二进制安装 (install.sh)"));

  let currentVersion = "0.0.0";
  try {
    const pkg = await import("../../package.json");
    currentVersion = pkg.version;
  } catch {
    /* fall through; treated as unknown current version */
  }
  deps.log(kleur.gray(`当前版本: ${currentVersion}`));

  if (process.platform !== "darwin") {
    deps.logError(kleur.red(`✗ 独立二进制目前仅发布 macOS 版本，当前平台: ${process.platform}。请改用 npm 安装: npm install -g ${PACKAGE_NAME}`));
    deps.exit(1);
    return;
  }

  const release = await fetchGithubJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  if (!release || typeof release.tag_name !== "string") {
    deps.logError(kleur.red("✗ 无法查询 GitHub 最新 Release（私有仓库请设置 OKIT_GITHUB_TOKEN 环境变量）"));
    deps.exit(1);
    return;
  }
  const tag = release.tag_name;
  const latestVersion = tag.replace(/^v/, "");

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    deps.log(kleur.green("✓ 已是最新版本"));
    deps.exit(0);
    return;
  }
  deps.log(kleur.gray(`最新版本: ${latestVersion}`));

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `okit-${tag}-macos-${arch}.zip`;
  const asset = (release.assets || []).find((a: any) => a && a.name === assetName);
  const zipUrl: string = (asset && asset.browser_download_url) ||
    `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;
  const shaUrl = `${zipUrl}.sha256`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "okit-upgrade-"));
  try {
    const zipPath = path.join(tmpDir, assetName);
    const shaPath = `${zipPath}.sha256`;
    deps.log(kleur.gray(`下载 ${assetName}...`));
    await downloadToFile(zipUrl, zipPath);
    await downloadToFile(shaUrl, shaPath);

    if (!verifySha256(zipPath, shaPath)) {
      throw new Error("SHA256 校验失败 — 下载可能已损坏或被篡改");
    }
    deps.log(kleur.gray("SHA256 校验通过"));

    const unpackDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(unpackDir, { recursive: true });
    await deps.run("unzip", ["-q", zipPath, "-d", unpackDir]);
    const newBinary = path.join(unpackDir, "okit");
    if (!fs.existsSync(newBinary)) {
      throw new Error("解压后未找到 okit 可执行文件");
    }

    // Replace the running executable. Rename keeps the swap atomic on the same
    // filesystem; copyFileSync is the fallback for cross-device staging dirs.
    const execPath = process.execPath;
    const staged = `${execPath}.okit-new`;
    fs.copyFileSync(newBinary, staged);
    fs.chmodSync(staged, 0o755);
    try {
      fs.renameSync(staged, execPath);
    } catch {
      fs.copyFileSync(staged, execPath);
      fs.chmodSync(execPath, 0o755);
      fs.unlinkSync(staged);
    }

    deps.log(kleur.green(`✓ OKIT 已升级到 ${latestVersion}`));
    deps.log(kleur.gray("当前正在运行的实例仍是旧版本，重新运行 okit 即可使用新版本。"));
    deps.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logError(kleur.red(`✗ 二进制升级失败: ${message}`));
    deps.logError(kleur.gray(`可手动重新安装最新版: bash <(curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh)`));
    deps.exit(1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function upgradeSelf(deps: UpgradeDeps = defaultDeps): Promise<void> {
  if (isBinaryInstall()) {
    await upgradeBinary(deps);
    return;
  }

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
