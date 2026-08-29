import os from "os";
import path from "path";
import kleur from "kleur";
import prompts from "prompts";
import { loadUserConfig } from "../config/user";

/**
 * `okit sync` — CLI surface for the sync stack (previously web-only config).
 *
 * Everything reuses the same core as the web console (cloud-sync-core), so
 * CLI and Web operate on identical state. Secrets stay out of shell history:
 * passwords/sync codes read via --stdin or a hidden prompt.
 */

// src/ first (ts-node), dist/ fallback (compiled) — same pattern as the
// web api modules use for the TS registry.
let _core: any;
function core(): any {
  if (!_core) {
    try {
      _core = require("../web/api/cloud-sync-core");
    } catch {
      _core = require("../../dist/web/api/cloud-sync-core");
    }
  }
  return _core;
}

type FieldDef = { key: string; label: string; secret?: boolean; optional?: boolean };

// Cloud platforms and the fields their console forms ask for. Values that
// look like ALL_CAPS_UNDERSCORE are treated as vault key references by the
// sync core — users may enter either a literal credential or a vault key.
const PLATFORM_FIELDS: Record<string, FieldDef[]> = {
  supabase: [
    { key: "projectId", label: "Project ID" },
    { key: "apiKey", label: "API Key（可填 vault 密钥名）", secret: true },
  ],
  "cloudflare-kv": [
    { key: "apiToken", label: "API Token（可填 vault 密钥名）", secret: true },
    { key: "storeId", label: "Namespace ID" },
  ],
  cloudflare: [
    { key: "apiToken", label: "API Token（可填 vault 密钥名）", secret: true },
    { key: "storeId", label: "Namespace ID" },
  ],
  "cloudflare-d1": [
    { key: "apiToken", label: "API Token（可填 vault 密钥名）", secret: true },
    { key: "databaseId", label: "Database ID" },
    { key: "tableName", label: "表名（默认 okit_sync）", optional: true },
  ],
  "cloudflare-r2": [
    { key: "accountId", label: "Account ID" },
    { key: "r2AccessKeyId", label: "R2 Access Key ID", secret: true },
    { key: "r2SecretAccessKey", label: "R2 Secret Access Key", secret: true },
    { key: "bucketName", label: "Bucket 名称" },
  ],
  volcengine: [
    { key: "accessKey", label: "Access Key ID", secret: true },
    { key: "secretKey", label: "Secret Access Key", secret: true },
    { key: "region", label: "区域（默认 cn-beijing）", optional: true },
  ],
  webdav: [
    { key: "url", label: "WebDAV 地址 (https://…)" },
    { key: "username", label: "用户名" },
    { key: "password", label: "密码（可填 vault 密钥名）", secret: true },
  ],
  icloud: [],
};

const PLATFORM_LABELS: Record<string, string> = {
  supabase: "Supabase",
  "cloudflare-kv": "Cloudflare KV",
  cloudflare: "Cloudflare Workers KV",
  "cloudflare-d1": "Cloudflare D1",
  "cloudflare-r2": "Cloudflare R2",
  volcengine: "火山引擎",
  webdav: "WebDAV",
  icloud: "iCloud",
};

export function supportedPlatforms(): string[] {
  return Object.keys(PLATFORM_FIELDS);
}

async function readStdinLine(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}

function mask(value: string | undefined): string {
  return value ? "已设置 (***)" : "未设置";
}

/** `okit sync` — status overview. */
export async function syncStatus(options?: { test?: boolean }): Promise<void> {
  const config = await loadUserConfig();
  const sync = config.sync || ({} as any);
  console.log(kleur.cyan("\nOKIT 同步状态\n"));
  console.log(`  同步密码: ${mask(sync.password)}`);
  console.log(`  自动同步: ${sync.autoSync ? kleur.green("开启（改动推送 + 定时拉取）") : "关闭"}`);
  const lan = sync.lan || ({} as any);
  console.log(`  局域网同步: ${lan.enabled ? kleur.green(`开启（端口 ${lan.port || 3790}）`) : "关闭"}`);

  const platforms = Object.entries(sync.platforms || {}) as [string, any][];
  if (platforms.length === 0) {
    console.log(kleur.gray("\n  尚未配置任何云平台。运行 okit sync enable <platform> 添加。"));
  } else {
    console.log(kleur.cyan("\n  云端平台:"));
    for (const [id, plat] of platforms) {
      const label = PLATFORM_LABELS[id] || id;
      if (!plat?.enabled) {
        console.log(`    ${kleur.gray("○")} ${label} — 已停用（配置保留）`);
        continue;
      }
      let extra = "";
      if (options?.test) {
        extra = await testOneQuiet(id);
      }
      console.log(`    ${kleur.green("●")} ${label}${extra}`);
    }
  }
  console.log();
}

