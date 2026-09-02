#!/usr/bin/env node

// Keep first: migrates legacy ~/.okit into ~/.modelswap before the command
// modules below construct VaultStore at import time.
import "./config/boot";
import { Command } from "commander";
import kleur from "kleur";
import prompts from "prompts";
import pkg from "../package.json";
import { upgradeSelf } from "./commands/upgrade";
import {
  vaultSet,
  vaultGet,
  vaultList,
  vaultDelete,
  vaultInject,
  vaultEnv,
} from "./commands/vault";
import { setLanguage, getLanguage, t, Language, initLanguage, loadLanguageConfig, saveLanguageConfig } from "./config/i18n";
import { loadUserConfig, setUserPreference } from "./config/user";
import {
  providerList,
  providerCurrent,
  providerSwitch,
  providerUse,
  providerAdd,
  providerDeleteAction,
  providerAuth,
} from "./commands/provider";
import { migrateIfNeeded } from "./providers/migration";
import { installSkill, showSkillPath } from "./commands/skill";
const program = new Command();

// 显示 Banner
function showBanner(): void {
  const banner = `
 ██████╗  ██╗  ██╗  ██╗  ████████╗
██╔═══██╗ ██║ ██╔╝  ██║  ╚══██╔══╝
██║   ██║ █████╔╝   ██║     ██║   
██║   ██║ ██╔═██╗   ██║     ██║   
╚██████╔╝ ██║  ██╗  ██║     ██║   
 ╚═════╝  ╚═╝  ╚═╝  ╚═╝     ╚═╝   
  `;
  console.log(kleur.cyan(banner));
  console.log(kleur.gray(`  MODELSWAP v${pkg.version} - macOS 开发工具管理器\n`));
}

program
  .name("modelswap")
  .description("MODELSWAP - Agent 基础设施管理工具")
  .version(pkg.version);

function getUnknownSubcommand(): string | null {
  const argv = process.argv.slice(2);
  const firstArg = argv.find((arg) => !arg.startsWith("-"));
  if (!firstArg) return null;
  const known = new Set(program.commands.map((cmd) => cmd.name()));
  return known.has(firstArg) ? null : firstArg;
}

// 语言选择（首次运行时显示）
// 非交互环境（管道 / Agent / CI）绝不弹选择框：按环境变量自动判定语言，
// 且不落盘——下次真人交互运行时仍会看到选择器。否则 --json 输出会被
// 交互提示污染，脚本会永久挂起。
function detectLanguageFromEnv(): Language {
  const locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase();
  return locale.includes("zh") ? "zh" : "en";
}

async function selectLanguageIfNeeded(): Promise<void> {
  // 先尝试加载已保存的语言配置
  const savedLang = await loadLanguageConfig();

  if (savedLang) {
    // 已有配置，直接使用
    setLanguage(savedLang);
    return;
  }

  const nonInteractive = !process.stdin.isTTY || process.env.CI || process.env.MODELSWAP_NO_PROMPT;
  if (nonInteractive) {
    setLanguage(detectLanguageFromEnv());
    return;
  }

  // 首次运行，显示语言选择
  const response = await prompts({
    type: "select",
    name: "lang",
    message: "选择语言 / Select language",
    choices: [
      { title: "中文", value: "zh" },
      { title: "English", value: "en" },
    ],
  });

  if (response.lang) {
    setLanguage(response.lang);
    // setLanguage persists fire-and-forget; await the same save so the very
    // next user.json write (first-run hint below) cannot race it and lose
    // the language on a fresh install.
    await saveLanguageConfig(response.lang);
  }
}

// 配置 prompts 使用中文提示
function configurePrompts(lang: Language) {
  if (lang === "zh") {
    // 设置 prompts 的默认提示文本
    (prompts as any).prompts = {
      ...(prompts as any).prompts,
      autocomplete: {
        instructions: "上下箭头选择，回车确认，输入过滤",
      },
      autocompleteMultiselect: {
        instructions: "↑/↓: 高亮选项，←/→/空格: 选择/取消，Ctrl+A: 全选/取消全选，回车: 确认，Ctrl+C: 取消",
      },
      multiselect: {
        instructions: "↑/↓: 高亮选项，空格: 选择/取消，Ctrl+A: 全选/取消全选，回车: 确认",
      },
      select: {
        instructions: "↑/↓: 选择，回车: 确认",
      },
    };
  }
}

