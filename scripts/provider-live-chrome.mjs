#!/usr/bin/env node
// provider-live-chrome — 启动“专用测试 Chrome”的登录辅助脚本。
//
// 它只做一件事：用专用 profile 目录（~/.okit/provider-live-acceptance/profiles/<name>）
// 启动一个独立的 Chrome/Edge 实例，供人工在各平台完成官方登录。可选
// --with-extension 加载 OKIT 扩展（仅 create-cleanup 链路需要）。
//
// 硬边界：
//  * 绝不使用/复制/备份/删除/导出日常 Chrome 的用户目录、Cookie、
//    LocalStorage、IndexedDB 或钥匙串内容；
//  * user-data-dir 永远位于验收根目录内（assertSafeProfileDir 双重校验）；
//  * --profile 只接受简单标识符，不是路径，结构上无法指向日常浏览器。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { findUnsafeArg, isSimpleProfileName, assertSafeProfileDir } from './lib/live-acceptance/safety.mjs';
import { findChromeBinary, launchDedicatedChrome, probeDebugPort, openTabAtUrl, DEFAULT_DEBUG_PORT } from './lib/live-acceptance/browser.mjs';
import { loadBrowserPlatforms } from './lib/live-acceptance/platforms.mjs';
import {
  newSessionId, buildAcceptanceExtensionCopy, writeLaunchRecord, DEFAULT_WITNESS_PORT,
} from './lib/live-acceptance/sessions.mjs';

const USAGE = [
  '用法：node scripts/provider-live-chrome.mjs [--profile <name>] [--with-extension] [--platform <id>...] [--status] [--debug-port <port>]',
  '',
  '  --profile <name>    专用 profile 名（默认 auth；纯标识符，不是路径）',
  '  --with-extension    创建一次性验收会话并加载打过补丁的扩展副本（create-cleanup 会话绑定所需；产品扩展本身不被修改）',
  '  --platform <id>     可重复：在打开的专用 Chrome 中新开该平台控制台标签页，便于人工登录',
  '  --status            只探测专用 Chrome 是否在运行，不启动',
  '  --debug-port <port> CDP 调试端口（默认 9333）',
].join('\n');

