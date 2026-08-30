# 目标
常开桌面端在 GitHub latest 传播后的下一个 15 分钟周期内静默显示更新徽章（SSE `update-available` + 前端静默复查 + 聚焦 5min 冷却复查）。

# 顺序
1. 后端 watcher：update-check.js 可启停/幂等/可注入（时间/请求/随机相位），server 监听成功后启动；15min 固定 setTimeout 自调度 unref；403/429 指数退避至 2h；网络失败仅 warn 保留旧数据；ETag/304 复用缓存；首刷建基线，仅"新 tag > 运行版本且相对已见 tag 变化"时 publishDataChanged(['update-available']) 恰一次。
2. 前端：DataSection 增 update-available；useAppUpdate 经 useDataChanged 触发 silent check(true)；visibilitychange visible 且距上次成功检查 >5min 静默查；失败不覆盖 available。
3. 证明：后端 fake-timers 红绿测试 + 前端可测证据（无 DOM 环境则以导出纯逻辑测试 + SSE 断言替代，必要时 BLOCKED.md 记录）。

# 最大风险
前端 hook 无法在现有 node 测试环境挂载（禁新增依赖）→ 事件→检查链路缺直接测试证据，用导出纯函数 + SSE section 端到端断言补偿。

# 基线（2026-08-30，de396cf）
809/810 pass；唯一失败 = publish-notes-gate 要求 v1.0.38 notes（任务书声明已知、禁改）。
