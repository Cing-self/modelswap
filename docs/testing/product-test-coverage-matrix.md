# 产品测试覆盖矩阵

> 审计基线：`e7accfc`（2026-08-31）。
>
> 这是一份“**现在有哪些自动化用例、它们实际证明什么、还没有证明什么**”的产品视角清单，不是一次发布的测试结果。每次候选发布仍要按 `docs/testing/ui-operation-checklist.md` 运行相关项目并记录真实结果。除非表格明确写“真实页面操作”，否则都不能把这里的覆盖理解成已经点过页面或访问过第三方平台。

## 如何阅读

- **后端/规则**：验证数据、接口或状态规则；不能证明用户在页面上看到正确结果。
- **页面渲染/编排**：验证组件显示或前端调用顺序；不能替代真实浏览器点击。
- **真实页面操作**：从路由和按钮进入，验证可见结果。目前仓库没有接入 CI 的完整 Browser E2E 套件，因此很多行仍是“未覆盖”。
- **外部平台真实动作**：会涉及真实账户或创建真实 Key，不能放进日常 CI；应由隔离测试账户和模拟控制台补足。

状态含义：**已覆盖（自动化）** 指已有自动化用例；**部分覆盖** 指只覆盖规则/后端/组件其中一层；**未覆盖** 指没有找到对应测试。

## 总览：产品页面与功能节点

| 页面/功能节点 | 已有测试文件 | 现在能证明的功能（人话） | 还没有证明的功能 | 覆盖状态 |
| --- | --- | --- | --- | --- |
| 首次引导、首页 | 未找到直接页面用例 | 间接覆盖模型缓存预热：`tests/frontend/model-cache-warmup.test.ts`、`tests/web/model-cache-warmup.test.ts` | 首次进入、卡片加载/失败、跳转、窄屏与深色模式 | 未覆盖 |
| 密钥管理（Vault） | `tests/vault-api.test.js`、`tests/vault/store.test.ts`、`tests/vault/store-cache.test.ts`、`tests/vault-refs.test.js`、`tests/web/key-import-model.test.js` | 密钥可保存、读取、引用给供应商；缓存不会读到过期数据；导入时能分辨模型 Key 与普通 Key | 用户在 Vault 页面新增、编辑、删除、取消、错误提示、密钥遮罩与深色/窄屏 | 部分覆盖 |
| 自动创建密钥 | 本文下方“自动创建”完整矩阵 | 平台目录、安全选按钮、部分登录识别、部分策略编排、Mistral 确认阶段依赖 | 每个平台的真实页面创建、登录后回到页面重试、完整 UI 弹窗和成功结果 | 部分覆盖 |
| 模型与供应商管理 | `tests/providers/*.test.ts`、`tests/application/provider-lifecycle-service.test.ts`、`tests/web/provider-flow.test.ts`、`tests/web/switch-provider.test.ts`、`tests/models-catalog.test.ts`、`tests/web/models-dev.test.ts` | 新增/修改/删除供应商，模型来源、缓存、路由与错误边界；目录数据不会错误写回 | 模型管理页面的完整点击流程、筛选/搜索/详情面板、错误文案和响应式布局 | 部分覆盖 |
| Agent 管理与切换 | `tests/providers/adapters/*.test.ts`、`tests/providers/registry.test.ts`、`tests/integration/agent-native-route-matrix.test.ts`、`tests/web/agent-provider-switch-matrix.test.ts`、`tests/web/provider-delete-service.test.ts` | 10 个 Agent 的配置写入、模型切换、删除供应商和原生路由 | Agent 页面按钮、批量操作、空状态和真实桌面端文件变化后的 UI 回显 | 部分覆盖 |
| 同步、备份与设备配对 | `tests/sync*.test.*`、`tests/web/lan-sync.test.ts`、`tests/web/sync-agent-*.test.ts`、`tests/frontend/lan-primary-pairing.test.ts`、云端适配器测试 | 推送/拉取、冲突、排队、局域网配对协议、Agent 配置同步与密钥引用 | 首次配对、加入设备、更换同步密码、失败重试的真实页面操作；详见既有 UI 清单 | 部分覆盖 |
| 配置历史/快照 | `tests/providers/snapshots.test.ts`、`tests/providers/migration.test.ts`、`tests/config*.test.*` | 创建、保留、读取、恢复快照；配置迁移与解析 | 配置历史页面浏览、恢复确认、取消和错误提示 | 部分覆盖 |
| 用量与告警 | `tests/usage*.test.ts`、`tests/web/usage-provider-path.test.ts`、`tests/web/mimo-usage-*.test.ts` | 多平台余额/用量解析、告警等级、手工/控制台卡片文案与登录提示规则 | 用量页面实际刷新、筛选、卡片展开、网络失败展示和响应式布局 | 部分覆盖 |
| 设置、诊断、浏览器扩展 | `tests/frontend-browser-extension-section.test.ts`、`tests/frontend-sync-import-status.test.ts`、`tests/web/extension-token-endpoint.test.js`、`tests/web/ws-extension-auth.test.js`、`tests/web/ui-events.test.ts` | 扩展连接/安装信息层级、扩展令牌来源限制、前后端事件主题 | 设置各分区的路由导航、诊断日志操作、扩展真实安装/断连后的可见反馈 | 部分覆盖 |
| 更新检查与桌面安装 | `tests/web/update-check.test.js`、`tests/web/update-watcher.test.js`、`tests/frontend/useAppUpdate.policy.test.ts`、`tests/frontend/update-check-entry.test.ts` | 版本比较、后台检查、304/限流处理、静默检查不隐藏已发现更新、诊断页“检查更新”按钮 | 真实桌面包下载完成后的重启安装、左上角悬浮更新卡的真实交互、深色模式视觉 | 部分覆盖 |
| 日志页面 | 未找到 `LogsPage` 的直接用例；日志写入被部分后端路径间接使用 | 个别后端调用不因日志模块缺失而崩溃 | 查看、筛选、展开、导出、空态和错误态 | 未覆盖 |
| CLI、安装与升级 | `tests/commands/*.test.ts`、`tests/config/i18n.test.ts`、`tests/utils/semver.test.ts` | Provider CLI 参数、Skill 命令、升级版本判断与多语言基础文案 | 从终端真实安装、升级失败回滚、各平台 shell 交互 | 部分覆盖 |
| 发布、构建与运行包 | `tests/build/runtime-closure.test.ts`、`tests/build/publish-notes-gate.test.ts` | 编译包能加载、发布说明在副作用前校验 | Windows/macOS/Linux 安装包实际启动与升级 | 部分覆盖 |

