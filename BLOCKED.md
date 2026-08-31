无（两个 QA P0 均已修复并有先红后绿的确定性回归测试）。

真实未覆盖边界（非阻断）：
- useAppUpdate 的"SSE 事件→check()"与"visibilitychange→check()"两条 wiring 本身仍无法在现有 node 测试环境挂载验证（无 DOM/jsdom，任务禁新增依赖）。P0-2 的状态语义已通过导出的 beginUpdateCheck/failUpdateCheck 纯函数确定性覆盖；wiring 为对这两个函数的三行调用，与生产其他消费者使用的 useDataChanged 同一模式。
- check() 失败路径的 await 返回值恒为 error 状态（诊断真实）；仅显式路径消费该返回值（菜单 toast），silent 路径忽略返回值——状态保护完全由纯函数经 setUpdate 保证。
- GitHub releases/latest 传播延迟不可控：收敛保证 = "服务正常且 latest 已更新后，下一轮内"，由 fake-timer 固定间隔语义承载。

---

# provider-flow Ubuntu 竞态修复（2026-08-31）未覆盖边界
- 本任务书在后半截断（任务 0 失败日志之后的内容未收到）。按可见使命与既有任务书惯例执行：根因修复 + 体外/定向/全量/build 验证 + PROGRESS.md 记录；未推送未发布，未触碰发布链路文件。若截断部分另有白名单或额外验收项，需补发后核对。
- 竞态为 Ubuntu 时序型，本机（macOS）原生未复现（未修复版本本地多轮未红）。正确性依据为代码级入队时机分析（recordLocalChange 同步入队）+ 体外受控交错实证（未修复 straddle 必现 overrides 丢失、drain 后存活）+ 修复后 6 轮（含 CPU 饱和）与 CI 同款默认并行全量绿。最终确认以远端 Ubuntu CI 复跑为准（未推送，待授权）。
