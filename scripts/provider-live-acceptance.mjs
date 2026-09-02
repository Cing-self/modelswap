#!/usr/bin/env node
// provider-live-acceptance — 发布前人工触发的真实验收工具（第一阶段）。
//
// 三种模式：
//   guest          全新临时 Chrome 会话访问真实控制台，验证“未登录被识别为
//                  需要登录/可交接登录”，绝不执行创建/确认/复制/删除。
//   auth-verify    只用专用持久 profile（~/.modelswap/provider-live-acceptance/auth，
//                  用户自行登录），验证到达已登录控制台并找到预期安全入口，
//                  绝不点击创建/确认/生成/删除。
//   create-cleanup 默认禁止。必须 --platform <唯一平台> + --allow-create-and-cleanup，
//                  委托 scripts/auto-create-key-check.mjs 完成唯一测试名创建→
//                  读取→精确删除→确认消失；任何清理失败立即停止。
//
// 安全边界：专用 profile Chrome + CDP 只读探针（结构上没有创建通路）；
// 绝不复用/复制/导出日常 Chrome 数据；产物只写入 ~/.modelswap/provider-live-acceptance/。
// dry-run 只验证计划、参数校验和报告格式，不访问任何外部资源。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseLiveAcceptanceArgs, USAGE } from './lib/live-acceptance/args.mjs';
import { assertSafeProfileDir, redactSecrets } from './lib/live-acceptance/safety.mjs';
import { listAllPlatforms, loadBrowserPlatforms, extraExpectedTexts, loadPlatformById } from './lib/live-acceptance/platforms.mjs';
import { createReadOnlyDriver, findChromeBinary, DEFAULT_DEBUG_PORT } from './lib/live-acceptance/browser.mjs';
import { runAcceptance } from './lib/live-acceptance/orchestrate.mjs';
import { registerSignalCleanup } from './lib/live-acceptance/signals.mjs';
import { uniqueRunStamp } from './lib/live-acceptance/report.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function checkoutState() {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { revision, dirty: Boolean(dirty) };
  } catch (error) {
    return { revision: '', dirty: true, error: redactSecrets(error?.message || error) };
  }
}

function fail(message, code = 2) {
  console.error(`error\t${message}`);
  process.exitCode = code;
}

async function main() {
  const parsed = parseLiveAcceptanceArgs(process.argv.slice(2));
  if (!parsed.ok) return fail(parsed.error, 2);

  if (parsed.list) {
    for (const platform of listAllPlatforms()) {
      console.log(`${platform.id}\t${platform.label}\t${platform.mode}`);
    }
    return;
  }

  const root = path.join(os.homedir(), '.modelswap', 'provider-live-acceptance');
  await fsp.mkdir(root, { recursive: true });

  let platformConfigs = [];
  if (parsed.mode === 'create-cleanup') {
    const platform = loadPlatformById(parsed.platforms[0]);
    if (!platform) return fail(`未知平台：${parsed.platforms[0]}（--list 查看）`, 2);
    platformConfigs = [platform];
  } else {
    const browserPlatforms = loadBrowserPlatforms();
    const byId = new Map(browserPlatforms.map((platform) => [platform.id, platform]));
    if (parsed.platforms.length === 0) {
      platformConfigs = browserPlatforms;
    } else {
      for (const id of parsed.platforms) {
        const platform = byId.get(id);
        if (!platform) {
          const known = loadPlatformById(id);
          const hint = known
            ? `平台 ${id} 的 mode 是 ${known.mode}；guest/auth-verify 只覆盖 browser 平台`
            : `未知平台：${id}（--list 查看）`;
          return fail(hint, 2);
        }
      }
      platformConfigs = parsed.platforms.map((id) => byId.get(id));
    }
    // Strategy-specific expected texts that live beside the strategies
    // (zhipu) augment the registry-derived list.
    for (const platform of platformConfigs) {
      platform.expectedTexts = [...platform.expectedTexts, ...extraExpectedTexts(platform.id)];
    }
  }

  // Profile directories: guest gets a throwaway per-run dir; auth-verify and
  // create-cleanup use the named persistent dir under the acceptance root.
  // uniqueRunStamp (ms + random) so same-second guest runs never share a dir.
  const runStamp = uniqueRunStamp();
  const profileDir = parsed.mode === 'guest'
    ? path.join(root, 'tmp', `guest-${runStamp}`)
    : path.join(root, 'profiles', parsed.effective.profileName || 'auth');
  try {
    assertSafeProfileDir({ root, dir: profileDir });
  } catch (error) {
    return fail(error.message, 1);
  }

  let driver = null;
  let unregisterSignalCleanup = () => undefined;
  if (!parsed.dryRun && parsed.mode !== 'create-cleanup') {
    const binary = parsed.chromeBin && fs.existsSync(parsed.chromeBin)
      ? parsed.chromeBin
      : findChromeBinary();
    driver = createReadOnlyDriver({
      mode: parsed.mode,
      binary,
      root,
      profileDir,
      debugPort: parsed.debugPort || DEFAULT_DEBUG_PORT,
      temporary: parsed.mode === 'guest',
      withExtension: false,
    });
    // P1: Ctrl-C / SIGTERM must still kill the dedicated Chrome we launched
    // and remove throwaway guest profiles (best effort; SIGKILL cannot be
    // handled — see docs/testing/provider-live-acceptance.md).
    unregisterSignalCleanup = registerSignalCleanup({ driver });
  }

  const delegateScriptPath = path.join(SCRIPTS_DIR, 'auto-create-key-check.mjs');
  const repoRoot = path.resolve(SCRIPTS_DIR, '..');

  let outcome;
  try {
    outcome = await runAcceptance({
      mode: parsed.mode,
      dryRun: parsed.dryRun,
      allowCreateAndCleanup: parsed.allowCreateAndCleanup,
      keepOpen: parsed.effective.keepOpen,
      screenshotPolicy: parsed.effective.screenshots,
      platformConfigs,
      driver,
      root,
      checkout: checkoutState(),
      delegateScriptPath,
      repoRoot,
      sessionId: parsed.session,
      runStamp,
    });
  } finally {
    unregisterSignalCleanup();
  }
  console.log(`exit\t${outcome.exitCode}`);
  process.exitCode = outcome.exitCode;
}

main().catch((error) => {
  console.error(`fatal\t${redactSecrets(error?.message || error)}`);
  console.error(USAGE);
  process.exitCode = 1;
});
