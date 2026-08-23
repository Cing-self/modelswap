export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export type UpgradeLevel = "patch" | "minor" | "major" | "unknown";

// 从杂乱的版本字符串中提取 semver
// 例: "git version 2.50.1 (Apple Git-155)" → { major: 2, minor: 50, patch: 1 }
// 例: "v24.13.0" → { major: 24, minor: 13, patch: 0 }
// 例: "Homebrew 5.1.3" → { major: 5, minor: 1, patch: 3 }
// 例: "0.67.0 (Homebrew)" → { major: 0, minor: 67, patch: 0 }
// 例: "8.0.1" → { major: 8, minor: 0, patch: 1 }
export function parseSemVer(raw: string): SemVer | null {
  if (!raw) return null;
  // 匹配 x.y.z 或 x.y 格式的版本号
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] !== undefined ? parseInt(match[3], 10) : 0,
    raw,
  };
}

// 比较两个版本，返回升级级别
export function compareVersions(current: SemVer, available: SemVer): UpgradeLevel {
  if (available.major > current.major) return "major";
  if (available.major === current.major && available.minor > current.minor) return "minor";
  if (
    available.major === current.major &&
    available.minor === current.minor &&
    available.patch > current.patch
  ) return "patch";
  return "unknown";
}

// 获取升级级别的风险描述
export function upgradeLevelLabel(level: UpgradeLevel, lang: "zh" | "en" = "zh"): string {
  const labels: Record<UpgradeLevel, Record<string, string>> = {
    patch: { zh: "补丁", en: "patch" },
    minor: { zh: "次版本", en: "minor" },
    major: { zh: "主版本", en: "major" },
    unknown: { zh: "未知", en: "unknown" },
  };
  return labels[level][lang] || labels[level].en;
}

// 获取升级建议
export function upgradeAdvice(level: UpgradeLevel, lang: "zh" | "en" = "zh"): string {
  const advice: Record<UpgradeLevel, Record<string, string>> = {
    patch: {
      zh: "安全升级，建议自动执行",
      en: "Safe to auto-upgrade",
    },
    minor: {
      zh: "一般安全，建议检查 changelog",
      en: "Generally safe, check changelog",
    },
    major: {
      zh: "可能有 breaking changes，需评估影响",
      en: "May have breaking changes, assess impact",
    },
    unknown: {
      zh: "无法判断，建议手动检查",
      en: "Cannot determine, check manually",
    },
  };
  return advice[level][lang] || advice[level].en;
}
