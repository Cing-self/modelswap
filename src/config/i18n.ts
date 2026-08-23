import { loadUserConfig, updateUserConfig } from "./user";

export type Language = "zh" | "en";

export interface Translations {
  lang: Language;
  back: string;
  success: string;
  failed: string;
  mainHelpHint: string;
  // check 命令
  // upgrade assessment
  // profile
  // auth
  // vault
  vaultSaved: string;
  vaultAutoSync: string;
  vaultTargets: string;
  vaultSynced: string;
  vaultNotFound: string;
  vaultEmpty: string;
  vaultListTitle: string;
  vaultConfirmDelete: string;
  vaultDeleted: string;
  vaultNoOkitEnv: string;
  vaultNoKeys: string;
  vaultEnvWritten: string;
  vaultResolved: string;
  vaultMissing: string;
  vaultNoBindings: string;
  vaultWhereTitle: string;
  vaultSyncing: string;
  vaultSyncResult: string;
  vaultValuePrompt: string;
  vaultValueRequired: string;
  // provider
  providerListTitle: string;
  providerSelectAgent: string;
  providerSelectProvider: string;
  providerSelectModel: string;
  providerName: string;
  providerType: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerModels: string;
  providerPreset: string;
  providerPresetCustom: string;
  providerAdded: string;
  providerDeleted: string;
  providerNotFound: string;
  providerNoProviders: string;
  providerCancel: string;
  providerConfirmDelete: string;
  providerSwitched: string;
  providerCurrentTitle: string;
  providerAgentNotConfigured: string;
  providerAuthTitle: string;
  providerAuthApiKey: string;
  providerAuthOAuth: string;
  providerAuthNone: string;
  providerAuthLoggedIn: string;
  providerAuthNotLoggedIn: string;
  providerId: string;
}

const translations: Record<Language, Translations> = {
  zh: {
    lang: "zh",
    back: "返回",
    success: "成功",
    failed: "失败",
    mainHelpHint: "提示: 在主菜单选择“帮助”可查看帮助",
    // check 命令
    // profile
    // auth
    // vault
    vaultSaved: "已保存:",
    vaultAutoSync: "自动同步到",
    vaultTargets: "个目标",
    vaultSynced: "已同步",
    vaultNotFound: "未找到:",
    vaultEmpty: "Vault 为空，使用 okit vault set KEY value 添加",
    vaultListTitle: "Vault 密钥列表",
    vaultConfirmDelete: "确认删除",
    vaultDeleted: "已删除:",
    vaultNoOkitEnv: "当前目录未找到 .okitenv 文件",
    vaultNoKeys: "未声明任何 key",
    vaultEnvWritten: "已写入:",
    vaultResolved: "已解析",
    vaultMissing: "缺失",
    vaultNoBindings: "未找到关联项目",
    vaultWhereTitle: "关联项目:",
    vaultSyncing: "正在同步所有关联文件...",
    vaultSyncResult: "同步结果:",
    vaultValuePrompt: "输入密钥值",
    vaultValueRequired: "请交互输入密钥，或通过 --stdin 读取；不要把密钥写进命令参数",
    // provider
    providerListTitle: "Provider 列表",
    providerSelectAgent: "选择 Agent",
    providerSelectProvider: "选择 Provider",
    providerSelectModel: "选择模型",
    providerName: "Provider 名称",
    providerType: "API 类型",
    providerBaseUrl: "Base URL",
    providerApiKey: "API Key",
    providerModels: "模型列表（逗号分隔）",
    providerPreset: "选择预置 Provider",
    providerPresetCustom: "自定义",
    providerAdded: "已添加 Provider",
    providerDeleted: "已删除 Provider",
    providerNotFound: "未找到 Provider",
    providerNoProviders: "暂无 Provider，请先添加",
    providerCancel: "已取消",
    providerConfirmDelete: "确认删除 Provider？",
    providerSwitched: "已切换",
    providerCurrentTitle: "当前 Agent 配置",
    providerAgentNotConfigured: "未配置",
    providerAuthTitle: "认证状态",
    providerAuthApiKey: "API Key",
    providerAuthOAuth: "OAuth",
    providerAuthNone: "未认证",
    providerAuthLoggedIn: "已登录",
    providerAuthNotLoggedIn: "未登录",
    providerId: "ID",
  },
  en: {
    lang: "en",
    back: "Back",
    success: "Success",
    failed: "Failed",
    mainHelpHint: "Hint: Choose \u201cHelp\u201d in the main menu to view help",
    // check command
    // profile
    // auth
    // vault
    vaultSaved: "Saved:",
    vaultAutoSync: "Auto-syncing to",
    vaultTargets: "targets",
    vaultSynced: "Synced",
    vaultNotFound: "Not found:",
    vaultEmpty: "Vault is empty, use okit vault set KEY value to add",
    vaultListTitle: "Vault Secrets",
    vaultConfirmDelete: "Delete",
    vaultDeleted: "Deleted:",
    vaultNoOkitEnv: "No .okitenv file found in current directory",
    vaultNoKeys: "No keys declared",
    vaultEnvWritten: "Written to:",
    vaultResolved: "Resolved",
    vaultMissing: "Missing",
    vaultNoBindings: "No project bindings found",
    vaultWhereTitle: "Used in:",
    vaultSyncing: "Syncing all bound files...",
    vaultSyncResult: "Sync result:",
    vaultValuePrompt: "Enter secret value",
    vaultValueRequired: "Enter the secret interactively or read it with --stdin; do not put secrets in command arguments",
    // provider
    providerListTitle: "Provider List",
    providerSelectAgent: "Select Agent",
    providerSelectProvider: "Select Provider",
    providerSelectModel: "Select Model",
    providerName: "Provider Name",
    providerType: "API Type",
    providerBaseUrl: "Base URL",
    providerApiKey: "API Key",
    providerModels: "Models (comma-separated)",
    providerPreset: "Choose preset provider",
    providerPresetCustom: "Custom",
    providerAdded: "Provider added",
    providerDeleted: "Provider deleted",
    providerNotFound: "Provider not found",
    providerNoProviders: "No providers yet, add one first",
    providerCancel: "Cancelled",
    providerConfirmDelete: "Delete provider?",
    providerSwitched: "Switched",
    providerCurrentTitle: "Current Agent Config",
    providerAgentNotConfigured: "Not configured",
    providerAuthTitle: "Auth Status",
    providerAuthApiKey: "API Key",
    providerAuthOAuth: "OAuth",
    providerAuthNone: "Not authenticated",
    providerAuthLoggedIn: "Logged in",
    providerAuthNotLoggedIn: "Not logged in",
    providerId: "ID",
  },
};

let currentLang: Language = "zh";

// 加载保存的语言配置
export async function loadLanguageConfig(): Promise<Language | null> {
  const config = await loadUserConfig();
  if (config.language && (config.language === "zh" || config.language === "en")) {
    return config.language;
  }
  return null;
}

// 保存语言配置
export async function saveLanguageConfig(lang: Language): Promise<void> {
  try {
    await updateUserConfig({ language: lang });
  } catch {
    // 保存失败静默处理
  }
}

// 初始化语言（从配置文件或默认）
export async function initLanguage(): Promise<void> {
  const savedLang = await loadLanguageConfig();
  if (savedLang) {
    currentLang = savedLang;
  }
}

export function setLanguage(lang: Language) {
  currentLang = lang;
  // 异步保存，不阻塞
  saveLanguageConfig(lang).catch(() => {});
}

export function getLanguage(): Language {
  return currentLang;
}

export function t(key: keyof Translations): string {
  return translations[currentLang][key];
}
