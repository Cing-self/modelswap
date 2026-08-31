# Provider 真实验收工具（第一阶段）

`scripts/provider-live-acceptance.mjs`（`npm run test:providers:live`）是**发布前人工触发**的真实验收入口：用真实第三方控制台验证自动创建链路的外部前提（登录墙识别、已登录控制台可达、安全入口仍在），弥补单元测试无法发现「控制台改版 / 登录态失效 / 扩展链路断」的盲区。它**不是**每次提交都跑的 CI，也不伪造远程发布门禁（GitHub 托管 CI 无法安全保存登录态；如需硬拦发布应另建专用 self-hosted runner）。

平台目录单一真源：自动读取产品注册表 `AUTO_CREATE_PLATFORMS`（经 `src/web/api/auto-create.js`），当前 32 平台 = 1 个 api（cloudflare）+ 31 个 browser。新增平台无需改本工具。

## 三种模式

| 模式 | Chrome 会话 | 验证内容 | 绝不做 |
|------|-------------|----------|--------|
| `guest` | 全新临时用户目录（跑完即删） | 访问真实控制台 URL，断言**未登录会话被登录墙识别**（可交接登录） | 创建/确认/复制/删除 |
| `auth-verify` | 专用持久目录 `~/.okit/provider-live-acceptance/profiles/auth`（用户自行登录） | 到达已登录控制台、找到预期安全入口文案/订阅掩码 Key | 点击创建/确认/生成/删除、代输账号密码验证码 |
| `create-cleanup` | 专用 Chrome + OKIT 扩展（`provider-live-chrome.mjs --with-extension`） | 委托 `auto-create-key-check.mjs`：唯一测试名创建→读取→精确删除→确认消失 | 缺 `--platform`+`--allow-create-and-cleanup` 双开关时直接拒绝；一次多平台拒绝；清理失败立即停止 |

### 常用命令

```bash
npm run test:providers:live -- --list                                   # 列出平台
npm run test:providers:live -- --mode guest --dry-run --platform zhipu  # 只出计划/报告（零外部访问）
npm run test:providers:live -- --mode guest                             # 全部 31 个 browser 平台 guest 巡检
npm run test:providers:live -- --mode auth-verify --platform zhipu     # 单平台已登录入口验证

node scripts/provider-live-chrome.mjs                                   # 启动专用 Chrome（人工登录各平台）
node scripts/provider-live-chrome.mjs --status                          # 探测专用 Chrome 是否在跑
node scripts/provider-live-chrome.mjs --platform zhipu --platform volcengine  # 打开指定控制台标签便于登录

npm run test:providers:live -- --mode create-cleanup --platform zhipu --dry-run          # 创建+清理计划
npm run test:providers:live -- --mode create-cleanup --platform zhipu \
  --allow-create-and-cleanup --with-extension            # 真实创建（默认禁止；本阶段开发/验收不运行）
```

`--dry-run` 只验证计划、参数校验和报告格式，**不构成任何真实验证**，也不启动浏览器、不访问网络。

## 安全模型

1. **专用 profile 隔离**。Chrome 永远以 `--user-data-dir=<验收根目录内路径>` 启动；`assertSafeProfileDir` 双重校验（必须在 `~/.okit/provider-live-acceptance/` 内 + 不得与三平台日常浏览器目录重叠/包含）。`--profile` 只接受简单标识符（不是路径），结构上无法指向日常 Chrome；`--user-data-dir`、`--copy-profile`、`--import`、`--load-cookies` 等参数直接拒绝。工具绝不读取/复制/备份/导出日常 Chrome 的 Cookie、LocalStorage、IndexedDB、钥匙串或配置。
2. **guest/auth-verify 无创建通路**。两模式不加载 OKIT 扩展（避免与日常 OKIT 服务争抢单一扩展连接——扩展按 3780→3785 顺序探测锁定），改用 CDP 直连专用 Chrome 的调试端口（默认 9333），驱动只实现只读原子（open-tab/probe/screenshot/close-tab/dispose）并经 `assertDriverActionAllowed` 白名单闸门——代码结构上不存在 click/type/submit。
3. **只读探针自检**。注入页面的探针脚本由 `buildProbeScript` 生成并自检禁止令牌（`document.cookie`、storage、`.value`、`dispatchEvent`、`.click(` 等），读取的只有：URL（origin+path，**查询串在源头即不读**）、标题、可见按钮/链接文本摘要（≤30 项 ×48 字符）、登录/验证信号布尔值、正文长度。密码输入框只计数，不读值。
4. **产物与脱敏**。报告/截图只写 `~/.okit/provider-live-acceptance/`（不进 Git）。所有页面来源字符串经 `redactSecrets`（sk-/xai-/tp-/bce-v3/AKLT/JWT/Bearer/32+hex → `[REDACTED]`），URL 经 `sanitizeUrl`（去 query/fragment/credentials，非 http(s) scheme 整体 `[REDACTED]`）。截图策略默认 guest=all、auth-verify=login-only（已登录健康控制台不截，避免账号 UI 入图）。
5. **create-cleanup 双重确认**。必须同时 `--platform <唯一平台>` + `--allow-create-and-cleanup`（并要求 `--with-extension` 专用 Chrome）；任何清理失败 → `cleanup_failed`、退出码 1、不再创建下一把 Key。
6. **旧脚本收紧**。`auto-create-key-check.mjs` 不再接受“未传平台=批量创建全部平台”：真实运行需要显式平台列表 + `--allow-create-and-cleanup`；`--list` 与 `--cleanup <report>`（孤儿清理兜底）不受影响。

