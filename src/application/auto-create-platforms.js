// Static browser platform catalogue and its derived indexes.
function createAutoCreatePlatforms(deps) {
  const { ZHIPU_URL, VOLC_URL, VOLC_AGENT_PLAN_URL, MINIMAX_URL } = deps;
const AUTO_CREATE_PLATFORMS = [
  { id: 'cloudflare', label: 'Cloudflare', keyHint: 'CLOUDFLARE_TOKEN', groupHint: 'Cloudflare', mode: 'api' },
  // Verified in the authenticated Platform console: the name field is
  // "My Test Key", and the dialog ends with "Create secret key".
  { id: 'openai', label: 'OpenAI', keyHint: 'OPENAI_API_KEY', groupHint: 'OpenAI', mode: 'browser', url: 'https://platform.openai.com/api-keys', createTexts: ['Create new secret key'], createWaitAttempts: 30, deleteReadyAttempts: 30, deleteButtonSelector: 'button[data-color="danger"]', nameSelectors: ['input[placeholder="My Test Key"]'], confirmTexts: ['Create secret key'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, keyPatterns: ['sk-(?:proj-)?[A-Za-z0-9_-]{20,}'] },
  { id: 'anthropic', label: 'Anthropic', keyHint: 'ANTHROPIC_API_KEY', groupHint: 'Anthropic', mode: 'browser', url: 'https://platform.claude.com/settings/workspaces/default/keys', createTexts: ['Create Key', 'Create API Key', 'Create key', '创建 API Key', '创建密钥', '新建 API Key'], formReadyAttempts: 8, deleteMenuTexts: ['More actions', '更多操作', 'More', '更多', '⋯', '…'], nameSelectors: ['input[placeholder*="key name" i]', 'input[placeholder*="name" i]', 'input[aria-label*="key name" i]', 'input[aria-label="Name" i]', 'input[name*="name" i]', 'input[id*="name" i]', 'input[placeholder*="密钥名" i]', 'input[aria-label*="密钥名" i]'], requireNameInput: true, allowDialogTextInputFallback: true, preConfirmSelectDefaults: [{ triggerTexts: ['Select an expiration', '3 hours', '1 day', '7 days', '30 days', '选择到期时间', '3 小时', '1 天', '7 天', '30 天'], optionTexts: ['Never', 'No expiration', '永不过期'], optional: true }], confirmTexts: ['Add', 'Create key', 'Create Key', 'Create', '添加', '创建密钥', '创建'], allowConfirmCreateText: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 5, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', 'input[value*="sk-ant"]', 'code', 'span.font-mono', 'div.font-mono'], postCreateCopyTexts: ['Copy'], postCreateCopyAttempts: 10, postCreateCopyRetryMs: 800, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-ant-api[a-zA-Z0-9_-]{16,}'] },
  // Verified in the signed-in Chinese AI Studio UI: the key is named through
  // its aria-labelled input and finalized with "创建密钥".
  { id: 'volcengine', label: '火山方舟（普通 API Key）', keyHint: 'VOLCENGINE_API_KEY', groupHint: '火山方舟', mode: 'browser', url: VOLC_URL },
  { id: 'volcengine-agent', label: '火山方舟 Agent Plan', keyHint: 'VOLCENGINE_AGENT_PLAN_API_KEY', groupHint: '火山方舟 Agent Plan', mode: 'browser', url: VOLC_AGENT_PLAN_URL },
  // Volcengine's traditional AK/SK is intentionally manual-only. It is an
  // IAM identity credential, not an API key, and its permissions/rotation
  // limits cannot be safely managed by this browser key flow. See
  // docs/volcengine-usage-credentials.md.
  // Tencent Cloud's normal TokenHub API Key is separate from the Token Plan
  // key. The normal key is created in API Key management and must be granted
  // an access scope/model binding there.
  { id: 'tencent', label: '腾讯云', keyHint: 'TENCENT_API_KEY', groupHint: '腾讯云', mode: 'browser', url: 'https://console.cloud.tencent.com/tokenhub/apikey', createTexts: ['创建 API Key', '创建API Key', '创建 API 密钥', '创建API密钥', '新建 API 密钥', '新建API密钥'], nameSelectors: ['input[placeholder*="生产环境"]', 'input[placeholder*="Key"]', 'input[placeholder*="密钥名称"]', 'input[placeholder*="API Key"]', 'input[placeholder*="名称"]'], inlineFormScope: true, deleteSecurityVerificationTexts: ['身份验证', '微信扫码验证', 'MFA'], confirmTexts: ['确认', '确定', '创建'], postCreateCopyTexts: ['复制'], postCreateCopyByMaskedKeyPrefix: 'sk-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Token Plan keys live on the Token Plan tabs, are reused/copied only, and
  // are not interchangeable with normal TokenHub API Keys. The official key
  // format is sk-tp-... .
  { id: 'tencent-token-plan', label: '腾讯云 Token Plan', keyHint: 'TENCENT_TOKEN_PLAN_API_KEY', groupHint: '腾讯云', mode: 'browser', url: 'https://console.cloud.tencent.com/tokenhub/tokenplan', createTexts: ['生成密钥', '生成 API Key', '生成API Key', '创建 API Key', '创建API Key', '复制'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-tp-', missingExistingKeyMessage: '腾讯云 Token Plan 当前没有可复用的订阅 Key；请在 Token Plan 页面生成或复制 sk-tp- 开头的专属 Key，自动化不会重置已有 Key。', confirmTexts: ['确认', '确定', '创建'], postCreateCopyTexts: ['复制', '复制密钥', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-tp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['sk-tp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: '腾讯云 Token Plan 页面没有读取到 sk-tp- 开头的明文 Key；为避免误存普通 API Key 或重置已有 Key，请在 Token Plan 页面手动复制后重试。' },
  // Tencent SecretId/SecretKey is a CAM identity credential used by the
  // Billing API. Keep it manual-only: MODELSWAP must not acknowledge primary-account
  // risk dialogs, choose an IAM identity, or create a credential it cannot
  // synchronize after deletion in the cloud console.
  { id: 'zhipu', label: '智谱 AI（国内站）', keyHint: 'ZHIPUAI_API_KEY', groupHint: '智谱AI', mode: 'browser', url: ZHIPU_URL, deleteConfirmWaitAttempts: 20, deleteConfirmTexts: ['确定'], deleteDialogText: '此操作将永久删除该行数据' },
  // Verified on the signed-in Z.AI console: the entry is "Add API Key", then
  // the dialog requires an "API key name" before its "Create" action is enabled.
  { id: 'zai-global', label: 'Z.AI（国际站）', keyHint: 'ZAI_API_KEY', groupHint: 'Z.AI', mode: 'browser', url: 'https://z.ai/manage-apikey/apikey-list', deleteButtonSelector: 'td.ant-table-cell-fix-end > div', deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['Remove'], deleteDialogText: 'This operation will permanently delete the data', createTexts: ['Add API Key'], nameSelectors: ['input#apiKeyName', 'input[placeholder="API key name"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, postCreateRowCopySelector: 'svg.lucide-copy', postCreateCopyAttempts: 20, postCreateCopyRetryMs: 1000, allowExtensionClipboardRead: true, requirePostCreateCopy: true, keyPatterns: ['[^.\\s]{8,128}\\.[^.\\s]{8,256}'], postCreateCopyFailureMessage: 'Z.AI 已创建 API Key，但列表复制控件没有返回可保存的明文；为避免保存掩码，已停止写入 Vault。' },
  { id: 'minimax', label: 'MiniMax（国内站）', keyHint: 'MINIMAX_API_KEY', groupHint: 'MiniMax · 国内', mode: 'browser', url: MINIMAX_URL, deleteDomRetry: true, deleteConfirmTexts: ['删 除'], deleteDialogText: '此 API Key 将立即被禁用', deleteConfirmWaitAttempts: 10 },
  // Token Plan uses a dedicated sk-cp key that is not interchangeable with
  // the ordinary pay-as-you-go API key. The subscribed account exposes the
  // key on the Token Plan page and may already have generated it.
  { id: 'minimax-coding', label: 'MiniMax Token Plan（国内）', keyHint: 'MINIMAX_TOKEN_PLAN_API_KEY', groupHint: 'MiniMax · 国内', mode: 'browser', url: 'https://platform.minimaxi.com/console/plan', createTexts: ['复制', '复 制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-cp-', missingExistingKeyMessage: 'MiniMax Token Plan（国内）页面没有显示可复制的订阅 Key。请确认账户已获得订阅 Key；自动化不会点击“重置 Key”。', postCreateCopyTexts: ['复制', '复 制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-cp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-cp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: 'MiniMax Token Plan（国内）页面已打开，但没有从订阅 Key 旁的复制按钮读取到明文。自动化不会点击“重置 Key”，以免现有 Key 失效。' },
  // Verified on the signed-in international console: "Create new API Key"
  // opens a named form whose final action is simply "Create".
  { id: 'minimax-global', label: 'MiniMax（国际站）', keyHint: 'MINIMAX_GLOBAL_API_KEY', groupHint: 'MiniMax · 国际', mode: 'browser', url: 'https://platform.minimax.io/user-center/basic-information/interface-key', deleteDomRetry: true, createTexts: ['Create new API Key'], deleteDisplayNameLength: 45, deleteConfirmTexts: ['Revoke'], deleteDialogText: 'This API Key will be immediately disabled', nameSelectors: ['input#token_name', 'input[placeholder="Please enter a key name"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, keyPatterns: ['sk-(?:api-)?[A-Za-z0-9_-]{20,}'] },
  // The international Token Plan mirrors the mainland console: one account
  // subscription key is shown on Plan details and copied in place. Never use
  // the ordinary API Keys page or click Reset key during automatic capture.
  { id: 'minimax-global-coding', label: 'MiniMax Token Plan（国际）', keyHint: 'MINIMAX_GLOBAL_TOKEN_PLAN_API_KEY', groupHint: 'MiniMax · 国际', mode: 'browser', url: 'https://platform.minimax.io/console/plan', deleteDisplayNameLength: 45, createTexts: ['Copy', '复制', '复 制'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-cp-', missingExistingKeyMessage: 'MiniMax Token Plan（国际）页面没有显示可复制的 Subscription Key。请确认账户已获得订阅 Key；自动化不会点击 Reset key。', postCreateCopyTexts: ['Copy', 'Copy key', '复制', '复 制', '复制密钥'], postCreateCopyByMaskedKeyPrefix: 'sk-cp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-cp-[A-Za-z0-9_-]{10,}'], postCreateCopyFailureMessage: 'MiniMax Token Plan（国际）页面已打开，但没有从 Subscription Key 旁的 Copy 按钮读取到明文。自动化不会点击 Reset key，以免现有 Key 失效。' },
  // DeepSeek's current console uses custom div[role="button"] controls. The
  // create flow is exactly: dismiss the optional email reminder, open
  // "创建 API key", enter the name, then press the dialog's exact "创建".
  // Use real text insertion and a foreground click for the final control so
  // React enables the button instead of leaving its ds-button--disabled class
  // in place after a synthetic value assignment.
  { id: 'deepseek', label: 'DeepSeek', keyHint: 'DEEPSEEK_API_KEY', groupHint: 'DeepSeek', mode: 'browser', url: 'https://platform.deepseek.com/api_keys', deleteReload: true, deleteReloadWaitMs: 2500, deleteReadyAttempts: 20, deletePreDismissTexts: ['稍后再填'], deleteButtonIndex: 1, deleteConfirmTexts: ['删除'], preCreateDismissTexts: ['稍后再填'], createTexts: ['Create new API key', 'Create API key', '创建 API Key', '创建新密钥'], nameSelectors: ['input[placeholder="输入 API key 的名称"]', 'input[placeholder*="输入 API key 的名称"]', 'input[placeholder*="API key 的名称"]'], nameFillViaInput: true, confirmByExactText: true, confirmNeedsForeground: true, confirmTexts: ['创建'], postCreateDomReadAttempts: 8, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], readyAfterMs: 15000 },
  // Verified against the signed-in Kimi international console. The form
  // requires both a name and a project; only its visible `default` project is
  // eligible for automatic selection.
  { id: 'moonshot', label: 'Moonshot API 平台', keyHint: 'MOONSHOT_API_KEY', groupHint: 'Moonshot', mode: 'browser', url: 'https://platform.kimi.ai/console/api-keys', createTexts: ['Create API Key'], createWaitAttempts: 10, nameMaxLength: 30, nameSelectors: ['input[placeholder*="Maximum 32"]'], defaultProjectLabel: 'default', confirmTexts: ['OK'], confirmNeedsForeground: true, confirmKeyboardFallback: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 5, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', 'input[value^="sk-"]'], deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['Confirm'], deleteConfirmSelector: 'button.ant-btn-primary', deleteDialogText: 'Confirm Delete API Key?', deleteConfirmDomRetry: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Keep the stable ID for existing configurations. The Kimi product uses the
  // mainland API console, not the separate Kimi Code subscription page.
  { id: 'kimi-coding', label: 'Kimi（国内站）', keyHint: 'KIMI_API_KEY', groupHint: 'Kimi', mode: 'browser', url: 'https://platform.kimi.com/console/api-keys', createTexts: ['新建 API Key'], createWaitAttempts: 10, nameMaxLength: 32, nameSelectors: ['input[placeholder*="最多输入32"]'], defaultProjectLabel: 'default', confirmTexts: ['确定', '确 定'], confirmByExactText: true, confirmNeedsForeground: false, confirmKeyboardFallback: false, confirmForceKeyboardFallback: false, postCreateDomReadAttempts: 20, postCreateCopyTexts: ['复制', 'Copy', 'copy'], postCreateCopyAttempts: 20, postCreateCopyRetryMs: 800, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 10, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', '[role="dialog"] input', 'input[value^="sk-"]'], deleteConfirmWaitAttempts: 10, deleteConfirmTexts: ['确 认', '确认'], deleteDialogText: '确定删除 API Key', keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], postCreateCopyFailureMessage: 'Kimi API Key 已创建，但没有从创建结果的复制按钮读取到一次性明文；请在结果弹窗中手动点击复制后重试。' },
  // Kimi Code subscription keys are managed separately from Kimi Open
  // Platform keys. The console allows up to five named keys and only shows a
  // newly-created secret once, so create a uniquely named key and capture its
  // one-time result instead of trying to reuse a masked row.
  { id: 'kimi-coding-plan', label: 'Kimi Coding Plan', keyHint: 'KIMI_CODE_API_KEY', defaultKeyName: 'KIMI_CODING_PLAN_API_KEY', groupHint: 'Kimi', mode: 'browser', url: 'https://www.kimi.com/code/console', loginRequiredOnPublicRoot: true, createDirectSelector: 'button.create-api-btn', createSelectors: ['button.create-api-btn'], createTexts: ['Create New API Key', 'Create API Key', '创建新的 API Key', '创建新 API Key', '创建 API Key', '新建 API Key'], createWaitAttempts: 12, nameMaxLength: 32, nameSelectors: ['input[placeholder*="名称"]', 'input[placeholder*="name" i]', 'input[name*="name" i]', 'textarea[placeholder*="名称"]', 'textarea[placeholder*="name" i]'], confirmTexts: ['Create', 'Create API Key', '创建', '创建 API Key', '新建 API Key', '新建', '确定'], confirmSelectors: ['.modal-mask .modal-actions button.kimi-button.primary'], allowConfirmCreateText: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 8, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] input[type="text"]', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]', 'input[value^="sk-"]', 'code'], postCreateCopyTexts: ['Copy key', 'Copy', '复制密钥', '复制'], postCreateCopyAttempts: 12, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'], postCreateCopyFailureMessage: 'Kimi Code API Key 已创建，但创建结果的复制控件没有返回可保存的明文；该 Key 只在创建时显示一次，请在 Kimi Code 控制台手动复制后再录入 Vault。' },
  // Verified in the signed-in Bailian console: the default workspace is
  // already selected; fill its optional description textarea before "确定".
  { id: 'qwen', label: '阿里云百炼', keyHint: 'DASHSCOPE_API_KEY', groupHint: '阿里云百炼', mode: 'browser', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', deleteReadyAttempts: 20, deleteTexts: ['删除'], deleteNoConfirm: true, deleteNoConfirmDomRetry: true, deleteNoConfirmReload: true, deleteNoConfirmReloadWaitMs: 900, createTexts: ['创建API Key'], createWaitAttempts: 10, nameSelectors: ['textarea#description'], confirmTexts: ['确定'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9._-]{20,}'] },
  // 阿里云百炼 Coding Plan — 套餐专属 key，同一个控制台但独立管理页
  // Alibaba Coding Plan supports one dedicated sk-sp- key per subscription.
  // Reuse/copy it instead of submitting a second create action; the provider
  // exposes Reset separately and resetting would invalidate existing clients.
  { id: 'qwen-coding', label: '阿里云百炼 Coding Plan', keyHint: 'DASHSCOPE_CODING_API_KEY', groupHint: '阿里云百炼 Coding Plan', mode: 'browser', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key?plan=coding', createTexts: ['复制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-sp-', missingExistingKeyMessage: '阿里云百炼 Coding Plan 当前没有可复用的专属 Key；请在 Coding Plan 页面获取或复制 sk-sp- 开头的 Key，自动化不会点击“重置 API Key”。', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-sp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-sp-[A-Za-z0-9._-]{20,}'], postCreateCopyFailureMessage: '阿里云百炼 Coding Plan 已有专属 Key，但没有读取到可保存的明文；自动化不会重置 Key，请在 Coding Plan 页面手动复制后重试。' },
  // Token Plan keys are generated on the signed-in My Subscription page and
  // start with sk-sp-. Reuse an existing masked key and copy it; do not reset
  // a live subscription key just to automate vault setup.
  { id: 'qwen-token-plan', label: '阿里云百炼 Token Plan', keyHint: 'DASHSCOPE_TOKEN_PLAN_API_KEY', groupHint: '阿里云百炼', mode: 'browser', url: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan', createTexts: ['生成 API Key', '生成API Key', '生成', 'Generate API Key', '复制', 'Copy'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'sk-sp-', missingExistingKeyMessage: '阿里云百炼 Token Plan 当前没有可复用的订阅 Key；自动化不会生成新的用户 Key。', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'sk-sp-', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 6, keyPatterns: ['sk-sp-[A-Za-z0-9._-]{20,}'], postCreateCopyFailureMessage: '阿里云百炼 Token Plan 已有订阅 Key，但没有读取到可保存的明文；自动化不会生成新的 Key。' },
  // The former /manage/ak route is no longer the current RAM credential
  // surface. The signed-in account page is /profile/accessKey; RAM-user keys
  // are created from 身份管理 > 用户 > 凭证管理, so this flow must never guess
  // which RAM user to mutate.
  // Alibaba Cloud AccessKey is an account-level RAM credential. Keep it out
  // of browser auto-create so MODELSWAP never acknowledges a root-account risk
  // dialog or creates an identity credential on the user's behalf. The usage
  // adapter continues to accept manually stored, least-privilege RAM keys.
  // SiliconFlow exposes OpenAI-compatible Bearer keys from its account page.
  { id: 'siliconflow', label: '硅基流动', keyHint: 'SILICONFLOW_API_KEY', groupHint: '硅基流动', mode: 'browser', url: 'https://cloud.siliconflow.cn/account/ak', createTexts: ['新建API密钥', '新建 API 密钥', '创建API密钥', '创建 API 密钥'], nameSelectors: ['input[placeholder*="密钥名称"]', 'input[placeholder*="请输入描述"]', 'input[placeholder*="描述"]', 'input[placeholder*="名称"]'], confirmTexts: ['新建密钥'], deleteDomFirst: true, deleteConfirmWaitAttempts: 10, deleteDialogText: '确认删除密钥', deleteConfirmInputFromDialog: true, deleteConfirmTexts: ['确认删除'], postCreateDomReadAttempts: 5, postCreateReadAttempts: 5, postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 500, allowExtensionClipboardRead: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Verified on the signed-in BCE API Key page: clicking the list toolbar
  // starts an async route transition before the name form is mounted. Wait
  // for that real form instead of treating the still-visible AI-assistant
  // recommendations as a failed confirmation state.
  { id: 'qianfan', label: '百度千帆', keyHint: 'QIANFAN_API_KEY', groupHint: '百度千帆', mode: 'browser', url: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', createTexts: ['创建API Key'], formReadyAttempts: 12, formReadyDelayMs: 500, inlineFormScope: true, deleteDomFirst: true, deleteAllowMissingAfterClick: true, deleteTextSelector: 'span.idaas-column-operate-item', deleteConfirmWaitAttempts: 10, deleteDialogText: '删除API Key', deleteSecurityVerificationTexts: ['安全验证', '短信验证码'], nameSelectors: ['input#name', 'input[placeholder*="1-64"]'], confirmTexts: ['确定'], postCreateReadAttempts: 5, keyPatterns: ['bce-v3/[A-Za-z0-9_./=-]{20,}'] },
  // Token Plan is the current Qianfan subscription product. Its dedicated
  // key is generated directly by the subscribed account and revealed only
  // through the page's verified Copy action. Reuse it when already present;
  // do not reset a live subscription key.
  { id: 'qianfan-coding', label: '百度千帆 Token Plan', keyHint: 'QIANFAN_CODING_PLAN_API_KEY', groupHint: '百度千帆', mode: 'browser', url: 'https://console.bce.baidu.com/qianfan/resource/token-plan', createTexts: ['点击生成', '复制'], createWaitAttempts: 12, creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'bce-v3/', postCreateCopyTexts: ['复制'], postCreateCopyByMaskedKeyPrefix: 'bce-v3/', postCreateCopyAttempts: 10, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['bce-v3/[A-Za-z0-9_./=-]{20,}'], existingMaskedCopyFailureMessage: '百度千帆 Token Plan 已存在专属 API Key，但复制控件没有返回可保存的明文；自动化不会点击重置，请在 Token Plan 页面手动点击复制后重试。', postCreateCopyFailureMessage: '百度千帆 Token Plan 已打开，但没有从专属 API Key 旁的复制按钮读取到明文；自动化不会点击重置，请在 Token Plan 页面手动点击复制后重试。' },
  // BCE AK/SK is likewise an IAM identity credential for finance APIs. Users
  // create a least-privilege IAM credential themselves and save it manually;
  // browser auto-create must never cross the primary-account risk prompt.
  // MiMo serves the public product page and Console from one origin. Going to
  // the homepage first leaves automation at marketing navigation; the real
  // signed-in API key screen is this exact Console route.
  // Verified on the signed-in MiMo Console: "Create API Key" opens a dialog
  // that requires its name input before the English "Confirm" button can run.
  { id: 'xiaomi', label: '小米 MiMo', keyHint: 'XIAOMI_MIMO_API_KEY', groupHint: '小米 MiMo', mode: 'browser', url: 'https://platform.xiaomimimo.com/console/api-keys', preCreateDismissTexts: ['关闭'], createTexts: ['Create API Key', '创建 API Key', '新建 API Key'], deleteTextOnly: true, deleteConfirmInputText: '确认删除', deleteConfirmInputSelector: 'input[placeholder="确认删除"]', nameSelectors: ['input#apiKeyName', 'input[placeholder="Please enter"]', 'input[placeholder*="请输入"]'], confirmTexts: ['Confirm', '确认', '确定'], postCreateReadAttempts: 5, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
  // Token Plan keys are managed on MiMo's separate subscription page. The
  // page reveals an existing dedicated key through a verified "复制/Copy"
  // action; automatic checks never create or reset a live subscription key.
  { id: 'xiaomi-coding', label: '小米 MiMo Token Plan', keyHint: 'XIAOMI_MIMO_TOKEN_PLAN_API_KEY', groupHint: '小米 MiMo', mode: 'browser', url: 'https://platform.xiaomimimo.com/console/plan-manage', createTexts: ['创建 API Key', 'Create API Key'], creationActionOnly: true, reuseExistingMaskedKey: true, existingKeyRequired: true, existingMaskedKeyPrefix: 'tp-', missingExistingKeyMessage: '小米 MiMo Token Plan 当前没有可复用的订阅 Key；自动化不会创建或重置新的用户 Key。', existingMaskedCopyFailureMessage: '小米 MiMo Token Plan 已存在 API Key，但复制控件没有返回可保存的明文；为避免重复创建，请在订阅管理页面手动点击复制后重试。An existing Token Plan API Key was found, but its Copy control returned no storable plaintext; to avoid a duplicate, copy it manually on the plan page and retry.', postCreateCopyTexts: ['复制', 'Copy'], postCreateCopyByMaskedKeyPrefix: 'tp-', postCreateCopyAttempts: 8, postCreateCopyRetryMs: 700, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 5, keyPatterns: ['tp-[A-Za-z0-9_-]{5,}'], postCreateCopyFailureMessage: '小米 MiMo Token Plan 已有订阅 Key，但没有读取到可保存的明文；自动化不会创建或重置 Key。' },
  // Verified on the signed-in interface-key page: creation requires a name in
  // the current "请输入密钥名称" field (older builds said "最多输入20个字")
  // before the "确认" action becomes enabled.
  { id: 'stepfun', label: '阶跃星辰（StepFun）', keyHint: 'STEPFUN_API_KEY', groupHint: '阶跃星辰', mode: 'browser', url: 'https://platform.stepfun.com/interface-key', createTexts: ['创建新的密钥'], formReadyAttempts: 8, nameMaxLength: 20, nameSelectors: ['input[placeholder="请输入密钥名称"]', 'input[placeholder*="请输入密钥名称"]', 'input[placeholder*="最多输入20"]'], requireNameInput: true, confirmAfterNameInput: true, confirmByExactText: true, confirmTexts: ['确认'], postCreateDomReadAttempts: 8, postCreateReadAttempts: 5, keyPatterns: ['[A-Za-z0-9_-]{32,}'] },
  // The signed-in xAI console redirects / to a team-scoped Dashboard route.
  // Follow the real sidebar link so the opaque team ID is never hard-coded.
  // Its create dialog uses the same "Create API key" label for its final
  // submit button, so this platform explicitly permits that confirmed reuse.
  { id: 'xai', label: 'xAI（Grok）', keyHint: 'XAI_API_KEY', groupHint: 'xAI', mode: 'browser', url: 'https://console.x.ai/', deleteUrl: 'https://console.x.ai/', deletePreNavigationTexts: ['API Keys'], deletePreNavigationUseHref: true, deleteReadyAttempts: 20, preNavigationTexts: ['API Keys'], createTexts: ['Create API key'], deleteMenuTexts: ['Row actions'], deleteTexts: ['Delete key'], deleteConfirmTexts: ['Confirm'], deleteMenuGlobal: true, nameSelectors: ['input[placeholder="Production key"]'], confirmTexts: ['Create API key'], allowConfirmCreateText: true, postCreateReadAttempts: 5, keyPatterns: ['xai-[A-Za-z0-9_-]{20,}'] },
  { id: 'xai-management', label: 'xAI Management Key（用量）', keyHint: 'XAI_MANAGEMENT_KEY', groupHint: 'xAI', mode: 'browser', url: 'https://console.x.ai/team/default/settings/management-keys', rowPermissionDefaults: [{ rowTexts: ['Billing'], optionTexts: ['Read only'] }], deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete key'], deleteConfirmTexts: ['Continue'], deleteDialogText: 'This will delete the management key', createTexts: ['Create management key', 'Create Management Key', 'Create key', 'New management key'], nameSelectors: ['input[placeholder*="name" i]', 'input[placeholder*="Name" i]', 'input[name*="name" i]'], confirmTexts: ['Create management key', 'Create Management Key', 'Create key', 'Create'], allowConfirmCreateText: true, postCreateReadAttempts: 6, keyPatterns: ['xai-[A-Za-z0-9_-]{20,}'] },
  // Mistral currently opens the key form directly from "New key". Older
  // workspaces first showed a profile panel with a "Create new key" action,
  // so that intermediate step remains as an optional compatibility path.
  { id: 'mistral', label: 'Mistral', keyHint: 'MISTRAL_API_KEY', groupHint: 'Mistral', mode: 'browser', url: 'https://console.mistral.ai/api-keys', deleteReadyAttempts: 20, deleteReload: true, deleteButtonIndex: 2, deleteConfirmTexts: ['Delete'], createTexts: ['New key'], formEntryTexts: ['Add a new key', 'Create new key'], formEntryOptional: true, formEntryWaitAttempts: 5, formReadyAttempts: 8, nameSelectors: ['[role="dialog"] input[placeholder="My API Key"]', '[role="dialog"] input[name="name"]', '[role="dialog"] input[placeholder*="name" i]', 'input[placeholder="My API Key"]'], confirmTexts: ['New key'], confirmSelectors: ['button[type="submit"]'], confirmAfterNameInput: true, confirmNeedsForeground: true, captureBeforeConfirm: true, allowConfirmCreateText: true, postCreateKeySelectors: ['[role="dialog"] input', '[role="dialog"] textarea', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]'], postCreateDomReadAttempts: 4, postCreateCopyTexts: ['Copy API key', 'Copy key', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 350, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateReadAttempts: 3, keyPatterns: ['\\b[A-Za-z0-9_-]{80,120}\\b', '\\b[A-Za-z0-9]{32}\\b'] },
  // /keys is OpenRouter's documented entry point. It redirects signed-in users
  // to their default workspace and signed-out users to the sign-in page.
  // Verified in the workspace keys screen: "New Key" opens a form whose
  // required name is #name and final submit action is "Create".
  { id: 'openrouter', label: 'OpenRouter', keyHint: 'OPENROUTER_API_KEY', groupHint: 'OpenRouter', mode: 'browser', url: 'https://openrouter.ai/keys', deleteReadyAttempts: 20, deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete'], deleteConfirmTexts: ['Delete'], createTexts: ['New Key'], nameSelectors: ['input#name', 'input[placeholder*="Chatbot Key"]'], confirmTexts: ['Create'], postCreateReadAttempts: 5, keyPatterns: ['sk-or-v1-[A-Za-z0-9_-]{20,}'] },
  // Account credit totals are exposed only to a Management Key. OpenRouter
  // does not offer a billing-only permission selector for this key type, so
  // the Vault UI must disclose that it has broad key-management capability.
  { id: 'openrouter-management', label: 'OpenRouter Management Key（用量）', keyHint: 'OPENROUTER_MANAGEMENT_KEY', groupHint: 'OpenRouter', mode: 'browser', permissionNote: 'openrouter-management', url: 'https://openrouter.ai/settings/management-keys', deleteReadyAttempts: 20, deleteMenuTexts: ['Row actions'], deleteMenuGlobal: true, deleteTexts: ['Delete'], deleteConfirmTexts: ['Delete'], createTexts: ['Create Management Key', 'Create management key', 'New Management Key', 'New management key', 'New Key'], nameSelectors: ['input#name', 'input[placeholder*="name" i]', 'input[name*="name" i]'], confirmTexts: ['Create Management Key', 'Create management key', 'Create'], allowConfirmCreateText: true, postCreateReadAttempts: 6, postCreateCopyTexts: ['Copy Management Key', 'Copy key', 'Copy'], postCreateCopyAttempts: 8, postCreateCopyRetryMs: 500, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, keyPatterns: ['sk-or-v1-[A-Za-z0-9_-]{20,}'] },
  // OpenCode Go keys are issued from the signed-in OpenCode workspace after a
  // Go subscription is active. The auth route resolves the current workspace,
  // so no workspace identifier is hard-coded here.
  { id: 'opencode-go', label: 'OpenCode Go', keyHint: 'OPENCODE_API_KEY', groupHint: 'OpenCode Go', mode: 'browser', url: 'https://opencode.ai/auth', deletePreNavigationTexts: ['API 密钥'], deletePreNavigationUseHref: true, deleteReadyAttempts: 20, deleteTexts: ['删除'], deleteNoConfirm: true, deleteNoConfirmDomRetry: true, deleteNoConfirmReload: true, deleteNoConfirmReloadWaitMs: 900, preNavigationTexts: ['API 密钥', 'API Keys'], createTexts: ['创建 API 密钥', 'Create API Key', 'Create API key'], nameSelectors: ['[role="dialog"] input[placeholder*="名称"]', '[role="dialog"] input[placeholder*="name" i]', '[role="dialog"] input[name*="name" i]', 'input[placeholder*="名称"]', 'input[placeholder*="name" i]'], confirmTexts: ['创建 API 密钥', 'Create API Key', 'Create API key', '创建', 'Create'], allowConfirmCreateText: true, postCreateKeySelectors: ['[role="dialog"] input[readonly]', '[role="dialog"] code', '[role="dialog"] [data-clipboard-text]', '[role="dialog"] input[type="text"]', 'input[value^="sk-"]', 'code'], postCreateCopyTexts: ['复制密钥', '复制', 'Copy API key', 'Copy key', 'Copy'], postCreateCopyAttempts: 10, postCreateCopyRetryMs: 500, postCreateCopyNeedsForeground: true, allowExtensionClipboardRead: true, postCreateDomReadAttempts: 10, postCreateReadAttempts: 6, captureBeforeConfirm: true, keyPatterns: ['sk-[A-Za-z0-9_-]{20,}'] },
];

// Provider-side credential limits. These are deliberately metadata and
// warnings, not a local Vault count: users can create/delete keys outside
// MODELSWAP and there is no cross-platform synchronization API. The actual hard
// stop happens when the provider returns a limit error; reuse-only plans are
// blocked from submitting a duplicate create action above.
const AUTO_CREATE_KEY_LIMITS = {
  cloudflare: [{ max: 50, scope: 'user', kind: 'hard' }],
  tencent: [{ max: 50, scope: 'account', kind: 'default' }],
  'tencent-token-plan': [{ max: 1, scope: 'personal', kind: 'hard' }],
  minimax: [{ max: 10, scope: 'account', kind: 'observed' }],
  deepseek: [{ max: 100, scope: 'account', kind: 'hard' }],
  moonshot: [{ max: 50, scope: 'organization', kind: 'default' }],
  'kimi-coding-plan': [{ max: 5, scope: 'coding-plan', kind: 'hard' }],
  qwen: [
    { max: 50, scope: 'region', kind: 'hard' },
    { max: 20, scope: 'us-region', kind: 'hard' },
  ],
  'qwen-coding': [{ max: 1, scope: 'coding-plan', kind: 'hard' }],
  'qwen-token-plan': [{ max: 1, scope: 'seat', kind: 'hard' }],
  qianfan: [{ max: 200, scope: 'account-or-subuser', kind: 'hard' }],
  stepfun: [{ max: 10, scope: 'account', kind: 'hard' }],
};

for (const platform of AUTO_CREATE_PLATFORMS) {
  const keyLimits = AUTO_CREATE_KEY_LIMITS[platform.id];
  if (keyLimits) platform.keyLimits = keyLimits;
}

const AUTO_CREATE_PLATFORM_MAP = new Map(AUTO_CREATE_PLATFORMS.map(platform => [platform.id, platform]));

const SPECIAL_PLATFORM_URLS = {
  zhipu: ZHIPU_URL,
  volcengine: VOLC_URL,
  minimax: MINIMAX_URL,
};

function getBrowserPlatformUrl(platform) {
  return platform.url || SPECIAL_PLATFORM_URLS[platform.id];
}

// OpenRouter has been verified end-to-end. Cloudflare creates tokens directly
// from a user-supplied parent token, so neither belongs in the browser-login
// verification batch.
const BROWSER_LOGIN_VERIFICATION_PLATFORMS = AUTO_CREATE_PLATFORMS
  .filter(platform => platform.mode === 'browser' && platform.id !== 'openrouter')
  .map(platform => ({ id: platform.id, label: platform.label, url: getBrowserPlatformUrl(platform) }))
  .filter(platform => platform.url);

// Browser work is injected into the application lifecycle so expiry and
// verification transitions are testable independently from Express.
  return { AUTO_CREATE_PLATFORMS, AUTO_CREATE_PLATFORM_MAP, SPECIAL_PLATFORM_URLS, BROWSER_LOGIN_VERIFICATION_PLATFORMS, getBrowserPlatformUrl };
}
module.exports = { createAutoCreatePlatforms };