async function readStdinValue(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}

async function resolveVaultValue(value: string | undefined, useStdin: boolean): Promise<string | null> {
  if (value !== undefined && useStdin) {
    console.error(kleur.red(t("vaultValueRequired")));
    process.exitCode = 1;
    return null;
  }
  if (useStdin) {
    const stdinValue = await readStdinValue();
    if (stdinValue) return stdinValue;
  } else if (value !== undefined) {
    return value;
  } else if (process.stdin.isTTY) {
    const response = await prompts({ type: "password", name: "value", message: t("vaultValuePrompt") });
    if (response.value) return String(response.value);
  }

  console.error(kleur.red(t("vaultValueRequired")));
  process.exitCode = 1;
  return null;
}

// 默认：显示帮助
program.action(async () => {
  const unknown = getUnknownSubcommand();
  if (unknown) {
    console.log(kleur.red(`✗ Unknown command: ${unknown}`));
    program.outputHelp();
    process.exit(1);
  }
  showBanner();
  await selectLanguageIfNeeded();
  configurePrompts(getLanguage());
  await showMainHelpHintOnce();
  program.outputHelp();
});

// upgrade 子命令
program
  .command("upgrade")
  .description("升级 MODELSWAP")
  .action(async () => {
    await selectLanguageIfNeeded();
    await upgradeSelf();
  });

// vault 子命令 - 密钥管理
const vault = program
  .command("vault")
  .description("密钥管理（加密存储、按需注入、项目关联）")
  .action(async () => {
    await vaultList();
  });

vault
  .command("set <key> [value]")
  .description("存储密钥（建议交互输入或使用 --stdin，避免写入 shell 历史）")
  .option("--stdin", "从标准输入读取密钥值")
  .action(async (key: string, value: string | undefined, options: { stdin?: boolean }) => {
    const resolvedValue = await resolveVaultValue(value, options.stdin === true);
    if (resolvedValue === null) return;
    await vaultSet(key, resolvedValue);
  });

vault
  .command("get <key>")
  .description("获取密钥明文")
  .action(async (key: string) => {
    await vaultGet(key);
  });

vault
  .command("list")
  .description("列出所有密钥（脱敏显示）")
  .option("--json", "输出适合脚本与 Agent 解析的 JSON")
  .action(async (options: { json?: boolean }) => {
    await vaultList(options);
  });

vault
  .command("delete <key>")
  .description("删除密钥")
  .action(async (key: string) => {
    await vaultDelete(key);
  });

vault
  .command("inject")
  .description("输出 shell export 语句（配合 eval 使用）")
  .option("--keys <keys>", "手动指定 key 列表（逗号分隔）")
  .option("--dir <dir>", "指定项目目录")
  .option("--shell <shell>", "输出格式: bash, zsh, powershell")
  .action(async (options: { keys?: string; dir?: string; shell?: string }) => {
    await vaultInject(options);
  });

vault
  .command("env [file]")
  .description("根据 .modelswapenv 生成 .env 文件并注册关联")
  .option("--dir <dir>", "指定项目目录")
  .action(async (file?: string, options?: { dir?: string }) => {
    await vaultEnv(file, options);
  });

vault
  .command("test <platform>")
  .description("测试云平台连接（如 supabase、cloudflare-kv）")
  .action(async (platform: string) => {
    try {
      // @ts-ignore
      const core = require("./web/api/cloud-sync-core");
      const result = await core.testConnection(platform);
      console.log(kleur.green(`✓ ${result}`));
    } catch (error: any) {
      console.error(kleur.red(`✗ ${error.message}`));
      process.exit(1);
    }
  });

vault
  .command("push")
  .description("将密钥与 Agent/Provider 配置推送到所有已启用平台")
  .action(async () => {
    try {
      // @ts-ignore
      const core = require("./web/api/cloud-sync-core");
      const result = await core.syncPush();
      console.log(kleur.green(`✓ 推送完成：${result.secrets} 个密钥 → ${result.platforms.join("、")}`));
    } catch (error: any) {
      console.error(kleur.red(`✗ ${error.message}`));
      process.exitCode = 1;
    }
  });

vault
  .command("pull")
  .description("读取所有已启用平台中最新的远端数据并合并到本地")
  .action(async () => {
    try {
      // @ts-ignore
      const core = require("./web/api/cloud-sync-core");
      const result = await core.syncPull();
      console.log(kleur.green(`✓ 拉取完成：新增 ${result.added} 个，更新 ${result.updated} 个`));
    } catch (error: any) {
      console.error(kleur.red(`✗ ${error.message}`));
      process.exitCode = 1;
    }
  });

