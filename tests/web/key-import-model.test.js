// Regression tests for the wizard's model-key classification. Real-world
// report (2026-08-25): on a fresh machine the wizard showed ONLY the two
// zcode builtin keys — every other legit model key was hidden because
// (a) the provider-store require had no dist fallback, so modelswapProviderIds
// was always null, and (b) common shapes (claude env block, codex toml/api
// root, workbuddy flat arrays) were never classified as model keys.
import { describe, it, expect, vi } from 'vitest';
import Module from 'module';

// key-import.js CommonJS-requires the TS vault store at import time — patch
// require the same way tests/vault-api.test.js does.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../../vault/store') return { VaultStore: function () { return { list: vi.fn(async () => []), get: vi.fn(), set: vi.fn() }; } };
  return origRequire.apply(this, arguments);
};

const { isModelKey } = await import('../../src/web/api/key-import.js');

const ids = new Set(['xiaomi-coding', 'deepseek', 'zai', 'openrouter', 'anthropic']);
const classify = (path, providerId) => isModelKey({ path, providerId }, ids);

describe('isModelKey classification', () => {
  it('accepts MODELSWAP-known provider namespaces (the require-fallback case)', () => {
    expect(classify('provider.xiaomi-coding.options.apiKey', 'xiaomi-coding')).toBe(true);
    expect(classify('provider.deepseek.options.apiKey', 'deepseek')).toBe(true);
  });

  it('accepts builtin plans and models.providers.* unconditionally', () => {
    expect(classify('provider.builtin:bigmodel-coding-plan.options.apiKey', 'builtin:bigmodel-coding-plan')).toBe(true);
    expect(classify('models.providers.minimax-portal.apiKey', undefined)).toBe(true);
  });

  it('accepts opencode auth.json <providerId>.key for known providers', () => {
    expect(classify('zai.key', 'zai')).toBe(true);
  });

  it('accepts claude env-block keys and codex root OPENAI_API_KEY', () => {
    expect(classify('env.ANTHROPIC_AUTH_TOKEN', undefined)).toBe(true);
    expect(classify('env.ANTHROPIC_API_KEY', undefined)).toBe(true);
    expect(classify('OPENAI_API_KEY', undefined)).toBe(true);
  });

  it('accepts bare api_key/apiKey fields (codex/kimi/grok toml, workbuddy arrays)', () => {
    expect(classify('api_key', undefined)).toBe(true);
    expect(classify('ApiKey', undefined)).toBe(true);
    expect(classify('[0].apiKey', undefined)).toBe(true);
    expect(classify('[12].api_key', undefined)).toBe(true);
  });

  it('rejects app-credential namespaces (discord/brave/stripe/gateway/tavly)', () => {
    expect(classify('channels.discord.accounts.main.token', undefined)).toBe(false);
    expect(classify('gateway.auth.token', undefined)).toBe(false);
    expect(classify('plugins.entries.brave.config.webSearch.apiKey', undefined)).toBe(false);
    expect(classify('mcp.servers.stripe.env.STRIPE_SECRET_KEY', undefined)).toBe(false);
    expect(classify('env.TAVILY_API_KEY', undefined)).toBe(false);
    expect(classify('TAVILY_API_KEY', undefined)).toBe(false);
  });

  it('rejects unknown env names and bare tokens', () => {
    expect(classify('env.SLACK_WEBHOOK_URL', undefined)).toBe(false);
    expect(classify('SOME_RANDOM_TOKEN', undefined)).toBe(false);
    expect(classify('token', undefined)).toBe(false);
    expect(classify('access_token', undefined)).toBe(false);
  });

  it('rejects unknown provider namespaces', () => {
    expect(classify('provider.some-unknown-mcp.options.apiKey', 'some-unknown-mcp')).toBe(false);
    expect(classify('alibaba.token', 'alibaba')).toBe(false);
  });
});
