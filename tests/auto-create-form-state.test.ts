import { describe, expect, it } from 'vitest';
import { getAutoCreatePlatformFields } from '../src/web/frontend/src/components/shared/autoCreateFormState';
import { normalizeGroupName, PREDEFINED_GROUPS } from '../src/web/frontend/src/data/vault-groups';

const platform = (id: string, keyHint: string, groupHint: string) => ({
  id,
  label: id,
  keyHint,
  groupHint,
  mode: 'browser' as const,
});

describe('auto-create form platform state', () => {
  it('normalizes legacy provider group names into the canonical taxonomy', () => {
    expect(normalizeGroupName('智谱AI')).toBe('智谱AI · 国内');
    expect(normalizeGroupName('Z.AI（国际站）')).toBe('智谱AI · 国际');
    expect(normalizeGroupName('litellm')).toBe('LiteLLM');
    expect(PREDEFINED_GROUPS).toContain('LiteLLM');
  });

  it('does not expose the legacy Kimi group as a predefined group', () => {
    expect(PREDEFINED_GROUPS).not.toContain('Kimi 国际');
    expect(PREDEFINED_GROUPS).not.toContain('Kimi · 国际');
    expect(PREDEFINED_GROUPS).not.toContain('Kimi · 国内');
    expect(PREDEFINED_GROUPS).toContain('Kimi');
    expect(PREDEFINED_GROUPS).toContain('Moonshot');
    expect(normalizeGroupName('Kimi 国际')).toBe('Moonshot');
    expect(normalizeGroupName('Kimi · 国际')).toBe('Moonshot');
    expect(normalizeGroupName('Kimi 国内')).toBe('Kimi');
    expect(normalizeGroupName('Kimi · 国内')).toBe('Kimi');
    expect(normalizeGroupName('小米 MiMo Token Plan')).toBe('小米 MiMo');
    expect(normalizeGroupName('StepFun')).toBe('阶跃星辰');
  });

  it('resets the key name and group baseline when switching providers', () => {
    const groups = ['MiniMax · 国内', 'OpenAI'];
    const minimax = getAutoCreatePlatformFields(platform('minimax', 'MINIMAX_API_KEY', 'MiniMax · 国内'), groups);
    const openai = getAutoCreatePlatformFields(platform('openai', 'OPENAI_API_KEY', 'OpenAI'), groups);

    expect(minimax).toEqual({ key: '', group: 'MiniMax · 国内', groupCustom: '' });
    expect(openai).toEqual({ key: '', group: 'OpenAI', groupCustom: '' });
    expect(openai.key).toBe('');
    expect(openai.group).not.toContain('MiniMax');
  });

  it('uses a custom group field when the provider group is not in the current list', () => {
    expect(getAutoCreatePlatformFields(platform('new-provider', 'NEW_PROVIDER_KEY', 'New Provider'), [])).toEqual({
      key: '',
      group: '__custom__',
      groupCustom: 'New Provider',
    });
  });

  it('places Kimi Coding Plan in the mainland Kimi group', () => {
    expect(getAutoCreatePlatformFields(platform('kimi-coding-plan', 'KIMI_CODE_API_KEY', 'Kimi'), [])).toEqual({
      key: '',
      group: 'Kimi',
      groupCustom: '',
    });
  });

  it('places MiMo Token Plan in the shared Xiaomi MiMo group', () => {
    expect(getAutoCreatePlatformFields(platform('xiaomi-coding', 'XIAOMI_MIMO_TOKEN_PLAN_API_KEY', '小米 MiMo'), [])).toEqual({
      key: '',
      group: '小米 MiMo',
      groupCustom: '',
    });
  });

  it('places StepFun keys in the canonical Chinese group', () => {
    expect(getAutoCreatePlatformFields(platform('stepfun', 'STEPFUN_API_KEY', '阶跃星辰'), [])).toEqual({
      key: '',
      group: '阶跃星辰',
      groupCustom: '',
    });
  });
});