async function testOneQuiet(platform: string): Promise<string> {
  try {
    const result = await core().testConnection(platform);
    return kleur.green(` — 连接正常 (${result})`);
  } catch (error: any) {
    return kleur.red(` — 连接失败: ${error.message}`);
  }
}

/** `okit sync password [--stdin]` */
export async function syncPassword(options?: { stdin?: boolean }): Promise<void> {
  let password: string;
  if (options?.stdin) {
    password = await readStdinLine();
  } else {
    const res = await prompts({ type: "password", name: "p", message: "设置同步密码（多台机器必须一致，不可找回）" });
    const confirm = await prompts({ type: "password", name: "p", message: "再次输入确认" });
    if (!res.p || res.p !== confirm.p) {
      console.error(kleur.red("✗ 两次输入不一致或为空"));
      process.exitCode = 1;
      return;
    }
    password = res.p;
  }
  if (!password) {
    console.error(kleur.red("✗ 密码不能为空"));
    process.exitCode = 1;
    return;
  }
  await core().setSyncSetting("password", password);
  console.log(kleur.green("✓ 同步密码已保存（用于云端加密与跨机解密）"));
}

/** `okit sync enable <platform> [--set K=V ...] [--no-test]` */
export async function syncEnable(
  platform: string,
  options?: { set?: string[]; test?: boolean },
): Promise<void> {
  const fields = PLATFORM_FIELDS[platform];
  if (!fields) {
    console.error(kleur.red(`✗ 未知平台: ${platform}`));
    console.error(kleur.gray(`  可选: ${Object.keys(PLATFORM_FIELDS).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const config = await loadUserConfig();
  const existing = (config.sync?.platforms as any)?.[platform] || {};

  const values: Record<string, string> = { ...existing };
  for (const kv of options?.set || []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      console.error(kleur.red(`✗ --set 格式应为 KEY=VALUE: ${kv}`));
      process.exitCode = 1;
      return;
    }
    values[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  // Interactive fill for anything still missing (skipped when stdin is not a
  // TTY so agents/CI can drive this with --set only).
  for (const field of fields) {
    if (values[field.key] !== undefined && values[field.key] !== "") continue;
    if (!process.stdin.isTTY) continue;
    const res = await prompts({
      type: field.secret ? "password" : "text",
      name: "v",
      message: `${field.label}${field.optional ? "（可留空）" : ""}`,
    });
    if (res.v !== undefined && res.v !== "") values[field.key] = String(res.v);
  }

  const missing = fields.filter(f => !f.optional && !values[f.key]);
  if (missing.length > 0) {
    console.error(kleur.red(`✗ 缺少必填字段: ${missing.map(f => f.key).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  for (const [field, value] of Object.entries({ ...values, enabled: true })) await core().setSyncPlatformField(platform, field, value);
  console.log(kleur.green(`✓ ${PLATFORM_LABELS[platform] || platform} 已配置并启用`));

  if (options?.test !== false) {
    const config2 = await loadUserConfig();
    if (!config2.sync?.password) {
      console.log(kleur.yellow("  ⚠ 尚未设置同步密码 — 运行 okit sync password 后才能推送/拉取"));
    }
    process.stdout.write(kleur.gray("  测试连接… "));
    const extra = await testOneQuiet(platform);
    console.log(extra.trim());
  }
}

/** `okit sync disable <platform>` */
export async function syncDisable(platform: string): Promise<void> {
  const config = await loadUserConfig();
  const existing = (config.sync?.platforms as any)?.[platform];
  if (!existing) {
    console.error(kleur.red(`✗ 平台未配置: ${platform}`));
    process.exitCode = 1;
    return;
  }
  await core().setSyncPlatformField(platform, "enabled", false);
  console.log(kleur.green(`✓ ${PLATFORM_LABELS[platform] || platform} 已停用（配置保留，可随时重新 enable）`));
}

/** `okit sync test [platform]` */
export async function syncTest(platform?: string): Promise<void> {
  if (platform) {
    console.log(kleur.gray(`测试 ${PLATFORM_LABELS[platform] || platform} …`));
    const extra = await testOneQuiet(platform);
    console.log(`  ${extra.trim()}`);
    return;
  }
  await syncStatus({ test: true });
}

/** `okit sync push` */
export async function syncPush(): Promise<void> {
  try {
    const result = await core().syncPush();
    console.log(kleur.green(`✓ 推送完成：${result.secrets} 个密钥 → ${result.platforms.join("、")}`));
  } catch (error: any) {
    console.error(kleur.red(`✗ 推送失败: ${error.message}`));
    process.exitCode = 1;
  }
}

/** `okit sync pull` */
export async function syncPull(): Promise<void> {
  try {
    const result = await core().syncPull();
    const parts = [`+${result.secrets} 密钥`];
    if (result.providers !== undefined) parts.push(`providers:${result.providers}`);
    if (result.agentApplied === false) parts.push(kleur.gray("Agent 配置保留本地"));
    console.log(kleur.green(`✓ 拉取完成：${parts.join(" · ")}`));
  } catch (error: any) {
    console.error(kleur.red(`✗ 拉取失败: ${error.message}`));
    process.exitCode = 1;
  }
}

/**
 * `okit sync export [--stdin]` — one-time encrypted code carrying the primary
 * platform's config (+ vault key references). Enter it on another machine
 * with `okit sync import` for zero-typing migration.
 */
export async function syncExport(options?: { stdin?: boolean }): Promise<void> {
  const config = await loadUserConfig();
  let password: string | undefined = config.sync?.password;
  if (options?.stdin) {
    password = await readStdinLine();
  } else if (!password) {
    const res = await prompts({ type: "password", name: "p", message: "同步密码（用于加密同步码）" });
    password = res.p;
  }
  try {
    const result = await core().exportSyncCode(password);
    console.log(kleur.green(`✓ 同步码已生成（平台: ${result.platform}，含 ${result.secrets} 个密钥引用）`));
    console.log(kleur.gray("  在另一台机器运行: okit sync import --stdin，然后粘贴此码\n"));
    process.stdout.write(`${result.code}\n`);
  } catch (error: any) {
    console.error(kleur.red(`✗ 导出失败: ${error.message}`));
    process.exitCode = 1;
  }
}

/** `okit sync import [--code <c>] [--stdin]` */
export async function syncImport(options?: { code?: string; stdin?: boolean }): Promise<void> {
  let code = options?.code;
  if (!code && options?.stdin) code = await readStdinLine();
  if (!code && process.stdin.isTTY) {
    const res = await prompts({ type: "text", name: "c", message: "粘贴同步码" });
    code = res.c;
  }
  if (!code) {
    console.error(kleur.red("✗ 缺少同步码（--code、--stdin 或交互粘贴）"));
    process.exitCode = 1;
    return;
  }

  const config = await loadUserConfig();
  let password: string | undefined = config.sync?.password;
  if (!password) {
    const res = await prompts({ type: "password", name: "p", message: "同步密码（生成此码时的密码）" });
    password = res.p;
  }
  try {
    const result = await core().importSyncCode(code.trim(), password);
    console.log(kleur.green(`✓ 已导入平台配置: ${result.syncPlatform || "ok"}（密钥引用 ${result.secrets ?? result.importedSecrets ?? ""}）`));
    console.log(kleur.gray("  运行 okit sync test 验证连接，okit sync pull 拉取数据"));
  } catch (error: any) {
    console.error(kleur.red(`✗ 导入失败（同步码无效或密码不匹配）: ${error.message}`));
    process.exitCode = 1;
  }
}

/**
 * LAN pairing needs the local OKIT server running (it owns the 3790
 * listener), so this shells through the local HTTP API.
 */
async function localApi(pathName: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://localhost:3780${pathName}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** `okit sync pair --create` / `okit sync pair --code <连接码>` */
export async function syncPair(options?: { create?: boolean; code?: string }): Promise<void> {
  if (!options?.create && !options?.code) {
    console.error(kleur.red("✗ 用法: okit sync pair --create（生成配对码）或 okit sync pair --code <连接码>（加入对方）"));
    process.exitCode = 1;
    return;
  }
  if (options.create) {
    try {
      const data = await localApi("/api/sync/lan/pairing");
      const codes: { address: string; code: string }[] = data.codes || [];
      if (!data.active && codes.length === 0) {
        // Not enabled yet — create one via POST (requires LAN sync enabled).
        const created = await localApi("/api/sync/lan/pairing", {});
        codes.push(...(created.codes || []));
        console.log(kleur.green(`✓ 配对码已生成，有效期至 ${created.expiresAt || "5 分钟内"}`));
      } else {
        console.log(kleur.green(`✓ 配对码生效中，过期时间 ${data.expiresAt}`));
      }
      console.log(kleur.gray("  把对应网卡的连接码给另一台机器:\n"));
      for (const c of codes) {
        console.log(`    ${kleur.gray(c.address)}  ${c.code}`);
      }
      console.log(kleur.gray("\n  对方运行: okit sync pair --code <连接码>"));
    } catch (error: any) {
      console.error(kleur.red(`✗ 生成配对码失败: ${error.message}`));
      console.error(kleur.gray("  点对点同步需要 OKIT 服务在运行（okit web）且已开启局域网同步（设置 → 设备同步）。"));
      process.exitCode = 1;
    }
    return;
  }

  // Redeem on this machine — pairs to the peer that generated the code.
  try {
    const data = await localApi("/api/sync/lan/pair", { code: options.code });
    console.log(kleur.green(`✓ 配对成功${data.peer ? `（对方: ${data.peer}）` : ""}`));
  } catch (error: any) {
    console.error(kleur.red(`✗ 配对失败: ${error.message}`));
    console.error(kleur.gray("  确认对方机器的 OKIT 正在运行，且连接码在有效期内（单次使用，5 分钟过期）。"));
    process.exitCode = 1;
  }
}