// hook 子命令已于 v1.0.3 移除：其唯一作用（检测 .modelswapenv 自动注入）随
// 项目绑定功能一同删除，且它是产品中唯一主动写 shell rc 的功能，与
// "零侵入"承诺冲突。已装用户的手动清理方式见手册 FAQ。

// skill 子命令 - 安装供其他 Agent 使用的 MODELSWAP CLI Skill
const skill = program
  .command("skill")
  .description("定位或安装供 AI Agent 使用的 MODELSWAP CLI Skill")
  .action(async () => {
    await showSkillPath();
  });

skill
  .command("path")
  .description("输出内置 Skill 文件路径")
  .action(async () => {
    await showSkillPath();
  });

// extension 子命令 - 定位浏览器扩展（供 Chrome「加载已解压的扩展程序」）
program
  .command("extension")
  .description("定位浏览器扩展目录（Chrome → 加载已解压的扩展程序）")
  .action(async () => {
    const { showExtensionPath } = await import("./commands/extension");
    await showExtensionPath();
  });

// sync 子命令 - 多机同步（云端配置/推送拉取/同步码迁移/局域网配对）
const syncCmd = program
  .command("sync")
  .description("多机同步：云端平台配置、推送/拉取、同步码迁移、局域网配对")
  .action(async () => {
    const { syncStatus } = await import("./commands/sync");
    await syncStatus();
  });

syncCmd
  .command("status")
  .description("查看同步状态（--test 顺带测试各平台连接）")
  .option("--test", "同时测试已启用平台的连接")
  .action(async (options: { test?: boolean }) => {
    const { syncStatus } = await import("./commands/sync");
    await syncStatus(options);
  });

syncCmd
  .command("password")
  .description("设置同步密码（跨机解密的根，多台机器必须一致）")
  .option("--stdin", "从标准输入读取（避免进入 shell 历史）")
  .action(async (options: { stdin?: boolean }) => {
    const { syncPassword } = await import("./commands/sync");
    await syncPassword(options);
  });

syncCmd
  .command("enable <platform>")
  .description("配置并启用云平台（supabase/cloudflare-kv/webdav/…；交互填凭据，可 --set KEY=VALUE）")
  .option("--set <kv...>", "非交互指定字段 KEY=VALUE（可多次）")
  .option("--no-test", "配置后不测试连接")
  .action(async (platform: string, options: { set?: string[]; test?: boolean }) => {
    const { syncEnable } = await import("./commands/sync");
    await syncEnable(platform, options);
  });

syncCmd
  .command("disable <platform>")
  .description("停用平台（保留配置）")
  .action(async (platform: string) => {
    const { syncDisable } = await import("./commands/sync");
    await syncDisable(platform);
  });

syncCmd
  .command("test [platform]")
  .description("测试云平台连接（缺省测全部已启用平台）")
  .action(async (platform?: string) => {
    const { syncTest } = await import("./commands/sync");
    await syncTest(platform);
  });

syncCmd
  .command("push")
  .description("推送密钥与 Provider 配置到已启用云平台")
  .action(async () => {
    const { syncPush } = await import("./commands/sync");
    await syncPush();
  });

syncCmd
  .command("pull")
  .description("从云端拉取并合并（修改时间新者胜）")
  .action(async () => {
    const { syncPull } = await import("./commands/sync");
    await syncPull();
  });

syncCmd
  .command("export")
  .description("生成一次性同步码（含平台配置，密码加密；供另一台机器 import）")
  .option("--stdin", "从标准输入读取加密密码")
  .action(async (options: { stdin?: boolean }) => {
    const { syncExport } = await import("./commands/sync");
    await syncExport(options);
  });

syncCmd
  .command("import")
  .description("导入同步码（一键迁移另一台机器的云平台配置）")
  .option("--code <code>", "同步码")
  .option("--stdin", "从标准输入读取同步码")
  .action(async (options: { code?: string; stdin?: boolean }) => {
    const { syncImport } = await import("./commands/sync");
    await syncImport(options);
  });

syncCmd
  .command("pair")
  .description("局域网配对：--create 生成配对码 / --code <连接码> 加入对方")
  .option("--create", "在本机生成配对码")
  .option("--code <code>", "输入对方的连接码完成配对")
  .action(async (options: { create?: boolean; code?: string }) => {
    const { syncPair } = await import("./commands/sync");
    await syncPair(options);
  });