## 状态与退出码

- `passed_login_gate`（guest 登录墙识别）/ `passed_entry_found`（auth-verify 入口命中）/ `passed_console_reached`（弱通过：无入口配置的平台仅验证到达已登录控制台）/ `passed`、`passed_existing_reuse`（create-cleanup 委托）→ 通过。
- `waiting_for_user`（登录/人机验证等外部前置）与 `blocked_prerequisite`（前置缺失）→ **如实报告、不算通过**，退出码 2。
- `failed` / `safe_entry_missing`（疑似改版）/ `cleanup_failed` / `rejected` → 退出码 1。

**没有已登录专用 profile 的真实 auth-verify 巡检，不得声称平台已验收通过。**

## 报告 schema（`~/.okit/provider-live-acceptance/reports/<stamp>-live-<mode>.json`）

```jsonc
{
  "schemaVersion": 1, "tool": "provider-live-acceptance",
  "mode": "guest|auth-verify|create-cleanup", "dryRun": false,
  "startedAt": "…", "endedAt": "…",
  "checkout": { "revision": "<commit SHA>", "dirty": false },
  "safety": { "readOnlyAtomsOnly": true, "dailyProfileProtection": "enforced", "artifactRootOutsideGit": true, "extensionLoaded": false, "screenshotPolicy": "all", "keepOpen": false, "artifactRoot": "…" },
  "requestedPlatforms": ["zhipu"], "platforms": ["zhipu"],
  "results": [{
    "platform": "zhipu", "label": "…", "mode": "browser",
    "stage": "navigate|probe|classify|plan|delegate|…",
    "status": "…", "reason": "…",
    "loginUrl": "https://…（无查询串）",
    "page": { "title": "…", "buttonsSummary": ["…"], "linksSummary": ["…"], "bodyChars": 1234 },
    "screenshot": "…/screenshots/<stamp>/guest-zhipu.png | null",
    "steps": [ /* 仅 create-cleanup 计划 */ ]
  }],
  "summary": { "passed_login_gate": 1 }, "exitCode": 0
}
```

## create-cleanup 的前置条件（真实运行时）

1. OKIT 服务在跑且浏览器扩展已连接（`GET /api/vault/cdp-status` → `available=true`）。
2. 用 `node scripts/provider-live-chrome.mjs --with-extension` 启动**加载 OKIT 扩展的专用 Chrome** 并在其内完成目标平台登录。
3. 日常 Chrome 如也启用了 OKIT 扩展，先停用其一（单扩展连接模型，会互相争抢/驱逐）。
4. Cloudflare 走 API 模式，需 `OKIT_AUTOCHECK_CLOUDFLARE_PARENT_TOKEN` 专用父 Token（不得复用生产 Vault Token）。

## 离线回归

`tests/provider-live-acceptance.test.ts`（54 用例）覆盖：三模式参数与安全拒绝；日常 profile / Cookie 迁移 / 无平台批量创建拒绝；guest 与 auth-verify 动作白名单（无创建/确认/删除原子）；create-cleanup 缺双确认、服务未就绪、委托清理失败即停；报告含 commit SHA 与诊断且敏感字段脱敏；假浏览器“页面改版、入口消失”反向用例非零退出并产出可定位报告。`tests/fixtures/live-acceptance-reverse-harness.mjs` 可手动复演该反向用例（真实编排管线 + 假驱动，exit 1）。
