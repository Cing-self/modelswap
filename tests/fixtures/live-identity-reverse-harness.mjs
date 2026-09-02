#!/usr/bin/env node
// P0 反向验证证据工具（不进入 vitest 收集）。
//
// 场景：“普通/未知扩展在线”——一个声称 available=true 的 cdp-status（模拟
// 日常 Chrome 的产品扩展连着 MODELSWAP 服务），但没有任何验收会话记录/心跳证明。
// 走真实编排管线（健康检查→身份闸门→委托），证明：
//   * create-cleanup 以 unverified_extension_identity 拒绝（exit 1）；
//   * 创建委托完全不被调用（DELEGATE-ATTEMPTED 哨兵不出现）。
// 全程本地回环 HTTP，不访问任何外部资源、不创建任何第三方 Key。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runAcceptance } from '../../scripts/lib/live-acceptance/orchestrate.mjs';

// 本地假 MODELSWAP 服务：只回答 /api/vault/cdp-status，永远 available=true。
const fakeServer = http.createServer((req, res) => {
  if (req.url === '/api/vault/cdp-status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ available: true, version: '2.0.7', protocol: 'atomic-v2' }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${fakeServer.address().port}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-identity-reverse-'));
const platform = { id: 'zhipu', label: '智谱 AI（国内站）', mode: 'browser' };

const outcome = await runAcceptance({
  mode: 'create-cleanup',
  allowCreateAndCleanup: true,
  platformConfigs: [platform],
  root,
  baseUrl,
  sessionId: '11111111-2222-3333-4444-555555555555', // 有会话参数，但从未生成过记录
  checkout: { revision: 'manual-p0-evidence', dirty: false },
  logger: { log: () => undefined },
  delegateScriptPath: '/nonexistent/delegate.mjs',
  repoRoot: process.cwd(),
  witnessTimeoutMs: 800,
  spawnImpl: () => {
    console.log('DELEGATE-ATTEMPTED\t危险委托被调用——闸门失效！');
    const child = { on() {}, stdout: { on() {} }, stderr: { on() {} } };
    return child;
  },
});

fakeServer.close();
console.log(`exit-code\t${outcome.exitCode}`);
console.log(`report\t${outcome.reportPath}`);
const result = outcome.report.results[0];
console.log(`status\t${result.status}`);
console.log(`reason\t${result.reason}`);
process.exitCode = outcome.exitCode;
