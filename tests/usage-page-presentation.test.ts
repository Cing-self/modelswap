import { describe, expect, it } from 'vitest';
import {
  credentialGuideForProvider,
  PROVIDER_META,
  type UsageTranslate,
} from '../src/web/frontend/src/components/usage/usageCatalog';
import {
  compactAlertMessage,
  formatBalanceAmount,
  getPrepaidRemainingPercent,
  isGuidedConfigurationMessage,
  usageSeverity,
} from '../src/web/frontend/src/components/usage/usagePresentation';
import { cloudBalanceGuideConfig } from '../src/web/frontend/src/components/usage/usageCredentialGuides';

describe('usage page catalog and presentation helpers', () => {
  it('keeps credential guide routing scoped to the supported cloud balance providers', () => {
    expect(credentialGuideForProvider('volcengine-coding')).toBe('volcengine');
    expect(credentialGuideForProvider('qianfan')).toBe('baidu-billing');
    expect(credentialGuideForProvider('openrouter')).toBeNull();
    expect(PROVIDER_META.openrouter.kind).toBe('prepaid');
  });

  it('formats balance values without changing non-USD units', () => {
    expect(formatBalanceAmount(12.3)).toBe('$12.30');
    expect(formatBalanceAmount(12.3, 'M Credits')).toBe('12.30 M Credits');
    expect(
      compactAlertMessage(
        'DeepSeek 将在 5h 后重置，还有 20% 未使用',
        'DeepSeek',
      ),
    ).toBe('5h 后重置 · 20% 未用');
  });

  it('classifies balance and subscription alert severity consistently', () => {
    expect(
      getPrepaidRemainingPercent({
        label: 'credits',
        usedPercent: null,
        resetAt: null,
        isPrepaid: true,
        remainingCredits: 2,
        limitCredits: 20,
      }),
    ).toBe(10);
    expect(
      usageSeverity({
        label: 'credits',
        usedPercent: null,
        resetAt: null,
        isPrepaid: true,
        remainingCredits: 2,
        limitCredits: 20,
      }),
    ).toBe(2);
    expect(usageSeverity({ label: '5h', usedPercent: 75, resetAt: null })).toBe(
      1,
    );
    expect(usageSeverity({ label: '5h', usedPercent: 95, resetAt: null })).toBe(
      2,
    );
  });

  it('recognizes credential-required notices before showing a concise guide', () => {
    expect(
      isGuidedConfigurationMessage('请在密钥管理中配置 AK/SK 后重试'),
    ).toBe(true);
    expect(isGuidedConfigurationMessage('服务暂时不可用')).toBe(false);
  });

  it('keeps cloud credential catalog details separate from the guide component', () => {
    const t = ((key: string) => key) as UsageTranslate;
    const config = cloudBalanceGuideConfig('tencent-billing', t);

    expect(config.combinedName).toBe('TENCENT_CLOUD_CREDENTIALS');
    expect(config.permission).toBe('finance:DescribeAccountBalance');
    expect(config.consoleUrl).toBe(
      'https://console.cloud.tencent.com/cam/user',
    );
  });
});
