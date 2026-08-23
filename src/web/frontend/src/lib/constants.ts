export const CATEGORY_COLORS: Record<string, { bg: string; shadow: string }> = {
  language: { bg: '#fef9ef', shadow: '#b45309' },
  runtime: { bg: '#f0fdf4', shadow: '#15803d' },
  cloud: { bg: '#eff6ff', shadow: '#1d4ed8' },
  database: { bg: '#fdf4ff', shadow: '#7e22ce' },
  devops: { bg: '#fff7ed', shadow: '#c2410c' },
  security: { bg: '#f0fdfa', shadow: '#0f766e' },
  ai: { bg: '#fdf2f8', shadow: '#be185d' },
  productivity: { bg: '#f0f9ff', shadow: '#0284c7' },
  networking: { bg: '#fefce8', shadow: '#a16207' },
  testing: { bg: '#f5f3ff', shadow: '#6d28d9' },
  system: { bg: '#f9fafb', shadow: '#4b5563' },
  media: { bg: '#fff1f2', shadow: '#e11d48' },
};

export const VAULT_COLORS = [
  { bg: '#fef9ef', shadow: '#b45309' },
  { bg: '#f0fdf4', shadow: '#15803d' },
  { bg: '#eff6ff', shadow: '#1d4ed8' },
  { bg: '#fdf4ff', shadow: '#7e22ce' },
  { bg: '#fff7ed', shadow: '#c2410c' },
  { bg: '#f0fdfa', shadow: '#0f766e' },
];


export const PLATFORM_FIELDS: Record<string, string[]> = {
  cloudflare: ['apiToken', 'storeId'],
  'cloudflare-d1': ['apiToken'],
  'cloudflare-r2': ['accountId', 'r2AccessKeyId', 'r2SecretAccessKey'],
  volcengine: ['accessKey', 'secretKey'],
  supabase: ['projectId', 'apiKey'],
  'cloudflare-kv': ['apiToken'],
  webdav: ['url', 'username', 'password'],
  lan: ['baseUrl', 'token'],
  icloud: [],
};

export const PLATFORM_IDS: Record<string, string> = {
  cloudflare: 'Cloudflare Secrets Store',
  'cloudflare-d1': 'Cloudflare D1',
  'cloudflare-r2': 'Cloudflare R2',
  volcengine: '火山引擎 KMS',
  supabase: 'Supabase',
  'cloudflare-kv': 'Cloudflare KV',
  webdav: 'WebDAV',
  lan: '局域网设备',
  icloud: 'iCloud',
};

