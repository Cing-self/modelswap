import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

import zh from '../src/web/frontend/src/i18n/zh';
import en from '../src/web/frontend/src/i18n/en';
import { UsageCard } from '../src/web/frontend/src/components/usage/UsageCard';

const handoff = require('../src/application/usage-handoff-copy');
const requireFrontend = createRequire(path.join(process.cwd(), 'src/web/frontend/package.json'));
const { createElement } = requireFrontend('react');
const { renderToStaticMarkup } = requireFrontend('react-dom/server');

const implementationTerms = /Cookie|SSO|接口|\bbridge\b|自动(?:查询|刷新)|\bauto(?:matic(?:ally)?)?\s*(?:query|refresh)\b|\b(?:public|reusable)\s+API\b/i;

function translator(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, string | number>) =>
    (dictionary[key] || key).replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`));
}

function renderCard(usage: Parameters<typeof UsageCard>[0]['usage'], dictionary: Record<string, string>) {
  return renderToStaticMarkup(createElement(UsageCard, {
    id: 'usage-handoff-test', name: 'Usage Handoff', type: 'API', usage, fetching: false,
    onRefresh: vi.fn(), onLogin: vi.fn(), t: translator(dictionary),
  }));
}

function usageFrom(result: any) {
  return { supported: true, windows: [], ...result };
}

describe('usage hand-off i18n contract', () => {
  it('renders MiMo, OpenCode Go, GitHub Copilot, and every policy category in the selected language', () => {
    const cases = [
      { name: 'MiMo browser handoff', usage: usageFrom(handoff.browserRefreshHandoff('mimoConsole', 'https://example.test/mimo', 'extension')), zh: ['请在浏览器中打开MiMo 控制台后返回刷新。', '打开MiMo 控制台'], en: ['Open the MiMo console in your browser, then return and refresh.', 'Open the MiMo console'], refresh: true },
      { name: 'OpenCode Go manual refresh', usage: usageFrom(handoff.manualRefreshHandoff('opencodeGo', 'https://example.test/opencode', undefined, 'opencodeGoPlan')), zh: ['点击刷新读取OpenCode Go用量；首次使用请先登录OpenCode Go。', '打开OpenCode Go 套餐页'], en: ['Click refresh to read OpenCode Go usage. Sign in to OpenCode Go before your first use.', 'Open the OpenCode Go plan page'], refresh: true },
      { name: 'plugin connection refresh', usage: usageFrom(handoff.pluginRefreshHandoff('mimoConsole')), zh: ['请连接 MODELSWAP 浏览器插件后刷新。'], en: ['Connect the MODELSWAP browser extension, then refresh.'], refresh: true },
      { name: 'GitHub Copilot terminal console', usage: usageFrom(handoff.consoleUsageHandoff('githubCopilotBilling', 'https://example.test/github')), zh: ['请在GitHub Billing 或 Copilot 配额页查看用量。', '打开GitHub Billing 或 Copilot 配额页'], en: ['View usage in GitHub Billing or the Copilot quota page.', 'Open GitHub Billing or the Copilot quota page'], refresh: false },
      { name: 'credential refresh', usage: usageFrom(handoff.credentialRefreshHandoff('tencentCloudCredentials', 'https://example.test/tencent')), zh: ['请在密钥管理中添加腾讯云账务凭证后刷新。', '打开腾讯云账务凭证'], en: ['Add Tencent Cloud billing credentials in Key Management, then refresh.', 'Open Tencent Cloud billing credentials'], refresh: true },
      { name: 'manual unavailable', usage: usageFrom(handoff.unavailableConsoleHandoff('qianfanTokenPlan', 'https://example.test/qianfan')), zh: ['暂时无法读取百度千帆 Token Plan用量，请在控制台查看。', '打开百度千帆 Token Plan'], en: ['Usage is unavailable right now. View it in the Baidu Qianfan Token Plan.', 'Open the Baidu Qianfan Token Plan'], refresh: true },
    ];

    for (const item of cases) {
      expect(JSON.stringify(item.usage), item.name).not.toMatch(/[\u4e00-\u9fff]/);
      expect(item.usage.handoff.notice.key, item.name).toMatch(/^usage\.handoff\.notice\./);
      expect(item.usage.handoff.action?.key, item.name).toBe(
        item.usage.handoff.action ? 'usage.handoff.action.open' : undefined,
      );
      for (const [language, dictionary, expected] of [['zh', zh, item.zh], ['en', en, item.en]] as const) {
        const html = renderCard(item.usage, dictionary);
        expect(html, `${item.name} ${language}`).toContain(expected[0]);
        if (expected[1]) expect(html, `${item.name} ${language}`).toContain(expected[1]);
        expect(html, `${item.name} ${language}`).toContain('usage-card-notice');
        expect(html.includes('usage-card-action'), `${item.name} ${language}`).toBe(Boolean(expected[1]));
        expect(html.includes('usage-card-refresh'), `${item.name} ${language}`).toBe(item.refresh);
        expect(html, `${item.name} ${language}`).not.toMatch(implementationTerms);
      }
    }
  });

  it('keeps live values and real API errors outside the hand-off contract', () => {
    const live = renderCard({ supported: true, source: 'live', windows: [{ label: 'credits', usedPercent: 20, resetAt: null }] }, en);
    const error = renderCard({ supported: true, source: 'live', error: 'Network request failed' }, en);
    expect(live).not.toContain('usage-card-notice');
    expect(error).toContain('usage-card-error');
    expect(error).not.toContain('usage-card-notice');
  });

  it('allows application console results only through the shared key contract', () => {
    const applicationRoot = path.join(process.cwd(), 'src/application');
    const files = fs.readdirSync(applicationRoot, { recursive: true })
      .filter((file): file is string => typeof file === 'string' && file.endsWith('.js'))
      .map(file => path.join(applicationRoot, file));
    const consoleSources = files.filter(file => fs.readFileSync(file, 'utf8').includes("source: 'console'"));
    expect(consoleSources).toEqual([path.join(applicationRoot, 'usage-handoff-copy.js')]);
    const contract = fs.readFileSync(consoleSources[0], 'utf8');
    expect(contract).not.toMatch(implementationTerms);
    expect(contract).toContain("key: 'usage.handoff.action.open'");
    expect(contract).not.toMatch(/notice:\s*['"`]/);
  });
});
