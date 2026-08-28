import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { UsageCard } from '../src/web/frontend/src/components/usage/UsageCard';
import {
  isConsoleOnlyUsage,
  isExternalUsageNotice,
  refreshableUsageIds,
  shouldSkipAutomaticUsageRefresh,
} from '../src/web/frontend/src/components/usage/usagePresentation';

// The root test runner deliberately does not hoist frontend dependencies.
const requireFrontend = createRequire(
  path.join(process.cwd(), 'src/web/frontend/package.json'),
);
const { createElement } = requireFrontend('react');
const { renderToStaticMarkup } = requireFrontend('react-dom/server');

const t = (key: string) =>
  ({
    'usage.consoleView': '控制台查看',
    'usage.refresh': '刷新',
    'usage.loading': '加载中',
    'usage.empty': '暂无用量数据',
    'usage.configurationRequired': '需要配置',
    'usage.configureGuide': '配置指引',
  })[key] || key;

function renderUsageCard(usage: Parameters<typeof UsageCard>[0]['usage']) {
  return renderToStaticMarkup(
    createElement(UsageCard, {
      id: 'siliconflow',
      name: 'SiliconFlow',
      type: 'API',
      usage,
      fetching: false,
      onRefresh: vi.fn(),
      onLogin: vi.fn(),
      t,
    }),
  );
}

describe('console-only usage cards', () => {
  it('renders a SiliconFlow console error as a neutral notice with a safe external action', () => {
    const html = renderUsageCard({
      supported: true,
      windows: [],
      source: 'console',
      refreshPolicy: 'never',
      error: 'SiliconFlow 暂不支持实时余额查询，请在控制台查看',
      action: {
        label: '打开官方控制台',
        url: 'https://cloud.siliconflow.cn/',
      },
    });

    expect(html).toContain('usage-card-notice');
    expect(html).not.toContain('usage-card-error');
    expect(html).toContain('打开官方控制台');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('usage-card-refresh');
  });

  it('keeps existing console notices neutral while real API errors remain errors', () => {
    const consoleHtml = renderUsageCard({
      supported: true,
      windows: [],
      source: 'console',
      notice: '请在官方控制台查看余额与用量。',
      action: { label: '打开官方控制台', url: 'https://example.test/console' },
    });
    const apiErrorHtml = renderUsageCard({
      supported: true,
      windows: [],
      source: 'live',
      error: '网络请求失败',
    });

    expect(consoleHtml).toContain('usage-card-notice');
    expect(consoleHtml).not.toContain('usage-card-error');
    expect(apiErrorHtml).toContain('usage-card-error');
    expect(apiErrorHtml).not.toContain('usage-card-notice');
  });

  it('classifies external hand-offs and excludes console-only cards from manual refresh', () => {
    const siliconFlow = {
      supported: true,
      source: 'console' as const,
      refreshPolicy: 'never' as const,
      error: '实时余额不可用',
      action: { label: '打开官方控制台', url: 'https://cloud.siliconflow.cn/' },
    };
    const anthropic = {
      supported: true,
      source: 'console' as const,
      refreshPolicy: 'never' as const,
      notice: '请在控制台查看',
      action: { label: '打开官方控制台', url: 'https://console.anthropic.com/' },
    };
    const live = {
      supported: true,
      source: 'live' as const,
      windows: [{ label: 'credits', usedPercent: 20, resetAt: null }],
    };

    expect(isExternalUsageNotice(siliconFlow)).toBe(true);
    expect(isConsoleOnlyUsage(siliconFlow)).toBe(true);
    expect(isConsoleOnlyUsage(anthropic)).toBe(true);
    expect(refreshableUsageIds(['siliconflow', 'anthropic', 'deepseek'], {
      siliconflow: siliconFlow,
      anthropic,
      deepseek: live,
    })).toEqual(['deepseek']);
  });

  it('keeps manual browser/CLI console results refreshable but out of automatic polling', () => {
    const openCodeGo = {
      supported: true,
      source: 'console' as const,
      refreshPolicy: 'manual' as const,
      notice: '请先登录后刷新。',
      action: { label: '打开套餐页', url: 'https://opencode.ai/' },
    };
    const terminal = {
      supported: true,
      source: 'console' as const,
      refreshPolicy: 'never' as const,
      notice: '请在官方控制台查看。',
      action: { label: '打开控制台', url: 'https://example.test/' },
    };

    expect(isConsoleOnlyUsage(openCodeGo)).toBe(false);
    expect(shouldSkipAutomaticUsageRefresh(openCodeGo)).toBe(true);
    expect(refreshableUsageIds(['opencode-go', 'siliconflow'], {
      'opencode-go': openCodeGo,
      siliconflow: terminal,
    })).toEqual(['opencode-go']);
    expect(renderUsageCard(openCodeGo)).toContain('usage-card-refresh');
  });

  it('uses the structured refresh-policy table for console products with similar shapes', () => {
    const cases = [
      { name: 'SiliconFlow terminal console', policy: 'never' as const, refreshable: false, automatic: true },
      { name: 'Anthropic terminal console', policy: 'never' as const, refreshable: false, automatic: true },
      { name: 'OpenCode Go browser bridge', policy: 'manual' as const, refreshable: true, automatic: true },
      { name: 'Qianfan browser bridge', policy: 'manual' as const, refreshable: true, automatic: true },
      { name: 'management credential setup', policy: 'auto' as const, refreshable: true, automatic: false },
    ];

    for (const item of cases) {
      const usage = {
        supported: true,
        source: 'console' as const,
        refreshPolicy: item.policy,
        notice: item.name,
        action: { label: '打开官方控制台', url: 'https://example.test/' },
      };
      expect(isConsoleOnlyUsage(usage), item.name).toBe(!item.refreshable);
      expect(shouldSkipAutomaticUsageRefresh(usage), item.name).toBe(item.automatic);
      expect(refreshableUsageIds(['provider'], { provider: usage }), item.name)
        .toEqual(item.refreshable ? ['provider'] : []);
    }
  });

  it('keeps the notice action responsive and token-based for narrow and dark themes', () => {
    const css = fs.readFileSync(
      path.join(
        process.cwd(),
        'src/web/frontend/src/styles/usage.css',
      ),
      'utf8',
    );

    expect(css).toContain('.usage-card-notice {');
    expect(css).toContain('background: color-mix(in srgb, var(--kraft');
    expect(css).toContain('.usage-card-action {');
    expect(css).toContain('background: var(--ink);');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('.usage-card-action { min-height: 30px; }');
  });
});