## 密钥管理（Vault）

| 用户动作/风险 | 现有测试文件 | 已覆盖什么 | 没测到什么 |
| --- | --- | --- | --- |
| 保存与读取密钥 | `tests/vault-api.test.js`、`tests/vault/store.test.ts` | 保存接口、记录字段、描述信息 | Vault 页面表单校验和保存成功提示 |
| 密钥缓存与并发 | `tests/vault/store-cache.test.ts`、`tests/utils/atomicWrite*.test.ts` | 缓存刷新、原子写入、并发写入不互相覆盖 | 用户连续点击保存/刷新时的页面状态 |
| 供应商引用密钥 | `tests/vault-refs.test.js`、`tests/providers/auth.test.ts`、`tests/web/provider-auth.test.ts` | 供应商可以解析 Vault 引用；无效 Key 有错误边界 | UI 选择密钥、解绑、删除后页面更新 |
| 导入 Key 并识别模型 Key | `tests/web/key-import-model.test.js` | 区分模型 Key 与普通密钥，避免错误入库 | 拖入/粘贴导入的完整页面流程 |
| 删除与取消 | 供应商删除见 `tests/web/provider-delete-service.test.ts` | 删除供应商时相关配置处理 | Vault 单条密钥删除确认、取消、恢复与真实 UI |

## 自动创建密钥：共用能力

