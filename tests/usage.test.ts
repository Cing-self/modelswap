import { describe, expect, it } from 'vitest';

import { buildBceAuthorization, parseOpenCodeGoUsage, parseOpenRouterCredits, parseQianfanTokenPlanUsage, parseXaiPrepaidBalance, parseXiaomiBalance, parseXiaomiTokenPlanUsage } from '../src/web/api/usage.js';

describe('Baidu BCE V1 request signer', () => {
  it('matches the official BCE signing test vector', () => {
    const result = buildBceAuthorization({
      accessKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      method: 'PUT',
      pathName: '/v1/test/myfolder/readme.txt',
      query: {
        partNumber: '9',
        uploadId: 'a44cc9bab11cbd156984767aad637851',
      },
      headers: {
        Host: 'bj.bcebos.com',
        Date: 'Mon, 27 Apr 2015 16:23:49 +0800',
        'Content-Type': 'text/plain',
        'Content-Length': '8',
        'Content-Md5': 'NFzcPqhviddjRNnSOGo4rw==',
        'x-bce-date': '2015-04-27T08:23:49Z',
      },
      timestamp: '2015-04-27T08:23:49Z',
    });

    expect(result.signingKey).toBe('1d5ce5f464064cbee060330d973218821825ac6952368a482a592e6615aef479');
    expect(result.signature).toBe('d74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e');
    expect(result.authorization).toBe(
      'bce-auth-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2015-04-27T08:23:49Z/1800//d74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e',
    );
    expect(result.canonicalRequest).toContain('x-bce-date:2015-04-27T08%3A23%3A49Z');
    expect(result.canonicalRequest).not.toContain('UNSIGNED-PAYLOAD');
  });
});

describe('OpenRouter account credits parser', () => {
  it('uses account totals returned by the Management Credits API', () => {
    expect(parseOpenRouterCredits({
      data: { total_credits: 100.5, total_usage: 25.75 },
    })?.windows?.[0]).toMatchObject({
      usedPercent: 25.6,
      usedCredits: 25.75,
      limitCredits: 100.5,
      remainingCredits: 74.75,
      unit: 'USD',
      isPrepaid: true,
    });
  });

  it('recognizes a real zero account balance without inventing missing data', () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } })?.windows?.[0])
      .toMatchObject({ usedPercent: 0, remainingCredits: 0, unit: 'USD' });
    expect(parseOpenRouterCredits({ data: { usage: 0, limit: null } })).toBeNull();
  });
});

describe('xAI prepaid balance parser', () => {
  it('converts the signed USD-cent ledger balance into available dollars', () => {
    expect(parseXaiPrepaidBalance({
      changes: [],
      total: { val: '-1000' },
    })?.windows?.[0]).toMatchObject({
      limitCredits: 10,
      remainingCredits: 10,
      unit: 'USD',
      isPrepaid: true,
    });
  });

  it('recognizes a zero prepaid balance', () => {
    expect(parseXaiPrepaidBalance({ total: { val: '0' } })?.windows?.[0])
      .toMatchObject({ remainingCredits: 0, unit: 'USD' });
  });

  it('keeps the legacy flat-dollar response compatible', () => {
    expect(parseXaiPrepaidBalance({ balance: '12.34' })?.windows?.[0])
      .toMatchObject({ remainingCredits: 12.34, unit: 'USD' });
  });
});

describe('OpenCode Go usage parser', () => {
  it('maps the Go page rolling, weekly, and monthly windows', () => {
    expect(parseOpenCodeGoUsage({
      rollingUsage: { usagePercent: 12, resetInSec: 300 },
      weeklyUsage: { usagePercent: 34, resetInSec: 3600 },
      monthlyUsage: { usagePercent: 56, resetInSec: 7200 },
    })?.windows.map((window) => ({ label: window.label, usedPercent: window.usedPercent })))
      .toEqual([
        { label: '5h', usedPercent: 12 },
        { label: 'weekly', usedPercent: 34 },
        { label: 'monthly', usedPercent: 56 },
      ]);
  });
});

describe('MiMo Token Plan usage parser', () => {
  it('combines the total and compensation credit buckets', () => {
    const result = parseXiaomiTokenPlanUsage({
      code: 0,
      data: {
        usage: {
          items: [
            { name: 'plan_total_token', used: 125_000_000, limit: 1_000_000_000 },
            { name: 'compensation_total_token', used: 5_000_000, limit: 10_000_000 },
            { name: 'unrelated_bucket', used: 999, limit: 999 },
          ],
        },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.windows?.[0]).toMatchObject({
      usedPercent: 12.9,
      usedCredits: 130,
      limitCredits: 1010,
      remainingCredits: 880,
      unit: 'M Credits',
      isPrepaid: true,
    });
  });

  it('does not turn an empty console response into a zero balance', () => {
    expect(parseXiaomiTokenPlanUsage({ code: 0, data: { usage: { items: [] } } }))
      .toEqual({ error: 'MiMo 接口暂未返回 Token Plan 额度' });
  });
});

describe('MiMo API balance parser', () => {
  it('maps the console balance response without treating a real zero as missing', () => {
    expect(parseXiaomiBalance({
      code: 0,
      message: '',
      data: {
        balance: '0.00',
        frozenBalance: '0.00',
        currency: 'USD',
        overdraftLimit: '0.00',
        remainingOverdraftLimit: '0.00',
        giftBalance: '0.00',
        cashBalance: '0.00',
      },
    })?.windows?.[0]).toMatchObject({
      remainingCredits: 0,
      limitCredits: 0,
      unit: 'USD',
      isPrepaid: true,
    });
  });

  it('does not invent a balance when the console response omits it', () => {
    expect(parseXiaomiBalance({ code: 0, data: {} }))
      .toEqual({ error: '小米 MiMo 余额接口暂未返回可识别余额' });
  });
});

describe('Qianfan personal Token Plan usage parser', () => {
  it('maps total, used, remaining, and expiry without exposing the API key', () => {
    const result = parseQianfanTokenPlanUsage({
      success: true,
      result: {
        items: [{
          apiKey: 'secret-value',
          totalTokens: 10_000_000,
          usedTokens: 41_741,
          expiresAt: '2026-09-10T05:30:01Z',
        }],
      },
    });

    expect(result.windows?.[0]).toMatchObject({
      usedPercent: 0.4,
      usedCredits: 0.0417,
      limitCredits: 10,
      remainingCredits: 9.9583,
      unit: 'M Tokens',
      isPrepaid: true,
      resetAt: '2026-09-10T05:30:01.000Z',
    });
  });
});