skill
  .command("install [dir]")
  .description("安装到目标项目的 .agents/skills/modelswap")
  .option("--force", "覆盖已存在的 Skill")
  .action(async (dir: string | undefined, options: { force?: boolean }) => {
    await installSkill(dir || process.cwd(), options);
  });

// provider 子命令 - Provider/Model 管理
const provider = program
  .command("provider")
  .description("模型管控 — 管理 AI Provider 和模型，一键切换 Agent 配置")
  .action(async () => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerCurrent();
  });

provider
  .command("list")
  .description("列出所有 Provider")
  .option("--json", "输出适合脚本与 Agent 解析的 JSON")
  .action(async (options: { json?: boolean }) => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerList(options);
  });

provider
  .command("switch [agent]")
  .description("交互式切换 Agent 的 Provider/Model")
  .action(async (agent?: string) => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerSwitch(agent);
  });

provider
  .command("use <provider>")
  .description("非交互式切换（指定 provider、agent、model）")
  .option("--agent <agent>", "指定 Agent")
  .option("--model <model>", "指定 Model")
  .action(async (providerName: string, options?: { agent?: string; model?: string }) => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerUse(providerName, options);
  });

provider
  .command("add")
  .description("添加 Provider")
  .action(async () => {
    await selectLanguageIfNeeded();
    await providerAdd();
  });

provider
  .command("delete <name>")
  .description("删除 Provider")
  .action(async (name: string) => {
    await selectLanguageIfNeeded();
    await providerDeleteAction(name);
  });

provider
  .command("current")
  .description("显示所有 Agent 当前配置")
  .option("--json", "输出适合脚本与 Agent 解析的 JSON")
  .action(async (options: { json?: boolean }) => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerCurrent(options);
  });

provider
  .command("auth")
  .description("查看所有 Provider 认证状态")
  .option("--json", "输出适合脚本与 Agent 解析的 JSON")
  .action(async (options: { json?: boolean }) => {
    await selectLanguageIfNeeded();
    await migrateIfNeeded();
    await providerAuth(options);
  });

// web 子命令 - 启动 Web UI
program
  .command("web")
  .description("启动 MODELSWAP 工具管理 Web UI")
  .option("-p, --port <number>", "端口号", "3780")
  .option("-o, --open", "自动打开浏览器", false)
  .action(async (options: { port: string; open: boolean }) => {
    const port = parseInt(options.port, 10) || 3780;

    // 动态导入 web server
    // @ts-ignore
    const { startServer } = await import("./web/server.js");

    // @ts-ignore
    startServer(port, options.open ? async (actualPort: number) => {
      const { exec } = await import("child_process");
      const { platform } = process;
      let cmd: string;
      if (platform === "darwin") {
        cmd = `open http://localhost:${actualPort}`;
      } else if (platform === "win32") {
        cmd = `start "" http://localhost:${actualPort}`;
      } else {
        cmd = `xdg-open http://localhost:${actualPort}`;
      }
      exec(cmd);
    } : undefined);
  });

function checkPlatform() {
  const supported = ["darwin", "linux", "win32"];
  if (!supported.includes(process.platform)) {
    console.log(kleur.red(`✗ 当前不支持 ${process.platform} 平台 (支持: macOS, Linux, Windows)`));
    process.exit(1);
  }
}

// Load the persisted language for every command. Previously only Provider
// commands did this, so Vault silently fell back to Chinese in English mode.
program.hook("preAction", async () => {
  checkPlatform();
  await initLanguage();
  configurePrompts(getLanguage());
});

async function showMainHelpHintOnce(): Promise<void> {
  const config = await loadUserConfig();
  if (config.hints?.mainHelpShown) return;
  console.log(kleur.gray(t("mainHelpHint")));
  await setUserPreference("mainHelpShown", true);
}

// Explicit argv: commander auto-detects its 'electron' argv convention when
// process.versions.electron is set, stripping only the binary path. The
// packaged CLI always runs through ELECTRON_RUN_AS_NODE (where that flag is
// still set but argv follows the node convention), so the auto-detection
// would leave the script path in place and every subcommand would fall into
// the default help action.
program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(kleur.red(`✗ ${message}`));
  process.exitCode = 1;
});