| 测试文件 | 覆盖的功能 | 明确未覆盖的部分 |
| --- | --- | --- |
| `tests/auto-create-platforms.test.ts` | 平台是否在目录中、关键页面地址、部分平台的表单配置和安全限制 | 不打开任何第三方页面、不创建 Key |
| `tests/auto-create-bilingual-resolver.test.ts` | 在中英文页面中只选择明确、安全的“创建”按钮；拒绝删除、重置、歧义按钮；解析部分返回的 Key 形状 | 不验证真实页面 DOM 是否仍与配置相同 |
| `tests/auto-create-browser-orchestrator.test.ts` | 两阶段“先识别、再点击”编排能返回成功结果 | 不走具体平台完整流程 |
| `tests/auto-create-generic-form-strategy.test.ts` | 通用表单在填写后能用已注入的安全解析器找到确认按钮；缺少依赖会在启动时失败；覆盖本次 Mistral 报错 | 不是 Mistral 网站真实表单，不会创建 Key |
| `tests/auto-create-browser-state.test.ts` | 能识别典型登录路由、密码框、短信登录壳 | 不等于每个网站的登录页都已实测 |
| `tests/auto-create-login-handoff.test.ts` | 后端要求登录时，前端登录交接组件只显示安全的 HTTPS 登录链接 | 没有在完整 Vault 页面实际点击“开始自动创建” |
| `tests/auto-create-strategy-wiring.test.ts` | 智谱、火山、MiniMax、通用流程的依赖传递；延迟登录页不应点创建 | 不访问第三方控制台 |
| `tests/auto-create-pure-modules.test.ts`、`tests/auto-create-form-state.test.ts` | Key 提取、危险动作拒绝、前端表单状态、中文“需要登录”转交接状态 | 真实浏览器、真实账户、创建后的明文读取 |

### 平台逐项矩阵

“专属”表示该平台有独立策略或配置断言；“共用”表示复用上面的通用安全策略测试。两者都**不等于真实第三方网站已跑通**。

