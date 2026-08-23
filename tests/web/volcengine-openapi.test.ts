import { describe, expect, it } from 'vitest';

const { createSignedRequest } = require('../../src/web/api/volcengine-openapi');

const credentials = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'SECRETEXAMPLE',
  now: new Date('2026-08-21T12:34:56.000Z'),
  region: 'cn-beijing',
  service: 'kms',
};

describe('Volcengine OpenAPI signing', () => {
  it('matches the official SDK request signature for a GET action', () => {
    const signed = createSignedRequest({
      ...credentials,
      action: 'DescribeSecrets',
      version: '2021-02-18',
    });

    expect(signed.method).toBe('GET');
    expect(signed.path).toBe('/?Action=DescribeSecrets&Version=2021-02-18');
    expect(signed.headers.Authorization).toBe(
      'HMAC-SHA256 Credential=AKIDEXAMPLE/20260821/cn-beijing/kms/request, SignedHeaders=x-date, Signature=9ba79f98a3747bec1b390e88f413bcaa8eeb4869ba61e3e22bf2e05863876f96',
    );
  });

  it('matches the official SDK request signature for a JSON POST action', () => {
    const signed = createSignedRequest({
      ...credentials,
      action: 'CreateSecret',
      version: '2021-02-18',
      query: { SecretName: 'okit-sync-u', SecretType: 'Generic' },
      body: { SecretValue: '{"v":1}', Description: 'OKIT sync data' },
    });

    expect(signed.method).toBe('POST');
    expect(signed.headers['X-Content-Sha256']).toBe('50be4c97d4714c67c3f5945cf8293d146159cf55a855ed0da3eacee2c73ff0b9');
    expect(signed.headers.Authorization).toBe(
      'HMAC-SHA256 Credential=AKIDEXAMPLE/20260821/cn-beijing/kms/request, SignedHeaders=x-content-sha256;x-date, Signature=60a43747ad8572915c6a5ff5076e0c2b249ca8a8aa90d9c5e883d7e4b8d25de7',
    );
  });
});
