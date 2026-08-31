# Provider 真实验收工具（第一阶段）

`scripts/provider-live-acceptance.mjs`（`npm run test:providers:live`）是**发布前人工触发**的真实验收入口：用真实第三方控制台验证自动创建链路的外部前提（登录墙识别、已登录控制台可达、安全入口仍在），弥补单元测试无法发现「控制台改版 / 登录态失效 / 扩展链路断」的盲区。它**不是**每次提交都跑的 CI，也不伪造远程发布门禁（GitHub 托管 CI 无法安全保存登录态；如需硬拦发布应另建专用 self-hosted runner）。

平台目录单一真源：自动读取产品注册表 `AUTO_CREATE_PLATFORMS`（经 `src/web/api/auto-create.js`），当前 32 平台 = 1 个 api（cloudflare）+ 31 个 browser。新增平台无需改本工具。

## 三种模式

| 模式 | Chrome 会话 | 验证内容 | 绝不做 |
|------|-------------|----------|--------|
| `guest` | 全新临时用户目录（跑完即删） | 访问真实控制台 URL，断言**未登录会话被登录墙识别**（可交接登录） | 创建/确认/复制/删除 |
| `auth-verify` | 专用持久目录 `~/.okit/provider-live-acceptance/profiles/auth`（用户自行登录） | 到达已登录控制台、找到预期安全入口文案/订阅掩码 Key | 点击创建/确认/生成/删除、代输账号密码验证码 |
| `create-cleanup` | 专用 Chrome + 补丁扩展副本（`provider-live-chrome.mjs --with-extension` 生成一次性会话） | **已实现但硬禁用**：三重门槛与会话身份闸门齐备也拒绝真实执行（`disabled`，exit 1，零委托）；仅 dry-run 计划可用 | 缺 `--platform`+`--allow-create-and-cleanup`+`--session` 三要素直接拒绝；扩展身份无法证明（`unverified_extension_identity`）拒绝且零委托；一次多平台拒绝；单扩展槽位竞态未消除 → 真实创建禁用（解禁条件见下） |

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
node scripts/provider-live-chrome.mjs --with-extension          # 生成一次性验收会话 + 加载补丁扩展副本的专用 Chrome
npm run test:providers:live -- --mode create-cleanup --platform zhipu \
  --allow-create-and-cleanup --session <启动器输出的会话ID>   # 仍会被硬禁用拒绝（见下）；仅 dry-run 可用