| 平台 | 现有测试用例文件 | 覆盖的功能 | 未测到的关键功能 |
| --- | --- | --- | --- |
| Cloudflare | `auto-create-strategy-wiring`、`auto-create-platforms` | 通过官方 API 创建时的请求格式、目录配置 | 真实 Cloudflare 账户创建/删除与权限不足提示 |
| OpenAI | `auto-create-platforms`、`auto-create-bilingual-resolver` | 页面地址、表单规则、通用安全选按钮 | 未登录交接、真实创建、一次性明文读取 |
| Anthropic | `auto-create-platforms`、`auto-create-bilingual-resolver` | 密钥名称、到期时间和确认动作配置 | 真实下拉选择、登录与创建结果 |
| 火山引擎 | `auto-create-strategy-wiring`、`auto-create-platforms` | 特殊流程的登录壳识别；创建前不误操作 | 真实账号、验证码、创建后 Key 获取 |
| 火山引擎 Agent Plan | `auto-create-strategy-wiring`、`auto-create-platforms` | 进入 Agent Plan 的特殊地址与登录前停止 | 套餐未开通/过期、真实创建 |
| 腾讯云 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 页面、名称、确认和复制配置 | 身份验证、真实创建与复制 |
| 腾讯云 Token Plan | `auto-create-platforms`、`auto-create-bilingual-resolver` | 仅复用/复制订阅 Key，不触发重置 | 未登录、无订阅 Key、真实复制 |
| 智谱 AI（国内站） | `auto-create-browser-state`、`auto-create-strategy-wiring`、`auto-create-login-handoff`、`auto-create-platforms` | 短信登录页、延迟渲染登录页、登录链接与创建前停止 | 完整 Vault 页面点击后登录、返回重试、真实创建 |
| Z.AI（国际站） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 创建/复制配置与掩码 Key 防护 | 登录、真实创建与复制 |
| MiniMax（国内站） | `auto-create-strategy-wiring`、`auto-create-platforms` | 未登录时创建前停止；特殊页面配置 | 真实登录、弹窗、创建与复制 |
| MiniMax Token Plan（国内） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 只复制已有订阅 Key，不重置 | 真实订阅态、复制失败提示 |
| MiniMax（国际站） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 国际站创建表单配置 | 未登录与真实创建 |
| MiniMax Token Plan（国际） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 只复制已有订阅 Key 的规则 | 未登录、订阅缺失、真实复制 |
| DeepSeek | `auto-create-platforms`、`auto-create-strategy-wiring` | 页面、名称输入、确认按钮配置；通用流程安全失败 | 真实登录、创建、首次结果读取 |
| Moonshot API 平台 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 默认项目和确认动作配置 | 真实项目选择、登录、创建 |
| Kimi（国内站） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 名称、默认项目和复制配置 | 真实项目选择、创建后一次性明文 |
| Kimi Coding Plan | `auto-create-platforms`、`auto-create-browser-state` | 公共首页登录识别与表单配置 | 登录完成后的重试、真实创建 |
| 阿里云百炼 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 名称、确认与页面配置 | 真实登录、创建 |
| 阿里云百炼 Coding Plan | `auto-create-platforms`、`auto-create-bilingual-resolver` | 只复用订阅 Key，不生成/重置 | 真实订阅状态与复制 |
| 阿里云百炼 Token Plan | `auto-create-platforms`、`auto-create-bilingual-resolver` | Token Plan 页面及复用规则 | 真实订阅状态与复制 |
| 硅基流动 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 创建和删除表单配置 | 真实登录、创建、删除确认 |
| 百度千帆 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 表单和安全确认配置 | 真实登录、创建、复制 |
| 百度千帆 Token Plan | `auto-create-platforms`、`qianfan-coding.test.ts` | 套餐专属接口、仅复制已有 Key | 真实订阅、未登录、复制 |
| 小米 MiMo | `auto-create-platforms`、`auto-create-bilingual-resolver` | API Key 页面和确认动作配置 | 真实登录、创建和复制 |
| 小米 MiMo Token Plan | `auto-create-platforms`、`auto-create-bilingual-resolver` | 仅复制已有套餐 Key，拒绝重置 | 真实订阅、复制和错误展示 |
| 阶跃星辰 | `auto-create-platforms`、`auto-create-bilingual-resolver` | 平台目录与通用表单/安全动作规则 | 登录、真实创建 |
| xAI（Grok） | `auto-create-platforms`、`auto-create-bilingual-resolver` | 团队 API Key 页面与配置 | 真实登录、团队选择、创建 |
| xAI Management Key | `auto-create-platforms`、`auto-create-bilingual-resolver` | 用量所需只读权限的默认选择 | 真实权限页面、创建、权限不足 |
| Mistral | `auto-create-platforms`、`auto-create-generic-form-strategy`、`auto-create-bilingual-resolver` | 本次“填写后确认”分支、依赖传递、一次性结果读取规则 | Mistral 真实登录、确认按钮、创建成功/失败页面 |
| OpenRouter | `auto-create-platforms`、`auto-create-strategy-wiring`、`auto-create-browser-state` | 公共首页被识别为需要登录，不误报缺少创建按钮 | 登录后工作区、真实创建 |
| OpenRouter Management Key | `auto-create-platforms`、`auto-create-bilingual-resolver` | 管理 Key 与推理 Key 分离 | 真实登录、创建、权限 |
| OpenCode Go | `auto-create-platforms`、`auto-create-bilingual-resolver` | 目录与通用安全选按钮规则 | 真实登录、创建 |

### 自动创建目前必须补齐的测试

| 优先级 | 要补的用例 | 为什么需要 |
| --- | --- | --- |
| P0 | 每个平台的“未登录 → Vault 弹出登录交接 → 不创建 Key” | 这是用户现在遇到的关键失败路径；不能只测后端错误文本。 |
| P0 | Mistral 等通用表单的“填写名称 → 确认 → 成功/安全失败”本地模拟控制台 E2E | 防止策略拆分时函数漏传、按钮定位或页面结果断裂。 |
| P0 | 自动创建成功、取消、验证码/套餐缺失、Key 数量已满的 UI 状态 | 避免把外部状态误报成“创建按钮未找到”。 |
| P1 | 每个真实第三方平台的隔离账号冒烟 | 只能用专门测试账户；不进常规 CI，但应在平台页面改版后执行。 |

