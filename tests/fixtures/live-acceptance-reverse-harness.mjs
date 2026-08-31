#!/usr/bin/env node
// 人工反向验证证据工具（不进入 vitest 收集）。
//
// 用假浏览器驱动模拟“第三方页面已改版、安全入口消失”，其余全部走
// scripts/lib/live-acceptance 真实编排管线（参数校验→探针→分类→报告落盘
// →退出码），证明该失败路径非零退出且产出可定位的 JSON 报告。
// 不会启动浏览器、不会访问任何网络、不会创建任何第三方密钥。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runAcceptance } from '../../scripts/lib/live-acceptance/orchestrate.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-reverse-evidence-'));

// 假浏览器适配器：模拟“改版后”的已登录页面——无登录墙、无控制台特征、
// 找不到任何预期入口文案。
const fakeRedesignedDriver = {
  mode: 'auth-verify',
  async openTab(url) {
    return { id: 'tab-1', wsUrl: 'ws://127.0.0.1:9/fake/1', url };
  },
  async probe(_tab, probeOptions) {
    return {
      readyState: 'complete',
      url: `https://${probeOptions.platformId}.example.com/console`,
      title: '全新版控制台',
      buttons: ['帮助中心', '产品文档'],
      links: ['回到首页'],
      bodyChars: 137,
      loginRoute: false,
      hostIsLoginPage: false,
      passwordFields: 0,
      hasLoginInput: false,
      hasLoginPrompt: false,
      hasLoginAction: false,
      hasSmsLoginSurface: false,
      publicRootLoginSurface: false,
      verificationDialog: false,
      verificationPage: false,
      strongPageVerification: false,
      challengeIframe: false,
      challengeNode: false,
      challengeControl: false,
      matchedExpected: [],
      maskedPrefixFound: false,
      consoleSurface: true,
    };
  },
  async screenshot(_tab, filePath) {
    fs.writeFileSync(filePath, 'PNG-fake-evidence');
    return filePath;
  },
  async closeTab() {},
  async dispose() {},
};

const platform = {
  id: 'zhipu',
  label: '智谱 AI（国内站）',
  url: 'https://open.bigmodel.cn/apikey/platform',
  expectedTexts: ['新建API Key'],
  maskedPrefix: '',
  reuseOnly: false,
};

const outcome = await runAcceptance({
  mode: 'auth-verify',
  platformConfigs: [platform],
  driver: fakeRedesignedDriver,
  root,
  checkout: { revision: 'manual-reverse-evidence', dirty: false },
  sleep: async () => undefined,
  settle: { attempts: 1, intervalMs: 0, spaSettleMs: 0 },
  screenshotPolicy: 'login-only',
  logger: { log: () => undefined },
});

console.log(`exit-code\t${outcome.exitCode}`);
console.log(`report\t${outcome.reportPath}`);
process.exitCode = outcome.exitCode;
