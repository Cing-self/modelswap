# Agent–站点–模型切换矩阵（自动化）

## 目的与范围

这套测试替代手工逐个切换。夹具固定为当前已启用的 8 个 Agent、26 个 Agent–站点关系、72 个已选模型；不读取任何真实用户配置或密钥。

每个模型是一条可见的 Vitest 用例：先用完整模型列表保存站点，再切换到该模型。流程经过真实 `configureAgentProvider`、`switchProvider`、store 和 adapter，最终读取临时 HOME 下的 Agent 原生配置文件。

| Agent | 站点与模型 | 用例数 |
| --- | --- | ---: |
| Claude | opencode-zen: x-preview-f-free, hy3-free；kimi-coding-plan: kimi-for-coding, kimi-for-coding-highspeed, k3, k3-256k；moonshot: kimi-k2.7-code, kimi-k3, kimi-k2.6, moonshot-v1-32k, moonshot-v1-8k, kimi-k2.5, moonshot-v1-128k, kimi-k2.7-code-highspeed, moonshot-v1-auto；opencode-go: hy3, minimax-m2.7, ox-alpha-free；glm-coding: glm-5.3, glm-5.2, glm-5-turbo | 21 |
| ZCode | opencode-zen: deepseek-v4-flash-free, x-preview-f-free, hy3-free；xiaomi-coding: mimo-v2.5, mimo-v2.5-asr, mimo-v2.5-pro, mimo-v2.5-tts, mimo-v2.5-tts-voiceclone, mimo-v2.5-tts-voicedesign；qianfan-coding: glm-5.1, deepseek-v4-flash, qianfan-code-latest；deepseek: deepseek-v4-flash, deepseek-v4-pro；openrouter: stealth/ox-alpha, mistralai/voxtral-small-24b-2507 | 16 |
| OpenCode | xiaomi-coding: mimo-v2.5；deepseek: deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp；qianfan-coding: glm-5.2, ernie-5.1, deepseek-v4-pro | 7 |
| MiMo Code | qianfan-coding: ernie-5.1；opencode-zen: x-preview-f-free, hy3-free | 3 |
| Grok | opencode-zen: x-preview-f-free, hy3-free；opencode-go: hy3, deepseek-v4-flash, ox-alpha-free；qianfan-coding: glm-5.2；deepseek: deepseek-v4-flash | 7 |
| WorkBuddy | deepseek: deepseek-v4-flash-vision-exp, deepseek-v4-pro, deepseek-v4-flash；xiaomi-coding: mimo-v2.5-pro, mimo-v2.5 | 5 |
| Kimi Code | xiaomi-coding: mimo-v2.5-pro, mimo-v2.5；opencode-go: glm-5.3, deepseek-v4-flash, deepseek-v4-flash-vision-exp, ox-alpha-free | 6 |
| Codex | openai-codex: gpt-5.6-sol；opencode-go: ox-alpha-free, glm-5.1, glm-5.3；openrouter: deepseek/deepseek-v4-flash-vision-exp, deepseek/deepseek-v4-pro, ~deepseek/deepseek-v4-flash-latest | 7 |

另有一条反向用例：`kimi-code/deepseek` 保持 `enabled:false`，其 DeepSeek 站点路由绝不能被其他切换操作重新写入 Kimi Code 配置（同名模型可能同时属于另一个已启用站点，不能只按模型 ID 判断）。

## 每条切换的验收

1. 保存完整 `modelIds` 后调用单模型切换；响应必须成功。
2. `agentProviders[agent].sites[site].modelIds` 必须仍等于完整原选择，不能被缩成单模型或丢失站点。
3. 排他 Agent 的 `activeProviderId/activeModelId` 必须等于本用例；多站点 Agent 的全部已启用站点必须仍启用。
4. 用 `getAgentConfigFiles` 读取 adapter 实际写入的文件，必须包含路由后的 `remoteModelId`。这覆盖 Claude、Codex、OpenCode、ZCode、Kimi Code、Grok、WorkBuddy 与 MiMo Code 的不同原生格式。
5. 最终 `providers.json` 必须是 v2 且不含 `models`、`platforms`、`modelCache`；`models-cache.json` 必须是 v2；重新加载 store 后选择状态不变。

## 隔离与失败证据

- 每轮在 `mkdtemp` 创建的 HOME 内运行；夹具没有 API key。
- 预置 fresh 的空 models.dev 缓存，并将 `https.get` 设为失败：任何网络访问都会使测试失败。
- 不 mock API、store 或 adapter；只隔离 HOME 与网络。测试不读取/写入真实 `~/.okit`、`~/.codex`。
- 失败用例名直接给出 `agent / site / model`；结果含完整选择、当前选择、adapter 文件是否含路由模型、多站点是否完整。

## 运行

```bash
npx vitest run tests/web/agent-provider-switch-matrix.test.ts
npm test -- --run
npm run build
git diff --check
```

不得用 `skip`/`todo`、mock adapter 或降低既有断言来通过测试。
