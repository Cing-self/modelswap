# codex/fix/codex-site-switch 分支审核指南

> 16 个提交，合入 main @ `9789ca1`（基于 `f0a551a`），全量 94 文件 / 805 测试绿，构建通过。
> 背景：Codex 0.150.1（2026-08-29 自动更新）移除 chat 线协议、仅支持 OpenAI Responses 协议，
> 引发了连锁问题；本分支同时修复排查中暴露的多处历史 bug。

## 按主题分组

### A. Codex Responses 协议适配（0.150 兼容）
| 提交 | 内容 |
|------|------|
| `7be20c2` | GLM coding 端点映射（chat→Responses 网关）；Electron 下 vault 取钥命令探测+回退；catalog modality 过滤为 Codex 闭集（text/image/audio） |
| `6d31795` | 千帆等无 Responses 端点的站点快速失败（探测实证 404） |
| `eb62707` | 静态黑名单重构为应用时实时探测 `/responses`（404 拒绝，其他放行，探测失败忽略）；测试桩两个 seam |
| `6188067` | `responses` 成为正式端点类型：预设（智谱系）+ 编辑器下拉 + codex 优先使用该类端点；adapters API 附带兼容标记；picker 过滤不兼容站点（无提示文本）；站点卡片按添加序 |
| `c7fdac7` | 清理桌面端写入的陈旧 `[models]` 表（仅当指向已删 okit provider） |
| `3b6addd` | 第三方 apply 时清除订阅专属的 `service_tier`（kimi/opencode 等启动警告根因） |

### B. 打包 CLI 与配置写入 bug
| 提交 | 内容 |
|------|------|
| `d0e9dae` | **commander argv 约定 bug**（核心）：ELECTRON_RUN_AS_NODE 下 `process.versions.electron` 仍存在，commander 自动切 electron 约定只剥 1 层 argv → 脚本路径占住命令位 → 打包 app 的 CLI 所有子命令失效（`vault get` 打帮助文本）。修复：显式传 `process.argv` |
| `94e6099` | .gitignore 匹配 node_modules 软链（worktree 场景） |
| `a1fa92e` | **站点删除墓碑修复**：`getAgentState` 浅拷贝共享引用致 before/after diff 永不触发 + `replaceAgentState` 逐站点合并语义（缺席≠删除）→ user.json 永远删不掉站点。显式走 `removeAgentSite` 墓碑操作 |

### C. Agent 配置健壮性
| 提交 | 内容 |
|------|------|
| `2b5df99` | mimo：模型 limit 必须成对（缺 output 用保守回退），否则 mimocode 启动崩溃 |
| `6e09e5e` | 同类修复推广：`completeTokenLimit` 共享工具接入 opencode/zcode/mimo 三 adapter（opencode 曾因此拒绝启动） |
| `16570f5` | kimi：清掉无法 heal 的陈旧模型条目与其 `default_model`（kimi 0.38 对残缺条目启动即崩，二分实证） |
| `5f8f8e3` | **启用开关三断链**：applySelection 保留原 enabled 值 + setAgentProviderEnabled 未传 true + 前端走保存而非启用端点 → additive 站点禁用后启用无反应 |

### D. 路由（模型来源解析）
| 提交 | 内容 |
|------|------|
| `7befb34` | availability 记录指向已消失端点 ID 时按未记录处理（此前硬失败所有保存/切换） |
| `9789ca1` | 双协议回退：记录全在另一协议端点（deepseek anthropic 无 /models，实测 404）时允许回退到 adapter 支持的端点；同协议多端点仍严格显式匹配（cross-endpoint 400 保护不变）。修复 claude 添加 DeepSeek 站点必失败 |

### E. UI
| 提交 | 内容 |
|------|------|
| `83bbc2c`→`83bbc2f` | 站点卡片按添加顺序（此前中文名 collation 乱跳）；picker 保持名称序 |

## 审核重点建议
1. `src/providers/adapters/codex.ts`：探测 seam（`setVaultProbeForTests`/`setResponsesEndpointProbeForTests`）与 Electron-only 生效域；`CODEX_RESPONSES_ENDPOINTS` 映射表
2. `src/providers/routing.ts`：两处 gate 放宽的边界（stale endpoint、跨协议回退）——对照 `tests/providers/routing.test.ts` 两个新用例
3. `src/infrastructure` 未动；user.json 写路径未变（P0 交付已在 main）
4. 行为变化点：千帆/z.ai 全球/火山/硅基/阶跃站点不再可配置给 codex（实时探测拒绝，中文报错）；智谱系预设多一条 responses 端点

## 已知遗留（未包含，供后续）
- openclaw 与 Node 26 不兼容（上游问题，非本仓）
- GLM-5.3 评审 P2 项：契约测试 code→registry 反向对账、native-only 零写入自动断言、LAN listener stale loopback、死代码清理
- 订阅型端点的权益模型探测（403 预标记）增强未做
