import type { CloudBalanceGuide, UsageTranslate } from './usageCatalog';

export type CloudBalanceGuideConfig = {
  title: string;
  lede: string;
  userBody: string;
  accessMode: string;
  accessModeLabel: string;
  permissionBody: string;
  permission: string;
  permissionLabel: string;
  permissionUrl?: string;
  permissionUrlLabel?: string;
  consoleUrl: string;
  consoleLabel: string;
  docsUrl: string;
  docsLabel: string;
  combinedName: string;
  group: string;
  accessKeyLabel: string;
  secretKeyLabel: string;
  credentialBody: string;
};

export function cloudBalanceGuideConfig(
  provider: CloudBalanceGuide,
  t: UsageTranslate,
): CloudBalanceGuideConfig {
  const configs: Record<CloudBalanceGuide, CloudBalanceGuideConfig> = {
    'aliyun-billing': {
      title: t('usage.aliyunGuide.title'),
      lede: t('usage.aliyunGuide.lede'),
      userBody: t('usage.aliyunGuide.userBody'),
      accessMode: t('usage.aliyunGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.aliyunGuide.permissionBody'),
      permission: 'AliyunBSSReadOnlyAccess',
      permissionLabel: t('usage.aliyunGuide.permissionLabel'),
      consoleUrl: 'https://ram.console.aliyun.com/users',
      consoleLabel: t('usage.aliyunGuide.openConsole'),
      docsUrl:
        'https://help.aliyun.com/zh/ram/developer-reference/aliyunbssreadonlyaccess',
      docsLabel: t('usage.aliyunGuide.officialDocs'),
      combinedName: 'ALIYUN_BILLING_CREDENTIALS',
      group: '阿里云百炼',
      accessKeyLabel: 'AccessKey ID',
      secretKeyLabel: 'AccessKey Secret',
      credentialBody: t('usage.aliyunGuide.credentialBody'),
    },
    'baidu-billing': {
      title: t('usage.baiduGuide.title'),
      lede: t('usage.baiduGuide.lede'),
      userBody: t('usage.baiduGuide.userBody'),
      accessMode: t('usage.baiduGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.baiduGuide.permissionBody'),
      permission: t('usage.baiduGuide.permissionName'),
      permissionLabel: t('usage.baiduGuide.permissionLabel'),
      consoleUrl: 'https://console.bce.baidu.com/iam/',
      consoleLabel: t('usage.baiduGuide.openConsole'),
      docsUrl: 'https://cloud.baidu.com/doc/Finance/s/Zlbu72qyo',
      docsLabel: t('usage.baiduGuide.officialDocs'),
      combinedName: 'QIANFAN_BCE_CREDENTIALS',
      group: '百度千帆',
      accessKeyLabel: 'AccessKey ID',
      secretKeyLabel: 'Secret Access Key',
      credentialBody: t('usage.baiduGuide.credentialBody'),
    },
    'tencent-billing': {
      title: t('usage.tencentBillingGuide.title'),
      lede: t('usage.tencentBillingGuide.lede'),
      userBody: t('usage.tencentBillingGuide.userBody'),
      accessMode: t('usage.tencentBillingGuide.accessMode'),
      accessModeLabel: t('usage.cloudGuide.accessModeRequired'),
      permissionBody: t('usage.tencentBillingGuide.permissionBody'),
      permission: 'finance:DescribeAccountBalance',
      permissionLabel: t('usage.tencentBillingGuide.permissionLabel'),
      permissionUrl: 'https://console.cloud.tencent.com/cam/policy',
      permissionUrlLabel: t('usage.tencentBillingGuide.openPolicyConsole'),
      consoleUrl: 'https://console.cloud.tencent.com/cam/user',
      consoleLabel: t('usage.tencentBillingGuide.openConsole'),
      docsUrl: 'https://cloud.tencent.com/document/product/555/61542',
      docsLabel: t('usage.tencentBillingGuide.officialDocs'),
      combinedName: 'TENCENT_CLOUD_CREDENTIALS',
      group: '腾讯云',
      accessKeyLabel: 'SecretId',
      secretKeyLabel: 'SecretKey',
      credentialBody: t('usage.tencentBillingGuide.credentialBody'),
    },
  };

  return configs[provider];
}