```

`--dry-run` 只验证计划、参数校验和报告格式，**不构成任何真实验证**，也不启动浏览器、不访问网络。

## 安全模型

1. **专用 profile 隔离**。Chrome 永远以 `--user-data-dir=<验收根目录内路径>` 启动；`assertSafeProfileDir` 双重校验（必须在 `~/.okit/provider-live-acceptance/` 内 + 不得与三平台日常浏览器目录重叠/包含）。`--profile` 只接受简单标识符（不是路径），结构上无法指向日常 Chrome；`--user-data-dir`、`--copy-profile`、`--import`、`--load-cookies` 等参数直接拒绝。工具绝不读取/复制/备份/导出日常 Chrome 的 Cookie、LocalStorage、IndexedDB、钥匙串或配置。
2. **guest/auth-verify 无创建通路**。两模式不加载 OKIT 扩展（避免与日常 OKIT 服务争抢单一扩展连接——扩展按 3780→3785 顺序探测锁定），改用 CDP 直连专用 Chrome 的调试端口（默认 9333），驱动只实现只读原子（open-tab/probe/screenshot/close-tab/dispose）并经 `assertDriverActionAllowed` 白名单闸门——代码结构上不存在 click/type/submit。
3. **只读探针自检**。注入页面的探针脚本由 `buildProbeScript` 生成并自检禁止令牌（`document.cookie`、storage、`.value`、`dispatchEvent`、`.click(` 等），读取的只有：URL（origin+path，**查询串在源头即不读**）、标题、可见按钮/链接文本摘要（≤30 项 ×48 字符）、登录/验证信号布尔值、正文长度。密码输入框只计数，不读值。
4. **产物与脱敏**。报告/截图只写 `~/.okit/provider-live-acceptance/`（不进 Git）。所有页面来源字符串经 `redactSecrets`（sk-/xai-/tp-/bce-v3/AKLT/JWT/Bearer/32+hex → `[REDACTED]`），URL 经 `sanitizeUrl`（去 query/fragment/credentials，非 http(s) scheme 整体 `[REDACTED]`）。截图策略默认 guest=all、auth-verify=login-only（已登录健康控制台不截，避免账号 UI 入图）。
5. **create-cleanup 会话绑定（P0）**。`/api/vault/cdp-status` 的 available=true 只证明“某个扩展在线”，不能证明它在专用 Chrome 里——产品扩展的 WebSocket hello 只带 version/protocol，日常 Chrome 的扩展同样会连上服务端。因此真实运行要求**可验证的会话证明**，缺一即拒绝（`unverified_extension_identity`，exit 1，绝不降级为“提示先停用日常扩展”）：
   - `provider-live-chrome --with-extension` 生成一次性会话 ID，写入启动记录（专用 profile、调试端口、pid、扩展副本目录）到 `~/.okit/provider-live-acceptance/sessions/`，并物化一份**打过补丁的扩展副本**（只复制运行时文件，产品扩展本身零修改）：在 hello 附加 `acceptanceSession`、auth-ok 与 ~20s keepalive 心跳时向本地 witness（127.0.0.1:9341）上报 `{sessionId, wsUrl, wsState}`。锚点替换校验“恰好一次”，扩展产物改版导致锚点漂移时**拒绝生成**（fail closed），并有快照夹具 + 真实产物一致性测试防漂移。
   - create-cleanup 前置闸门：`--session` 必填 → 启动记录存在且通过隔离/时效/副本完整性校验 → 专用 Chrome CDP 存活 → witness 在新鲜窗口内收到**本会话**、wsState=OPEN、目标服务端口的扩展心跳。普通/未知扩展（未打补丁、不上报）永远给不出证明。
   - **未消除的 P0 → 真实执行硬禁用（裁定 2026-08-31）**：服务端是单扩展槽位（后认证的扩展会替换 `extWs`），witness 只能证明专用扩展“刚刚在线”；日常 Chrome 扩展随后重新认证即可完成替换，而自动创建命令不按 session 绑定——在不改产品扩展/服务端协议的前提下，同机无法证明真实创建永远不落到日常 Chrome。因此 create-cleanup 的真实执行**即便三重门槛+身份证明全部通过也直接拒绝**（`disabled`，exit 1，零委托、零网络），仅 dry-run 可用；不作为可执行真实验收能力宣传。解禁二选一：① 在隔离 VM/独立机器运行专用 OKIT 服务与专用 Chrome（不改产品协议的安全方案）；② 改产品 WS 协议——服务端记录 `acceptanceSession`、每次自动创建命令按 session 发送、连接被替换后立即拒绝（同机运行的正确方案）。
6. **信号清理（P1）**。guest/auth-verify 运行中收到 SIGINT/SIGTERM 时，尽力（3 秒预算）关闭本次启动的专用 Chrome 并删除 guest 临时 profile，然后以 130/143 退出。**SIGKILL 无法捕获**——强杀会遗留 `~/.okit/provider-live-acceptance/tmp/guest-<stamp>/` 目录与 Chrome 进程；下次 guest 用全新 stamp 目录互不影响，残留可 `rm -rf ~/.okit/provider-live-acceptance/tmp` 手工清理。
7. **旧脚本收紧**。`auto-create-key-check.mjs` 不再接受“未传平台=批量创建全部平台”：真实运行需要显式平台列表 + `--allow-create-and-cleanup`；`--list` 与 `--cleanup <report>`（孤儿清理兜底）不受影响。

## 状态与退出码

- `passed_login_gate`（guest 登录墙识别）/ `passed_entry_found`（auth-verify 入口命中）/ `passed_console_reached`（控制台级：无入口配置的平台仅验证到达已登录控制台，或**管理页级**——页面标题/路由+导航确认处于 API Key 管理/列表页但创建按钮未出现在可见摘要中）/ `passed`、`passed_existing_reuse`（create-cleanup 委托）→ 通过。
- `waiting_for_user`（登录/人机验证/登录跳转过渡态如 Signing in/首次组织·工作区选择等需人工动作的外部前置）与 `blocked_prerequisite`（前置缺失，如订阅 Key 需先人工生成）→ **如实报告、不算通过**，退出码 2。
- `page_not_ready`（页面在有界等待内未稳定：加载骨架、空控制台壳、探针签名持续变化）→ **不作入口缺失/改版结论**，退出码 2，建议稍后重跑。
- `failed` / `safe_entry_missing`（**仅当**页面稳定、控制台内容可确认、且配置的入口文案全部缺失时才可判定——疑似改版）/ `cleanup_failed` / `rejected` / `disabled`（真实 create-cleanup 的硬禁用）→ 退出码 1。

auth-verify 判定顺序（前几类绝不误报改版）：人机验证 → 未登录 → 登录跳转过渡（如 "Signing in…" 或 ≤40 字符正文且零可操作元素）→ 首次组织/工作区选择（如 Individual / Organization，工具不代选）→ 入口文案命中 → 掩码订阅 Key → reuse-only 前置缺失 → **管理页级确认**（标题含 “API Key 管理/列表”，或密钥路由+导航+已渲染内容）→ 未稳定/骨架（page_not_ready）→ 稳定控制台且配置入口缺失（才是 safe_entry_missing）。页面稳定性=有界窗口内连续两次探针签名一致（签名=正文字数+按钮数+链接数），不无限等待。

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

## create-cleanup 的解禁条件（当前真实执行被硬禁用）

**当前状态**：真实执行一律拒绝（`disabled`，exit 1，零委托、零网络）；以下描述的是解禁后才生效的运行链路。

1. OKIT 服务在跑且有扩展在线（`GET /api/vault/cdp-status` → `available=true`；必要条件，不是放行条件）。
2. `node scripts/provider-live-chrome.mjs --with-extension` 启动专用 Chrome：生成一次性会话 + 加载补丁扩展副本，在其内完成目标平台登录，记下输出的 `session <id>`。
3. 运行 create-cleanup 时带 `--session <id>`：闸门会校验启动记录、专用 Chrome CDP 存活，并在 witness 收到本会话扩展连接目标端口的新鲜心跳；任何一环无法证明即拒绝（`unverified_extension_identity`，exit 1，不调用创建委托）。
4. 会话记录有效期 24 小时；扩展产物改版导致补丁锚点漂移时启动器 fail closed（提示先 `npm run build-extension` 同步并更新 `tests/fixtures/extension-dist-sample/` 快照）。
5. Cloudflare 走 API 模式，需 `OKIT_AUTOCHECK_CLOUDFLARE_PARENT_TOKEN` 专用父 Token（不得复用生产 Vault Token）。

**解禁二选一**（落地方案评审通过后，移除 orchestrate 中 `createCleanupRealRunEnabled=false` 的硬禁用分支并更新本文档）：

- **隔离方案**：在隔离 VM / 独立机器中运行专用 OKIT 服务与专用 Chrome——物理上不存在日常 Chrome 扩展竞争同一 WS 槽位，不需要改产品协议。
- **协议方案**：改产品 WS 协议——服务端在 hello 时记录 `acceptanceSession`，每次自动创建命令按该 session 发送，连接被其他扩展替换后立即拒绝。这是同机运行的正确方案。

## 真实 guest 巡检结果（2026-08-31，三轮全量 31 平台）

真实运行修复了三个只有真实验收才能暴露的缺陷：新版 Chrome `/json/new` 忽略 `?url=`（改为 `Page.navigate` 显式导航）、SPA 正文晚于 `readyState=complete`（改为等正文出现再采样）、探针模板转义回归（新增“可编译”离线测试）。三轮矩阵：

- **稳定通过 14**：tencent、tencent-token-plan、zhipu、minimax×4、siliconflow、xiaomi、xiaomi-coding、xai-management、mistral、openrouter、openrouter-management。
- **波动 13（至少一轮通过）**：openai、anthropic、volcengine-agent、zai-global、deepseek、moonshot、kimi-coding、kimi-coding-plan、qwen、qwen-coding、qianfan、qianfan-coding、opencode-go。三轮原始报告中观察到的失败表现分三类：
  - **页面空白或尚未给出可识别内容**：openai、deepseek、moonshot、kimi-coding、qwen、qwen-coding、qianfan-coding。报告只能确认探针当时读不到正文/按钮；可能是 SPA 渲染延迟、网络失败或反自动化拦截，不能仅凭这一结果断言某一种原因。
  - **落在营销页或中间页，既不像登录墙也不像控制台**：anthropic、opencode-go、zai-global。重跑后能识别登录墙，说明这是页面落点/加载状态的波动。
  - **未登录仍可见控制台外壳**：volcengine-agent、kimi-coding-plan、qianfan。此类页面把登录动作放到后续操作，而不是页面入口；guest 的“页面级登录墙”判据因此不稳定。
  这些都是 **guest 登录墙检查** 的波动，不等于平台自动创建已通过或已失败；需用 auth-verify 在专用已登录 profile 中复核。
- **从未通过 4（真发现：未登录可浏览控制台，登录面只在动作时出现）**：`volcengine`（shell+裸“登录”按钮，产品本就有 volcengine 专用登录探测器佐证）、`qwen-token-plan`（阿里云控制台可匿名浏览）、`stepfun`（未登录即显示“创建新的密钥”入口）、`xai`（Welcome 页 + Sign in 链接）。这四家的自动创建不能依赖页面级登录墙识别，需在动作时交接登录——属于产品侧已知行为的实证，不是本工具缺陷。

判读约定：guest 通过 ≠ 平台验收通过，只证明“未登录会被识别为可交接登录”。波动平台建议重跑单平台复核（`--platform <id>`）；从未通过平台按 failed 人工核对。**auth-verify 级验收仍待专用 profile 人工登录后执行。**

## 真实 auth-verify 复跑（2026-08-31 修复后，17 平台，报告 `20260831173056766-9421-live-auth-verify.json`）

上一轮（`20260831171718115-d390`）的五类误判全部消除：openai 的 "Signing in…" 过渡页 → `waiting_for_user`（不再误报改版）；anthropic 组织选择页 → 本轮已过选择并入口级通过（分类器保留 chooser→waiting 分支）；moonshot 到达管理页 → 本轮入口级通过（另有管理页级兜底）；kimi-coding 骨架 → 本轮渲染完成入口级通过（未稳定时 `page_not_ready`）；qianfan-coding 空壳 → 本轮渲染出订阅内容并落 `blocked_prerequisite`（语义正确）。汇总：入口级通过 10、管理页级 1（volcengine，标题 “API Key 管理”）、`page_not_ready` 2（volcengine-agent/qianfan——本轮页面未就绪，不作结论）、`blocked_prerequisite` 3（qwen-coding/qwen-token-plan/qianfan-coding——需人工先取得订阅 Key，不点击生成/重置/订阅）、`waiting_for_user` 1（openai 登录过渡，建议稍后重跑）。退出码 2 = 存在诚实非通过项。

## 离线回归

`tests/provider-live-acceptance.test.ts`（76 用例）覆盖：三模式参数与安全拒绝；日常 profile / Cookie 迁移 / 无平台批量创建拒绝；guest 与 auth-verify 动作白名单（无创建/确认/删除原子）；create-cleanup 缺双确认、缺 `--session`、**默认硬禁用（身份全过也 exit 1、零 fetch、零委托）**、服务未就绪、身份闸门五种拒绝路径（无会话/记录缺失/校验失败/CDP 失活/witness 超时——注入解禁后仍 exit 1 且零委托）、委托清理失败即停（注入解禁验证管道）；补丁器（快照夹具 + `node --check` 语法 + 锚点漂移 fail closed + dist 缺失 fail closed）；启动记录校验（隔离/时效/副本完整性）；witness 协议与新鲜度过滤（stale/关态/错端口）；信号清理子进程测试（真实 SIGINT/SIGTERM → dispose + 临时目录删除 + 130/143；Windows 无法按 POSIX 语义送达信号，仅 POSIX 腿运行）；报告含 commit SHA 与诊断且敏感字段脱敏；同 root、同 stamp 的报告碰撞反例（两份内容都保留）；假浏览器“页面改版、入口消失”反向用例非零退出并产出可定位报告。`tests/fixtures/live-acceptance-reverse-harness.mjs`（改版反例）与 `tests/fixtures/live-identity-reverse-harness.mjs`（普通扩展在线→拒绝）可手动复演，均 exit 1。
