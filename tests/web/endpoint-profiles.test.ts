import { describe, expect, it } from 'vitest';
import { PRESET_PROVIDERS } from '../../src/providers/presets';

const profiles = await import('../../src/web/api/endpoint-profiles.js') as {
  DEFAULT_PROBE_MODEL: string;
  getAnthropicAuthMode: (baseUrl: string) => 'bearer' | 'x-api-key';
  getEndpointProfile: (baseUrl: string) => { id: string; probeModel: string } | null;
  getAuthenticatedResourceFailureMessage: (status: number, body: string) => string | null;
  getProbeModels: (baseUrl: string) => string[];
  requiresInferenceProbe: (baseUrl: string) => boolean;
  isModelAccessFailure: (status: number, body: string) => boolean;
  pickProbeModel: (baseUrl: string) => string;
};

describe('endpoint probe profiles', () => {
  it('uses a Moonshot model for the Anthropic-compatible endpoint', () => {
    expect(profiles.getEndpointProfile('https://api.moonshot.ai/anthropic')).toMatchObject({
      id: 'moonshot-anthropic',
      probeModel: 'kimi-k2.5',
    });
    expect(profiles.pickProbeModel('https://api.moonshot.ai/anthropic')).toBe('kimi-k2.5');
    expect(profiles.pickProbeModel('https://api.moonshot.cn/anthropic')).toBe('kimi-k2.5');
  });

  it('uses independent Qianfan endpoint profiles and real inference probes', () => {
    expect(profiles.getEndpointProfile('https://qianfan.baidubce.com/v2')).toMatchObject({
      id: 'qianfan-openai',
      probeModel: 'deepseek-v3.2',
    });
    expect(profiles.getEndpointProfile('https://qianfan.baidubce.com/anthropic')).toMatchObject({
      id: 'qianfan-anthropic',
      probeModel: 'deepseek-v3.2',
    });
    expect(profiles.requiresInferenceProbe('https://qianfan.baidubce.com/v2')).toBe(true);
    expect(profiles.requiresInferenceProbe('https://qianfan.baidubce.com/anthropic')).toBe(true);
    expect(profiles.pickProbeModel('https://qianfan.baidubce.com/anthropic')).toBe('deepseek-v3.2');
    expect(profiles.isModelAccessFailure(
      401,
      JSON.stringify({ error: { code: 'invalid_model', message: 'The model does not exist or you do not have access to it.' } }),
    )).toBe(true);
    expect(profiles.isModelAccessFailure(401, '{"error":"invalid api-key"}')).toBe(false);
  });

  it('maps every bundled Coding, Token, Agent, and Go endpoint to a non-generic probe', () => {
    for (const provider of PRESET_PROVIDERS) {
      for (const endpoint of provider.endpoints || []) {
        if (!endpoint.plan) continue;
        const profile = profiles.getEndpointProfile(endpoint.baseUrl);
        expect(profile, `${provider.id} ${endpoint.type} ${endpoint.baseUrl}`).not.toBeNull();
        expect(profiles.pickProbeModel(endpoint.baseUrl), `${provider.id} ${endpoint.type}`)
          .not.toBe(profiles.DEFAULT_PROBE_MODEL);
        expect(provider.models.some(model => model.id === profile?.probeModel), `${provider.id} probe ${profile?.probeModel}`)
          .toBe(true);
      }
    }
  });

  it('uses Bearer auth for Anthropic gateways documented via ANTHROPIC_AUTH_TOKEN', () => {
    for (const url of [
      'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      'https://open.bigmodel.cn/api/anthropic',
      'https://api.z.ai/api/anthropic',
      'https://ark.cn-beijing.volces.com/api/coding',
      'https://ark.cn-beijing.volces.com/api/plan',
    ]) {
      expect(profiles.getAnthropicAuthMode(url), url).toBe('bearer');
    }
    expect(profiles.getAnthropicAuthMode('https://api.kimi.com/coding')).toBe('x-api-key');
    expect(profiles.getAnthropicAuthMode('https://api.minimaxi.com/anthropic')).toBe('x-api-key');
  });

  it('retries mutually exclusive Tencent plan tiers without treating model access as bad credentials', () => {
    expect(profiles.getProbeModels('https://api.lkeap.cloud.tencent.com/plan/v3'))
      .toEqual(['tc-code-latest', 'hy3']);
    expect(profiles.isModelAccessFailure(403, '{"code":"model_not_supported"}')).toBe(true);
    expect(profiles.isModelAccessFailure(404, 'Not found the model hy3 or Permission denied')).toBe(true);
    expect(profiles.isModelAccessFailure(403, 'invalid api-key')).toBe(false);
  });

  it('separates authenticated billing failures from invalid credentials', () => {
    expect(profiles.getAuthenticatedResourceFailureMessage(
      403,
      JSON.stringify({ error: { code: 'account_overdue', message: 'Access denied due to overdue account' } }),
    )).toContain('Key 有效');
    expect(profiles.getAuthenticatedResourceFailureMessage(429, '{"code":"quota_exceeded"}')).toContain('额度不足');
    expect(profiles.getAuthenticatedResourceFailureMessage(401, '{"error":"invalid api-key"}')).toBeNull();
  });
});
