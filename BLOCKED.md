无（两个 QA P0 均已修复并有先红后绿的确定性回归测试）。

真实未覆盖边界（非阻断）：
- useAppUpdate 的"SSE 事件→check()"与"visibilitychange→check()"两条 wiring 本身仍无法在现有 node 测试环境挂载验证（无 DOM/jsdom，任务禁新增依赖）。P0-2 的状态语义已通过导出的 beginUpdateCheck/failUpdateCheck 纯函数确定性覆盖；wiring 为对这两个函数的三行调用，与生产其他消费者使用的 useDataChanged 同一模式。
- check() 失败路径的 await 返回值恒为 error 状态（诊断真实）；仅显式路径消费该返回值（菜单 toast），silent 路径忽略返回值——状态保护完全由纯函数经 setUpdate 保证。
- GitHub releases/latest 传播延迟不可控：收敛保证 = "服务正常且 latest 已更新后，下一轮内"，由 fake-timer 固定间隔语义承载。
