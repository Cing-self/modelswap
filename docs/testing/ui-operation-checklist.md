# 前端真实操作验收清单

## 使用方式

这是页面操作层的唯一清单，和专项发布清单并行使用。每一轮候选都复制相关表格并填写状态；状态只能是 `PASS`、`FAIL`、`PARTIAL`、`BLOCKED`、`NOT RUN`。

- `PASS`：该行列出的自动化层级和证据齐全。
- `PARTIAL`：有部分单测、集成或人工证据，但缺少本行规定的证据；不能作为发布通过依据。
- `BLOCKED`：存在失败、已知缺口或阻断依赖。
- `NOT RUN`：本轮尚未执行。

涉及同步、密钥、配对、数据删除或不可逆操作的成功与失败路径为 P0；常规文案、视觉一致性、诊断快捷操作为 P1。P0 不能用 P1、单测或人工截图替代。

## 全产品基础矩阵

| ID | P0/P1 | 页面/域 | 操作与预期 | 最低自动化证据 | 本轮状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| UI-G01 | P0 | 应用启动/路由 | 已缓存数据先展示；后台刷新不使整个页面长期空白；失败可见且不丢已有数据 | browser E2E：首页、模型、用量各一条 cached + pending/failed 路径 | NOT RUN | 首次加载优化变更必须更新本行。 |
| UI-G02 | P1 | 全局布局 | 侧边栏、窄屏、深色模式、加载/空/错误态无横向溢出或遮挡 | browser viewport 375px + dark smoke | NOT RUN | 共享组件改动需执行。 |
| UI-G03 | P1 | 快速启动 | 初始展示、卡片加载态、跳转与错误状态 | component + browser route smoke | NOT RUN | 仅改首页时执行。 |
| UI-G04 | P0 | 密钥管理 | 新增、绑定、编辑、删除/取消和错误态不泄露密钥 | integration + isolated browser E2E | NOT RUN | 密钥变更必须执行。 |
| UI-G05 | P0 | 模型管控 | 缓存优先、测试连接真实目录、保存后重开一致；失败保留已有模型 | integration + isolated browser E2E | NOT RUN | 目录/缓存/保存改动必须执行。 |
| UI-G06 | P1 | 用量统计 | live/console/manual 三种卡片的刷新策略、文案与错误样式一致 | component + browser route smoke | NOT RUN | 用量卡片改动时执行。 |
| UI-G07 | P1 | 设置 | 直接 URL、侧栏导航、刷新后的 section 一致；无失效快捷操作 | browser route smoke | NOT RUN | 设置任一 section 改动时执行。 |

## Settings / 同步与诊断操作矩阵 — R4 当前基线

