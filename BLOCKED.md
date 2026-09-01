无（两个 QA P0 均已修复并有先红后绿的确定性回归测试）。

真实未覆盖边界（非阻断）：
- useAppUpdate 的"SSE 事件→check()"与"visibilitychange→check()"两条 wiring 本身仍无法在现有 node 测试环境挂载验证（无 DOM/jsdom，任务禁新增依赖）。P0-2 的状态语义已通过导出的 beginUpdateCheck/failUpdateCheck 纯函数确定性覆盖；wiring 为对这两个函数的三行调用，与生产其他消费者使用的 useDataChanged 同一模式。
- check() 失败路径的 await 返回值恒为 error 状态（诊断真实）；仅显式路径消费该返回值（菜单 toast），silent 路径忽略返回值——状态保护完全由纯函数经 setUpdate 保证。
- GitHub releases/latest 传播延迟不可控：收敛保证 = "服务正常且 latest 已更新后，下一轮内"，由 fake-timer 固定间隔语义承载。

---

# provider-flow Ubuntu 竞态修复（2026-08-31）未覆盖边界
- 本任务书在后半截断（任务 0 失败日志之后的内容未收到）。按可见使命与既有任务书惯例执行：根因修复 + 体外/定向/全量/build 验证 + PROGRESS.md 记录；未推送未发布，未触碰发布链路文件。若截断部分另有白名单或额外验收项，需补发后核对。
- 竞态为 Ubuntu 时序型，本机（macOS）原生未复现（未修复版本本地多轮未红）。正确性依据为代码级入队时机分析（recordLocalChange 同步入队）+ 体外受控交错实证（未修复 straddle 必现 overrides 丢失、drain 后存活）+ 修复后 6 轮（含 CPU 饱和）与 CI 同款默认并行全量绿。最终确认以远端 Ubuntu CI 复跑为准（未推送，待授权）。

---

# auth-verify 判定修复后的残余边界（2026-09-01，非阻断、如实申报）
- openai：专用 profile 停在 "Signing in…" 登录过渡态（本轮 waiting_for_user）——需稍后重跑或人工确认该 profile 登录态；入口级验收暂缓。
- volcengine-agent / qianfan：本轮页面在有界窗口内未稳定（page_not_ready）——不判改版也不判通过；待页面就绪后复跑方可给结论。
- volcengine：为管理页级通过（标题 "API Key 管理"），非入口级；入口级验收仍待创建按钮出现在可见摘要。
- qwen-coding / qwen-token-plan / qianfan-coding：blocked_prerequisite——需人工先取得/生成订阅 Key（自动化不点击生成/重置/订阅/创建）。
- 以上均为外部前置或页面状态问题，非工具缺陷；工具未对任何第三方页面执行写操作。

---

# 火山引擎 Agent Plan 登录误判修复后的边界（2026-09-01，非阻断）
- 真实自动创建会产生第三方 Key，本轮未执行；已验证的是登录判定与套餐重定向分支，未验证真实创建、读取和清理链路。
- 专用已登录测试 profile 当前被火山方舟重定向到 `/subscription/agent-plan`。这证明该会话不是未登录；若日常自动化浏览器同样重定向，修复后会提示套餐未开通、失效或权益未生效。具体套餐状态仍需以用户实际账号与控制台为准。