function parseArgv(argv) {
  const unsafe = findUnsafeArg(argv);
  if (unsafe) return { ok: false, error: `拒绝不安全参数 ${unsafe}：本工具绝不读取/复制/迁移日常浏览器数据` };
  const parsed = { profileName: 'auth', withExtension: false, platforms: [], status: false, debugPort: DEFAULT_DEBUG_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--with-extension') parsed.withExtension = true;
    else if (token === '--status') parsed.status = true;
    else if (token === '--profile') {
      if (!value || value.startsWith('--')) return { ok: false, error: '--profile 需要一个值\n' + USAGE };
      parsed.profileName = value;
      index += 1;
    } else if (token.startsWith('--profile=')) parsed.profileName = token.slice('--profile='.length);
    else if (token === '--platform') {
      if (!value || value.startsWith('--')) return { ok: false, error: '--platform 需要一个平台 ID\n' + USAGE };
      parsed.platforms.push(value);
      index += 1;
    } else if (token.startsWith('--platform=')) parsed.platforms.push(...token.slice('--platform='.length).split(','));
    else if (token === '--debug-port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: '--debug-port 需要 1024–65535 的整数\n' + USAGE };
      parsed.debugPort = port;
      index += 1;
    } else if (token.startsWith('--debug-port=')) {
      const port = Number(token.slice('--debug-port='.length));
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: '--debug-port 需要 1024–65535 的整数\n' + USAGE };
      parsed.debugPort = port;
    } else return { ok: false, error: `未知参数：${token}\n${USAGE}` };
  }
  if (!isSimpleProfileName(parsed.profileName)) {
    return { ok: false, error: '--profile 只接受简单标识符（字母/数字/./_/-），不接受路径；专用 profile 永远位于 ~/.okit/provider-live-acceptance/profiles/ 内' };
  }
  return { ok: true, ...parsed };
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`error\t${parsed.error}`);
    process.exitCode = 2;
    return;
  }

  const root = path.join(os.homedir(), '.okit', 'provider-live-acceptance');
  const profileDir = path.join(root, 'profiles', parsed.profileName);
  try {
    assertSafeProfileDir({ root, dir: profileDir });
  } catch (error) {
    console.error(`error\t${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.status) {
    try {
      await probeDebugPort(parsed.debugPort, 1500, 500);
      console.log(`status\trunning\t127.0.0.1:${parsed.debugPort}\t${profileDir}`);
    } catch {
      console.log(`status\tnot-running\t127.0.0.1:${parsed.debugPort}`);
      process.exitCode = 1;
    }
    return;
  }

  const binary = findChromeBinary();
  if (!binary) {
    console.error('error\t未找到 Chrome/Chromium/Edge 可执行文件；请设置 OKIT_LIVE_CHROME_BIN 或安装任一受支持浏览器');
    process.exitCode = 1;
    return;
  }

  // --with-extension creates a one-time acceptance session: a launch record
  // plus a PATCHED COPY of the product extension that reports its session id
  // to the local witness while its server WS is open. create-cleanup refuses
  // to delegate unless it can verify this binding (unverified_extension_identity).
  let extensionDir = '';
  let sessionId = '';
  let recordFile = '';
  if (parsed.withExtension) {
    sessionId = newSessionId();
    const repoExtensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
    extensionDir = path.join(root, 'extension-copies', sessionId);
    try {
      const built = await buildAcceptanceExtensionCopy({
        sourceDir: repoExtensionDir,
        destDir: extensionDir,
        sessionId,
        witnessPort: DEFAULT_WITNESS_PORT,
      });
      console.log(`extension-copy\t${built.copyDir}\tpatched=${Object.entries(built.patched).map(([k, v]) => `${k}:${v}`).join(',')}`);
    } catch (error) {
      console.error(`error\t无法生成验收扩展副本（fail closed，不启动扩展链路）：${error?.message || error}`);
      process.exitCode = 1;
      return;
    }
  }

  const launched = await launchDedicatedChrome({
    binary,
    userDataDir: profileDir,
    root,
    debugPort: parsed.debugPort,
    withExtension: parsed.withExtension,
    extensionDir,
  });
  await probeDebugPort(parsed.debugPort, 20000);

  if (parsed.withExtension) {
    const written = await writeLaunchRecord({
      root,
      sessionId,
      profileDir,
      debugPort: parsed.debugPort,
      witnessPort: DEFAULT_WITNESS_PORT,
      pid: launched.pid,
      extensionCopyDir: extensionDir,
    });
    recordFile = written.file;
    console.log(`session\t${sessionId}`);
    console.log(`session-record\t${recordFile}`);
  }

  if (parsed.platforms.length) {
    const byId = new Map(loadBrowserPlatforms().map((platform) => [platform.id, platform]));
    for (const id of parsed.platforms) {
      const platform = byId.get(id);
      if (!platform) {
        console.log(`warn\t未知或非 browser 平台：${id}（--platform 需为 browser 平台 ID）`);
        continue;
      }
      try {
        await openTabAtUrl(parsed.debugPort, platform.url);
        console.log(`opened\t${id}\t${platform.url}`);
      } catch (error) {
        console.log(`warn\t无法打开 ${id}：${error?.message || error}`);
      }
    }
  }

  console.log(`launched\t${binary}`);
  console.log(`profile\t${profileDir}`);
  console.log(`pid\t${launched.pid}`);
  console.log('note\t这是独立的专用测试 Chrome：与日常 Chrome 完全隔离；本工具绝不读取/复制/备份/导出日常浏览器的 Cookie、LocalStorage、IndexedDB、钥匙串或配置');
  if (parsed.withExtension) {
    console.log('note\t已加载“本会话打过补丁的验收扩展副本”（上报会话标识到本地 witness）。create-cleanup 将校验该会话绑定；普通/未知扩展在线不构成执行依据');
    console.log(`note\tcreate-cleanup 用法：npm run test:providers:live -- --mode create-cleanup --platform <id> --allow-create-and-cleanup --session ${sessionId}`);
  }
  console.log('note\t请在打开的窗口中人工完成各平台官方登录；登录态只保存在上述专用目录。auth-verify 验收请随后运行：npm run test:providers:live -- --mode auth-verify');
}

main().catch((error) => {
  console.error(`fatal\t${error?.message || error}`);
  process.exitCode = 1;
});