## 模型、供应商与 Agent

| 功能 | 现有测试文件 | 已覆盖什么 | 未测到什么 |
| --- | --- | --- | --- |
| 供应商新增、编辑、删除 | `tests/providers/store.test.ts`、`tests/application/provider-lifecycle-service.test.ts`、`tests/web/provider-flow.test.ts`、`tests/web/provider-delete-service.test.ts` | 数据保存、删除、模型和密钥关联、错误边界 | Models 页面表单、删除确认、列表即时更新 |
| 供应商预置和目录 | `tests/providers/presets*.test.ts`、`tests/models-catalog.test.ts`、`tests/web/models-dev.test.ts` | 预置与目录对齐、模型筛选和本地缓存来源 | 目录 UI 筛选、搜索、详情抽屉 |
| 切换模型/站点 | `tests/providers/routing.test.ts`、`tests/commands/provider*.test.ts`、`tests/web/switch-provider.test.ts`、`tests/web/agent-provider-switch-matrix.test.ts` | 路由规则、保存与各 Agent/站点/模型组合 | 用户在 Models/Agents 页面逐项点击切换 |
| Agent 配置文件 | `tests/providers/adapters/*.test.ts`、`tests/providers/registry.test.ts`、`tests/providers/snapshots.test.ts`、`tests/integration/agent-native-route-matrix.test.ts` | 各 Agent 配置格式、模型写入、快照、恢复、原生路由 | 真实桌面端 Agent 已运行时的 UI 回显与冲突提示 |
| 迁移与旧配置兼容 | `tests/providers/migration.test.ts`、`tests/providers/data-architecture.test.ts`、`tests/config-mutation-contract.test.js` | 旧数据迁移、不丢未知字段、受控写入 | 升级后用户页面上看到的迁移提示 |

## 同步、备份、配置历史

| 功能 | 现有测试文件 | 已覆盖什么 | 未测到什么 |
| --- | --- | --- | --- |
| 云端推送/拉取与冲突 | `tests/sync.test.js`、`tests/sync-domain.test.js`、`tests/platform.test.js` | 认证、推拉、冲突处理、失败不影响健康目标 | 同步页面完整操作和错误显示 |
| 自动同步队列 | `tests/sync-scheduler.test.ts`、`tests/utils/atomicWrite-concurrency.test.ts` | 合并写入、串行执行、重试/独占规则 | UI 上“同步中/失败/重试”是否正确 |
| 局域网配对 | `tests/web/lan-sync.test.ts`、`tests/frontend/lan-primary-pairing.test.ts` | listener、配对码交换、主设备规则、部分前端编排 | 真实设置页从输入密码到显示/加入设备；现为 PARTIAL/BLOCKED，详见 `ui-operation-checklist.md` |
| Agent 同步恢复 | `tests/web/sync-agent-*.test.ts` | 所有 Agent 的配置、模型和 Vault 引用同步后可恢复 | 多设备真实 UI 同时操作与网络中断恢复 |
| 云存储适配器 | `tests/supabase-adapter.test.js`、`tests/cloudflare-{d1,kv,r2}.test.js` | 各云端存储接口与数据规则 | 使用真实云账户的网络、权限、限流场景 |
| 快照/配置历史 | `tests/providers/snapshots.test.ts`、`tests/config*.test.*` | 快照写入、保留、恢复和配置读取 | 配置历史页面查看、恢复确认、取消 |

## 用量、设置、更新、扩展与日志

