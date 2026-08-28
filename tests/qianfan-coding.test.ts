import { describe, expect, it } from 'vitest';

import {
  QIANFAN_CODING_PROBE_MODEL,
  isQianfanCodingEndpoint,
  isQianfanCodingAnthropicEndpoint,
  qianfanModelDirectoryUrl,
  qianfanCodingErrorCode,
  qianfanCodingErrorMessage,
  qianfanCodingModels,
} from '../src/web/api/qianfan-coding.js';

describe('Qianfan Coding Plan endpoint helpers', () => {
  it('recognizes only the dedicated OpenAI-compatible coding base URL', () => {
    expect(isQianfanCodingEndpoint('https://qianfan.baidubce.com/v2/coding')).toBe(true);
    expect(isQianfanCodingEndpoint('https://qianfan.baidubce.com/v2/coding/')).toBe(true);
    expect(isQianfanCodingEndpoint('https://qianfan.baidubce.com/v2/tokenplan/personal')).toBe(true);
    expect(isQianfanCodingEndpoint('https://qianfan.baidubce.com/v2')).toBe(false);
  });

  it('recognizes the dedicated Anthropic-compatible Token Plan URL', () => {
    expect(isQianfanCodingAnthropicEndpoint('https://qianfan.baidubce.com/anthropic/coding')).toBe(true);
    expect(isQianfanCodingAnthropicEndpoint('https://qianfan.baidubce.com/anthropic/tokenplan/personal')).toBe(true);
    expect(isQianfanCodingAnthropicEndpoint('https://qianfan.baidubce.com/anthropic')).toBe(false);
    expect(QIANFAN_CODING_PROBE_MODEL).toBe('qianfan-code-latest');
  });

  it('keeps the Token Plan invocation URL separate from its official V2 model directory', () => {
    expect(qianfanModelDirectoryUrl('https://qianfan.baidubce.com/v2/tokenplan/personal'))
      .toBe('https://qianfan.baidubce.com/v2/models');
    expect(qianfanModelDirectoryUrl('https://qianfan.baidubce.com/v2/coding/'))
      .toBe('https://qianfan.baidubce.com/v2/models');
    expect(qianfanModelDirectoryUrl('https://qianfan.baidubce.com/v2')).toBeNull();
  });

  it('extracts the provider error code without exposing credentials', () => {
    expect(qianfanCodingErrorCode(JSON.stringify({ error: { code: 'coding_plan_api_key_required' } })))
      .toBe('coding_plan_api_key_required');
    expect(qianfanCodingErrorCode('not-json')).toBe('');
    expect(qianfanCodingErrorCode(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: "Error code: 403 - {'error': {'code': 'token_plan_person_model_not_supported', 'message': 'unsupported'}}",
      },
    }))).toBe('token_plan_person_model_not_supported');
  });

  it('explains the dedicated-key failure instead of saying the key is generically invalid', () => {
    expect(qianfanCodingErrorMessage('coding_plan_api_key_required'))
      .toContain('Coding Plan 专属 API Key');
    expect(qianfanCodingErrorMessage('token_plan_person_api_key_required'))
      .toContain('Token Plan 专属 API Key');
    expect(qianfanCodingErrorMessage('unknown-code')).toBe('');
  });

  it('does not expose a handwritten model catalog as discovery data', () => {
    expect(qianfanCodingModels()).toEqual([]);
  });
});
