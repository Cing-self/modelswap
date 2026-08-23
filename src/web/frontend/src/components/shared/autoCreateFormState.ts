import type { AutoCreatePlatform } from '../../api/vault';
import { normalizeGroupName, PREDEFINED_GROUPS } from '../../data/vault-groups';

export interface AutoCreatePlatformFields {
  key: string;
  group: string;
  groupCustom: string;
}

/** Return the complete form baseline for one selected provider. */
export function getAutoCreatePlatformFields(platform: AutoCreatePlatform, groups: string[]): AutoCreatePlatformFields {
  const groupHint = normalizeGroupName(platform.groupHint || '');
  if (!groupHint) return { key: '', group: '', groupCustom: '' };
  if (PREDEFINED_GROUPS.includes(groupHint) || groups.includes(groupHint)) {
    return { key: '', group: groupHint, groupCustom: '' };
  }
  return { key: '', group: '__custom__', groupCustom: groupHint };
}
