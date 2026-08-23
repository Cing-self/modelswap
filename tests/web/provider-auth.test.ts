import { beforeEach, describe, expect, it, vi } from 'vitest';

const { __testing } = await import('../../src/web/api/providers');

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gateway',
    name: 'Gateway',
    type: 'openai',
    baseUrl: 'https://gateway.example/v1',
    endpoints: [
      { id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' },
      { id: 'gateway:anthropic', type: 'anthropic', baseUrl: 'https://gateway.example/anthropic' },
    ],
    vaultKey: 'GATEWAY_API_KEY',
    authMode: 'api_key',
    models: [{ id: 'model-one' }],
    ...overrides,
  };
}

const probe = vi.fn();
const resolveVaultKey = vi.fn(async () => 'test-secret');

beforeEach(() => {
  probe.mockReset();
  resolveVaultKey.mockClear();
});

describe('provider authentication lifecycle', () => {
  it('automatically validates a newly bound key when auth status is read', async () => {
    const value = provider({ endpoints: [{ id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' }] });
    probe.mockResolvedValue({ success: true, message: '连接成功' });

    const status = await __testing.getProviderAuthSnapshot(value, undefined, { probe, resolveVaultKey });

    expect(status).toMatchObject({ authVerified: true, authState: 'verified' });
    expect(status.revalidation).toMatchObject({ checked: true, success: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(value).toMatchObject({
      authVerified: true,
      authVerifiedKey: 'GATEWAY_API_KEY',
      authState: 'verified',
    });
  });

  it('records endpoint-level partial auth instead of invalidating the whole offering', async () => {
    const value = provider();
    probe
      .mockResolvedValueOnce({ success: true, message: '连接成功' })
      .mockResolvedValueOnce({ success: false, message: 'HTTP 503' });

    const result = await __testing.revalidateProviderAuth(value, { force: true, probe });

    expect(result).toMatchObject({ checked: true, success: false, invalid: false });
    expect(value).toMatchObject({ authVerified: true, authState: 'partial' });
    expect(value.authEndpointStates).toMatchObject({
      'gateway:openai': { state: 'verified' },
      'gateway:anthropic': { state: 'unknown', error: 'HTTP 503' },
    });
  });

  it('marks an explicit credential failure invalid', async () => {
    const value = provider({ endpoints: [{ id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' }] });
    probe.mockResolvedValue({ success: false, message: 'HTTP 401 API Key 无效' });

    await __testing.revalidateProviderAuth(value, { force: true, probe });

    expect(value).toMatchObject({ authVerified: false, authState: 'invalid' });
  });

  it('does not treat a generic HTTP 403 as proof that the credential is invalid', async () => {
    const value = provider({ endpoints: [{ id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' }] });
    probe.mockResolvedValue({ success: false, message: 'HTTP 403' });

    await __testing.revalidateProviderAuth(value, { force: true, probe });

    expect(value).toMatchObject({ authState: 'needs_verification' });
    expect(value.authVerified).not.toBe(false);
  });

  it('still treats an explicit 403 invalid-api-key response as invalid', async () => {
    const value = provider({ endpoints: [{ id: 'gateway:openai', type: 'openai', baseUrl: 'https://gateway.example/v1' }] });
    probe.mockResolvedValue({ success: false, message: 'HTTP 403: invalid api-key' });

    await __testing.revalidateProviderAuth(value, { force: true, probe });

    expect(value).toMatchObject({ authVerified: false, authState: 'invalid' });
  });

  it('does not let retry cooldown block a newly selected endpoint without state', async () => {
    const value = provider({
      authVerified: true,
      authVerifiedKey: 'GATEWAY_API_KEY',
      authVerifiedAt: new Date().toISOString(),
      authLastCheckedAt: new Date().toISOString(),
      authLastCheckedKey: 'GATEWAY_API_KEY',
      authEndpointStates: { 'gateway:old-id': { state: 'verified', checkedAt: new Date().toISOString() } },
    });
    probe.mockResolvedValue({ success: true, message: '连接成功' });

    const result = await __testing.revalidateProviderAuth(value, {
      endpointId: 'gateway:anthropic',
      probe,
    });

    expect(result.checked).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('removes auth states whose generated endpoint IDs no longer exist', async () => {
    const value = provider({
      authEndpointStates: {
        'gateway:old-id': { state: 'verified', checkedAt: new Date().toISOString() },
      },
    });
    probe.mockResolvedValue({ success: true, message: '连接成功' });

    await __testing.revalidateProviderAuth(value, { force: true, probe });

    expect(value.authEndpointStates).not.toHaveProperty('gateway:old-id');
    expect(value.authEndpointStates).toHaveProperty('gateway:openai');
    expect(value.authEndpointStates).toHaveProperty('gateway:anthropic');
  });

  it('checks only the selected model source endpoint before switching', async () => {
    const value = provider();
    probe.mockResolvedValue({ success: true, message: '连接成功' });

    const result = await __testing.ensureProviderAuth(
      value,
      undefined,
      'gateway:anthropic',
      { probe, resolveVaultKey },
    );

    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      type: 'anthropic',
      baseUrl: 'https://gateway.example/anthropic',
    }));
    expect(value.authEndpointStates).toMatchObject({
      'gateway:anthropic': { state: 'verified' },
    });
    expect(value.authEndpointStates).not.toHaveProperty('gateway:openai');
  });

  it('repairs a deleted auto-generated Vault reference when one replacement remains', async () => {
    const value = provider({
      vaultKey: 'GATEWAY_API_KEY-old1',
      authVerified: true,
      authVerifiedKey: 'GATEWAY_API_KEY-old1',
      authState: 'verified',
    });

    const result = await __testing.repairMissingVaultBindings([value], {
      listVaultKeys: async () => [
        { key: 'GATEWAY_API_KEY-new2' },
        { key: 'OTHER_API_KEY-abcd' },
      ],
    });

    expect(result).toEqual({ changed: true });
    expect(value).toMatchObject({ vaultKey: 'GATEWAY_API_KEY-new2' });
    expect(value.authVerified).toBeUndefined();
    expect(value.authState).toBeUndefined();
  });

  it('does not guess when multiple replacement Vault keys exist', async () => {
    const value = provider({ vaultKey: 'GATEWAY_API_KEY-old1' });

    const result = await __testing.repairMissingVaultBindings([value], {
      listVaultKeys: async () => [
        { key: 'GATEWAY_API_KEY-new2' },
        { key: 'GATEWAY_API_KEY-new3' },
      ],
    });

    expect(result).toEqual({ changed: false });
    expect(value.vaultKey).toBe('GATEWAY_API_KEY-old1');
  });
});