| 页面/功能 | 现有测试文件 | 已覆盖什么 | 未测到什么 |
| --- | --- | --- | --- |
| 用量统计 | `tests/usage*.test.ts`、`tests/web/usage-provider-path.test.ts`、`tests/web/mimo-usage-*.test.ts` | 多平台用量/余额解析、展示文案、告警规则、登录交接信息 | Usage 页面真实刷新、筛选、卡片交互与异常页面 |
| 设置与同步导入 | `tests/frontend-sync-import-status.test.ts`、`tests/frontend/lan-primary-pairing.test.ts` | 导入状态文字、配对编排逻辑 | 设置页面各分区导航、刷新保持分区、深色/窄屏 |
| 诊断与更新入口 | `tests/frontend/update-check-entry.test.ts`、`tests/web/update-check.test.js` | “检查更新”动作、版本比较、不会再显示旧的详情入口 | 诊断页真实点击、toast、左上角悬浮内容 |
| 后台更新和安装 | `tests/web/update-watcher.test.js`、`tests/frontend/useAppUpdate.policy.test.ts`、`tests/web/ui-events.test.ts` | 定时发现新版本、304/限流、静默检查保持状态、下载后安装策略 | 真实 Electron 下载、自动重启安装、夜间模式悬浮卡 |
| 浏览器扩展 | `tests/frontend-browser-extension-section.test.ts`、`tests/web/ws-extension-auth.test.js`、`tests/web/extension-token-endpoint.test.js` | 安装说明层级、扩展连接鉴权、令牌来源限制 | 用户安装扩展、断连重连、实际控制浏览器后的完整反馈 |
| 日志 | 未找到直接测试文件 | 后端其余测试会间接写少量日志 | 日志页搜索、筛选、展开、导出、空态和错误态 |

## CLI、运行包与发布

| 功能 | 现有测试文件 | 已覆盖什么 | 未测到什么 |
| --- | --- | --- | --- |
| CLI Provider 与 Skill | `tests/commands/provider*.test.ts`、`tests/commands/skill.test.ts` | 参数解析、模型写入、Skill 命令 | 用户终端交互、异常输入提示、跨 shell 体验 |
| 升级 | `tests/commands/upgrade.test.ts`、`tests/utils/semver.test.ts` | 版本比较、升级建议与命令决策 | 真实下载、替换、失败回滚 |
| 运行包完整性 | `tests/build/runtime-closure.test.ts` | 编译输出中依赖齐全、可启动健康检查 | 实际安装包在三种桌面系统打开页面 |
| 发布门禁 | `tests/build/publish-notes-gate.test.ts` | 发布说明在推 tag/publish 前存在且顺序正确 | npm/GitHub Release 的真实外部发布（不在普通测试中执行） |

## 当前最重要的覆盖缺口与补齐顺序

| 优先级 | 节点 | 要补的用户路径 | 需要的测试形式 |
| --- | --- | --- | --- |
| P0 | Vault / 自动创建 | 未登录、登录交接、登录后重试、成功、取消、验证码、套餐/额度不足 | 隔离 Browser E2E + 本地模拟控制台；真实平台使用测试账户冒烟 |
| P0 | Vault | 新增、编辑、删除、取消、错误不泄露密钥 | 隔离 Browser E2E |
| P0 | 同步设置 | 首次配对、加入设备、改密码、失败重试、关闭返回 | 隔离 Browser E2E；现有后端测试不能替代 |
| P1 | 模型/供应商与 Agent 页面 | 新增供应商、切换模型、删除、错误回显 | Browser E2E + 临时 HOME |
| P1 | 用量、日志、设置 | 页面加载、刷新、空态、错误、筛选、深色/窄屏 | Browser route/visual smoke |
| P1 | 更新与桌面安装 | 更新悬浮卡、下载完成自动安装 | Electron 集成测试或受控人工桌面 smoke |

## 发布时如何使用本表

1. 先找到本次改动所在的产品节点；不能只按源文件或测试目录找。
2. 运行该节点已有的测试文件，并把**本轮真实命令、通过数、运行环境**写进发布清单。
3. 若表中“未测到的关键功能”受本次改动影响，相关行不能写 PASS；要补测试或明确标记 BLOCKED。
4. 运行 `npm test -- --run` 与 `npm run build` 是基础门槛，不会替代页面/第三方/桌面端测试。

