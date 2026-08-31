import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AutoCreateLoginHandoff, getSafeAutoCreateLoginUrl } from '../src/web/frontend/src/components/shared/AutoCreateLoginHandoff';

const requireFromFrontend = createRequire(
  path.join(__dirname, '../src/web/frontend/src/placeholder.js'),
);

describe('auto-create login handoff', () => {
  it('keeps the provider login page available as a safe external link', () => {
    expect(getSafeAutoCreateLoginUrl('https://open.bigmodel.cn/apikey/platform'))
      .toBe('https://open.bigmodel.cn/apikey/platform');
  });

  it('renders a clear provider login action instead of exposing only a raw URL', () => {
    const React = requireFromFrontend('react');
    const { renderToStaticMarkup } = requireFromFrontend('react-dom/server');
    const html = renderToStaticMarkup(React.createElement(AutoCreateLoginHandoff, {
      platformLabel: '智谱 AI（国内站）',
      browserFocused: true,
      loginUrl: 'https://open.bigmodel.cn/apikey/platform',
      title: '需要登录此平台',
      message: '已将自动化浏览器窗口置前。请完成登录后回到这里重试。',
      openLoginLabel: '打开 智谱 AI（国内站） 登录网站',
      retryLabel: '登录完成，重试创建',
      autoCreating: false,
      onRetry: vi.fn(),
    }));

    expect(html).toContain('打开 智谱 AI（国内站） 登录网站');
    expect(html).toContain('href="https://open.bigmodel.cn/apikey/platform"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('vault-auto-create-login-url');
  });

  it('does not render non-web URLs from an API response as login links', () => {
    expect(getSafeAutoCreateLoginUrl('javascript:alert(1)')).toBeNull();
    expect(getSafeAutoCreateLoginUrl('file:///tmp/login')).toBeNull();
    expect(getSafeAutoCreateLoginUrl(undefined)).toBeNull();
  });
});