| ID | P0/P1 | 状态/前置 | 操作与预期 | 现有覆盖 | 本轮状态 | 责任与下一步 |
| --- | --- | --- | --- | --- | --- |
| UI-SYNC-01 | P0 | 首次设备，无同步密码 | 打开“添加设备”→选主设备→输入密码→生成配对码；顺序为保存密码→启动 listener→创建码，界面立刻显示代码卡 | `tests/frontend/lan-primary-pairing.test.ts` 覆盖 helper 编排；隔离浏览器手测已通过 | PARTIAL | 开发：补浏览器 E2E；QA：将它接入 CI 后才能标 PASS。 |
| UI-SYNC-02 | P0 | 已启用 listener | 选主设备后自动生成；点“重新生成配对码”后显示新代码，旧码失效 | 后端 `tests/web/lan-sync.test.ts`；浏览器手测 | PARTIAL | 缺独立浏览器 E2E 及旧码失效 DOM/API 证据。 |
| UI-SYNC-03 | P0 | 首次/服务异常/返回空码 | listener 启动失败或返回空码时不显示假成功；页面有可见错误，可再次尝试 | `lan-primary-pairing.test.ts` 覆盖错误传播 | PARTIAL | 缺 DOM 错误态与重试 browser E2E。 |
| UI-SYNC-04 | P0 | 加入现有设备 | 选加入设备→粘贴有效/无效/过期配对码；成功进入已连接态，失败有明确错误且不写半成品配置 | `tests/web/lan-sync.test.ts` 覆盖协议错误 | BLOCKED | 缺页面真实操作与持久化验证。 |
| UI-SYNC-05 | P0 | 已配置同步 | 更换密码、取消、返回/关闭、刷新页面均不丢状态或留下错误 listener | 未找到该流程的前端操作测试 | BLOCKED | QA 已识别覆盖缺口；开发补 state + browser E2E。 |
| UI-SYNC-06 | P1 | 375px/深色 | 主设备、加入设备、错误与代码卡无截断/溢出；按钮文字简短可读 | 现有截图手测 | PARTIAL | 缺自动化 viewport/dark 截图或 DOM 断言。 |
| UI-SYNC-07 | P1 | 文案 | 主流程标题“生成配对码”、说明简短；不重复或暗示配对码会展示密钥 | i18n + 隔离浏览器手测 | PARTIAL | 文案变更后做 browser snapshot。 |
| UI-DIAG-01 | P1 | 诊断页 | 不出现“打开扩展目录”；保留检查更新、复制诊断及日志操作 | 隔离浏览器手测 | PARTIAL | 补 settings diagnostics route E2E；浏览器扩展页自己的目录操作不受影响。 |
| UI-SYNC-08 | P1 | 信息层级 | 最后同步在页头右上；设备数、云端目标数只各自在下方分区出现，不重复统计 | 隔离浏览器 DOM + visual smoke | PARTIAL | 当前浏览器已验证；缺 browser snapshot 回归。 |
| UI-SYNC-09 | P1 | 设备卡 | 本机与其他设备分行呈现；名称、机器/地址、主设备/在线状态层级清晰，窄屏不拥挤 | 隔离浏览器 DOM + 375px visual smoke | PARTIAL | 当前桌面 visual smoke 已验证；缺窄屏自动化。 |
| UI-SYNC-10 | P1 | 云端备份卡 | 不显示文字“编辑”按钮；点击平台信息区展开/收起配置，测试连接与开关仍可用 | component/browser interaction test | PARTIAL | 当前浏览器验证 WebDAV 可展开后收起，控制台无错误；缺自动化回归。 |
| UI-SYNC-GATE | P0 | 本页发布门禁 | UI-SYNC-01 至 UI-SYNC-05 全部 PASS，才可把同步设置页标为浏览器操作验收通过 | 上述逐行证据 | BLOCKED | 当前没有正式 Browser E2E runner/CI 门禁；不得宣称该页“全部验证完成”。 |

## 本轮缺陷归类：配对码未生成

| 字段 | 结论 |
| --- | --- |
| Defect | 主设备首次输入密码后点击“生成配对码”，页面没有代码卡。 |
| 根因 | 前端异步编排把密码保存、listener 启动、配对码创建串在一起；静默错误被吞，失败没有显示给用户。 |
| 现有清单覆盖 | 发生前没有本页真实操作行；这是 QA 清单缺口。 |
| 现有测试覆盖 | `tests/web/lan-sync.test.ts` 仅协议/后端；没有首装浏览器操作。新增 helper 单测改善编排覆盖，但仍非 E2E。 |
| 主责角色 | 开发：修正状态机与补回归；QA：补齐清单、阻断未覆盖的 P0 UI 行。 |
| 扩面 | 首次主设备、已启用重生成、空码/启动失败、加入设备、改密码、关闭/返回、窄屏/深色、直接路由。 |
| 当前结论 | 代码与 helper 回归、隔离人工浏览器验证已完成；正式 Browser E2E 和 CI 门禁尚缺，因此整页状态为 `BLOCKED`。 |

## Browser E2E 的固定要求

每个 P0 前端操作用例必须：

1. 启动编译后的应用或等价生产服务，使用临时 `HOME` 和 `USERPROFILE`；fixture 用端口 `0`。
2. 从实际路由和可点击入口操作，断言 DOM 可见结果、错误和必要的网络请求顺序；不得只调用组件方法或直接调用 API。
3. 用专用假数据和本地 mock 服务，不读真实 Vault、账户、配对码或占用 3780。
4. 在 `finally`/`afterAll` 关闭 server、browser 与 listener；结束后检查没有 fixture 遗留端口。
5. 接入 CI 的 macOS、Ubuntu、Windows job。任何平台失败都使相应 P0 行 `FAIL`。