export const PLATFORM_DOCS: Record<string, { fields: Record<string, { label: string; hint: string }>; steps: { text: string; links?: Record<string, string> }[]; code?: { title: string; sql: string } }> = {
  cloudflare: {
    fields: {
      apiToken: { label: 'API Token', hint: '需要 Secrets Store 读写权限' },
      storeId: { label: 'Store ID', hint: '在 Secrets Store 页面创建 Store 后获取' },
    },
    steps: [
      { text: '登录 Cloudflare Dashboard → Storage & databases → Secrets Store', links: { 'Cloudflare Dashboard': 'https://dash.cloudflare.com' } },
      { text: '点击 "Create store" 创建一个 Store' },
      { text: '复制 Store ID 到配置中' },
      { text: '前往 Dashboard → Manage account → Account API Tokens，创建 Token 并勾选 Secrets Store 的编辑权限' },
    ],
  },
  'cloudflare-d1': {
    fields: {
      apiToken: { label: 'API Token', hint: '需要 D1 编辑权限，数据库和表会自动创建' },
    },
    steps: [
      { text: '前往 Dashboard → Manage account → Account API Tokens，创建 Token 并勾选 D1 的编辑权限', links: { 'Dashboard': 'https://dash.cloudflare.com' } },
      { text: '将 Token 填入配置中，测试连接后会自动创建 okit-sync 数据库' },
    ],
  },
  'cloudflare-r2': {
    fields: {
      accountId: { label: 'Account ID', hint: '在 R2 概述页面右侧 "S3 API" 处可看到' },
      r2AccessKeyId: { label: 'R2 Access Key ID', hint: '必须从 R2 专用页面创建 S3 Token 才会获得' },
      r2SecretAccessKey: { label: 'R2 Secret Access Key', hint: '创建 Token 后确认页面一次性显示，关闭后无法再查看' },
    },
    steps: [
      { text: '⚠️ 重要：打开 R2 API Tokens 页面 创建 Token，不要从通用的 Account API Tokens 页面创建！通用的 Token 不会产生 S3 凭据', links: { '打开 R2 API Tokens 页面': 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens' } },
      { text: '在 R2 概述页面右侧可看到 Account ID，复制后填入下方字段', links: { 'R2 概述页面': 'https://dash.cloudflare.com/?to=/:account/r2' } },
      { text: '点击 "Create API token" 按钮（注意：必须是 R2 页面里的这个按钮）' },
      { text: '权限选择 "Object Read & Write"，指定 Bucket 或选 "Apply to all"，然后点击 Create' },
      { text: '✅ 创建成功后的确认页面会同时显示 Access Key ID 和 Secret Access Key，立刻复制保存（Secret 关闭页面后无法再查看！）' },
    ],
  },
  volcengine: {
    fields: {
      accessKey: { label: 'AccessKey', hint: '在访问控制中创建' },
      secretKey: { label: 'SecretKey', hint: '创建时一次性显示' },
    },
    steps: [
      { text: '先开通密钥管理服务：搜索 "密钥管理系统" 或访问产品页，点击 "立即开通"', links: { '密钥管理系统': 'https://console.volcengine.com/kms' } },
      { text: '前往 火山引擎控制台 → 右上角头像 → 密钥管理，创建 IAM 子用户的 AccessKey', links: { '密钥管理': 'https://console.volcengine.com/iam/keymanage/' } },
      { text: '在访问控制 → 策略中搜索并授权 KMSFullAccess 策略（只读同步选 KMSReadOnly）' },
      { text: '创建密钥后复制 AccessKey 和 SecretKey' },
    ],
  },
  supabase: {
    fields: {
      projectId: { label: '项目 ID', hint: '浏览器地址栏 /project/ 后面的那段字符' },
      apiKey: { label: 'Secret Key', hint: 'Settings → API 中的 secret_key' },
    },
    steps: [
      { text: '前往 Supabase 控制台创建一个免费项目', links: { 'Supabase': 'https://supabase.com/dashboard' } },
      { text: '从浏览器地址栏复制项目 ID：dashboard/project/xxxxx 中的 xxxxx' },
      { text: '进入 Settings → API，复制 secret_key 填入 Secret Key 字段' },
      { text: '进入 SQL Editor，执行下方的建表 SQL（点击复制按钮）' },
    ],
    code: {
      title: '建表 SQL（在 SQL Editor 中执行）',
      sql: `CREATE TABLE okit_sync (\n  id BIGSERIAL PRIMARY KEY,\n  key TEXT NOT NULL UNIQUE,\n  value JSONB NOT NULL,\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n\nALTER TABLE okit_sync ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "Allow service_role" ON okit_sync FOR ALL USING (true) WITH CHECK (true);`,
    },
  },
  'cloudflare-kv': {
    fields: {
      apiToken: { label: 'API Token', hint: '需要 Workers KV Storage 编辑权限' },
    },
    steps: [
      { text: '前往 API Tokens 页面 → Manage account → Account API Tokens，点击 "Create Token"', links: { 'API Tokens 页面': 'https://dash.cloudflare.com/profile/api-tokens' } },
      { text: '创建 Token，权限选择 Account → Workers KV Storage → Edit' },
      { text: '将 Token 填入配置中，测试连接后会自动创建 okit-sync 命名空间' },
    ],
  },
  webdav: {
    fields: {
      url: { label: '服务器地址', hint: '如 https://dav.jianguoyun.com/dav/' },
      username: { label: '用户名', hint: 'WebDAV 账号' },
      password: { label: '密码', hint: '应用专用密码（非登录密码）' },
    },
    steps: [
      { text: 'WebDAV 支持坚果云、Nextcloud、Synology、Box 等服务', links: { '坚果云': 'https://www.jianguoyun.com/' } },
      { text: '坚果云：在「账户信息 → 安全选项 → 第三方应用」中添加一个应用，获取应用密码' },
      { text: '服务器地址填入完整的 WebDAV URL（以 http:// 或 https:// 开头）' },
      { text: '用户名填账号，密码填应用专用密码（不是登录密码）' },
      { text: '点击测试连接，会自动创建 okit-sync 目录' },
    ],
  },
  lan: {
    fields: {
      baseUrl: { label: '对端地址', hint: '如 http://192.168.1.5:3790（对端开启局域网同步后获得）' },
      token: { label: '连接令牌', hint: '对端配对码中 / 后面的一长串字符' },
    },
    steps: [
      { text: '推荐使用上方「局域网同步」区块的粘贴配对码方式，会自动填写并校验' },
      { text: '在另一台电脑的 OKIT 设置中开启「局域网同步」，复制它显示的配对码' },
      { text: '配对码格式为 okit-lan://IP:端口/令牌：手动填写时地址填 http://IP:端口，令牌填斜杠后的字符串' },
      { text: '两台设备必须使用相同的同步密码' },
    ],
  },
  icloud: {
    fields: {},
    steps: [
      { text: '前提：Mac 已登录 Apple 账户。打开「系统设置」，点顶部的姓名（Apple 账户），进入「iCloud」' },
      { text: '在「已存至 iCloud」区域找到「云盘」：如果显示"开启"可跳到第 4 步；如果显示"关闭"，点击云盘卡片，打开「同步此 Mac」开关' },
      { text: '云盘内的「桌面与文稿文件夹」等选项无需勾选——OKIT 只使用 iCloud Drive 根目录的独立文件夹，不会碰你的桌面和文稿' },
      { text: '回到本页设置「同步密码」（自定义，所有机器填相同的密码），在下方平台列表打开 iCloud 的启用开关即可——所有启用的平台会同时同步，互为备份' },
      { text: '无需填任何账号密码，启用后同步数据会自动加密写入 iCloud Drive 的 okit-sync 文件夹（可在访达边栏「iCloud 云盘」中查看，内容为密文）' },
      { text: '建议开启「自动同步」：本地改动自动推送，远端数据定时自动合并，无需手动操作' },
      { text: '其他 Mac 登录同一 iCloud 账户、在 OKIT 中输入相同同步密码并启用 iCloud，即可互相同步；Linux / Windows 用户请改用 WebDAV' },
    ],
  },
};
