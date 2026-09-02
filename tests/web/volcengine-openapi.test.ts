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
      query: { SecretName: 'modelswap-sync-u', SecretType: 'Generic' },
      body: { SecretValue: '{"v":1}', Description: 'MODELSWAP sync data' },
    });

    expect(signed.method).toBe('POST');
    expect(signed.headers['X-Content-Sha256']).toBe('a3de37d3613726f95a9fdfbaeecc26527d787615d23a4056189c9e37ab548aae');
    expect(signed.headers.Authorization).toBe(
      'HMAC-SHA256 Credential=AKIDEXAMPLE/20260821/cn-beijing/kms/request, SignedHeaders=x-content-sha256;x-date, Signature=b2160de04eb94a42e72bea838e7e10b49f9e3cf9a7eb1b2fb81bacb0654163aa',
    );
  });
});
