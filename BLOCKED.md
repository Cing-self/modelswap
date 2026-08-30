无（后端与 SSE 链路全部有直接测试）。

边界记录（非阻断）：
- useAppUpdate 的"SSE 事件→check()"与"visibilitychange→check()"两条 wiring 无法在现有 node 测试环境直接挂载验证（无 DOM/jsdom；任务禁止新增依赖，故不引入 @testing-library/react 或 jsdom）。替代证据：
  1) tests/web/ui-events.test.ts：'update-available' section 经 SSE 原样送达订阅者（后端半链路端到端）；
  2) tests/frontend/useAppUpdate.policy.test.ts：聚焦复查的 5 分钟冷却纯策略（含边界）；
  3) 前端 wiring 为三行：useDataChanged(['update-available'], () => check(true)) 与 visibilitychange 监听调用同一 shouldCheckOnFocus——与生产其他消费者使用的同一 hook 模式。
- GitHub releases/latest 的传播延迟不可控（任务书已声明）：验收解释为"服务正常且 latest 已更新后，下一轮内收敛"，由 fake-timer 测试的固定间隔语义保证。
