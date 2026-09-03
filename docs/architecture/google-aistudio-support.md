# Google AI Studio（Gemini API）支持方案

> 状态：方案待评审 ｜ 2026-09-03 ｜ 目标：支持 Google AI Studio 的 Gemini API（含 Gemini 3.8 Flash），Key 获取不走 RPA。

## 一、结论

**可行，且不需要 RPA。** Google 官方 `gcloud` CLI 提供 GA 级命令直接创建/删除 API Key：

```bash
# 创建并直接拿到明文 Key（AIza 开头）
gcloud services api-keys create \
  --display-name="modelswap" \
  --api-target=service=generativelanguage.googleapis.com \
  --project=<PROJECT_ID> \
  --show-key-string

# 删除
gcloud services api-keys delete <KEY_ID> --project=<PROJECT_ID>
```

之前"创建密钥必须先关联付费项目"的顾虑，实际情况是：

1. AI Studio 网页上点"创建 API Key"时，Google 会**自动代建一个 GCP 项目**（形如 `gemini-xxx` / `aicore-xxx`），用户感觉被要求"选项目"，于是看起来像要绑定付费账号；
2. **Gemini API 免费层不需要开通 Billing**。Key 只是挂在某个 GCP 项目下，项目可以没有关联结算账号，免费层（按 RPM/RPD 限流）照常可用；
3. `gcloud` 创建的 Key 与 AI Studio 网页创建的 Key 本质相同（都是 GCP API Key，`AIza` 前缀），走 `generativelanguage.googleapis.com`。

唯一无法绕过的浏览器步骤是**首次 OAuth 登录**（`gcloud auth login`，一次性，浏览器授权后长期有效）——这不是 RPA，是官方认证流程，和 Cloudflare 模式需要用户提供 parent token 同级别的一次性人工动作。

参考：[gcloud services api-keys create 官方文档](https://docs.cloud.google.com/sdk/gcloud/reference/services/api-keys/create)、[Manage API keys](https://docs.cloud.google.com/docs/authentication/api-keys)、[Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)。

## 二、前置验证（合并前必须做，约 15 分钟）

**这一步用户必须亲自做**（需要 Google 账号授权）：

```bash
# 1. 安装（macOS；Windows/Linux 用官方 installer）
brew install --cask google-cloud-sdk

# 2. 一次性登录（弹浏览器 OAuth）
gcloud auth login

# 3. 复用已有项目，或新建一个（新建项目无需付费账号）
gcloud projects list
gcloud projects create modelswap-gemini-$(whoami) 2>/dev/null || true

# 4. 启用 Gemini API + 创建 Key
gcloud services enable generativelanguage.googleapis.com --project=<PROJECT_ID>
gcloud services api-keys create \
  --display-name="modelswap-poc" \
  --api-target=service=generativelanguage.googleapis.com \
  --project=<PROJECT_ID> \
  --show-key-string

# 5. 用拿到的 AIza Key 验证免费层可用（关键风险点）
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=<KEY>" | head
```

**验收标准**：第 5 步不返回 `SERVICE_DISABLED` / `PERMISSION_DENIED` / 要求 billing 的错误，即确认 gcloud 创建的 Key 可走免费层。若此步失败（Google 政策收紧只认 AI Studio 网页创建的 Key），则本方案降级为"手动录入 Key + 一键打开 aistudio.google.com/apikeys 引导页"，仍值得加 Provider 支持，只是自动创建不做。

## 三、实现方案

### 3.1 Key 自动创建：新增 `mode: 'cli'` 平台

现有两种模式：`browser`（RPA）和 `api`（Cloudflare 纯 HTTP）。Google 属于第三类——**本地 CLI 编排**，建议新增 `mode: 'cli'`：

**`src/application/auto-create-platforms.js` 新增：**

```js
{
  id: 'google-aistudio',
  label: 'Google AI Studio',
  keyHint: 'GEMINI_API_KEY',
  groupHint: 'Google',
  mode: 'cli',
  // keyPatterns: ['AIza[0-9A-Za-z_-]{35}']
}
```

**新建 `src/application/auto-create-gcloud-service.js`**（对标 `auto-create-cloudflare-service.js`，子进程执行注入以便测试）：

```
ensureGcloud()        // findCommand('gcloud')，不存在则返回安装指引文案（brew/官网 installer）
ensureAuth()          // gcloud auth list --filter=status:ACTIVE --format=value(account)，为空则提示运行 gcloud auth login（用户必做步骤，CLI 会自己弹浏览器）
resolveProject()      // gcloud projects list --format=value(projectId)，优先复用名字带 modelswap/gemini 的项目；没有则 gcloud projects create
enableApi()           // gcloud services enable generativelanguage.googleapis.com（幂等）
createKey(name)       // gcloud services api-keys create --api-target=... --show-key-string --format=json，解析 keyString + uid（uid 存下来用于删除）
deleteKey(uid)        // gcloud services api-keys delete <uid>
```

注意：
- `--show-key-string` 的输出走 `--format=json` 拿 `keyString` 字段，避免解析人类可读文本；
- gcloud 首次运行可能有 telemetry 交互提示，子进程加 `CLOUDSDK_CORE_DISABLE_PROMPTS=1`；
- gcloud 输出进度信息到 stderr，解析只看 stdout。

### 3.2 Provider 接入

- `src/providers/presets.ts` 新增 Google（AI Studio）preset：`id: 'google'`，OpenAI 兼容端点 `https://generativelanguage.googleapis.com/v1beta/openai/`，认证头 `Authorization: Bearer <AIza key>`（也支持 `x-goog-api-key`）；
- 同步更新 `src/web/api/providers.js` 预设列表（AGENTS.md 约定）；
- 模型清单：`gemini-3.8-flash`、`gemini-3-pro` 等，models.dev 已收录，走现有 `enrichModels` 即可。

### 3.3 不做的事

- **不做 AI Studio 网页 RPA**：aistudio.google.com 是重度 SPA + Google 登录风控（设备验证、二次确认），RPA 成本高且易触发账号风控，CLI 方案完全覆盖；
- **不代管 billing**：付费层引导用户自行在 GCP console 关联结算账号，ModelSwap 不碰。

## 四、风险与对策

| 风险 | 概率 | 对策 |
|------|------|------|
| gcloud 创建的 Key 不能走免费层（Google 只认 AI Studio Key） | 低 | 前置验证第 5 步拦截；失败则降级为手动录入模式 |
| 用户机器没有 gcloud / 不愿装 | 中 | 检测不到 gcloud 时给出手动录入入口 + 打开 aistudio.google.com/apikeys |
| 国内网络访问 Google | 高（已知） | 文档标注需代理，与 Anthropic/OpenAI 现状一致，不额外处理 |
| 项目数配额（每账号约 30 个项目） | 低 | 优先复用已有项目，Key 名统一 `modelswap-` 前缀便于识别 |
| OAuth token 过期 | 低 | `gcloud auth list` 检测到无有效账号时重新引导 login |

## 五、实施顺序

1. **前置验证**（第二节，用户必做，15 分钟）——通过后再动代码；
2. `auto-create-gcloud-service.js` + 平台目录项 + 测试（mock 子进程，覆盖未安装/未登录/无项目三条失败路径）；
3. `presets.ts` + `providers.js` 接入 Provider + 模型发现联调；
4. 前端 Vault 平台列表加 Google AI Studio 入口（`mode: 'cli'` 的 UI 状态：检测 gcloud → 提示登录 → 一键创建）；
5. 三平台 CI 注意：gcloud 相关测试全部 mock 子进程输出，CI runner 不装 gcloud。
