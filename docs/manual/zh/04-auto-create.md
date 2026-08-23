# 4. 自动创建密钥

![自动创建入口](../images/auto-create.png)

## 4.1 前提

- 已按第 3 章装好扩展并确认连接
- **Chrome 已登录目标平台**（自动创建复用你的登录会话）

## 4.2 操作流程

1. 控制台 → **密钥管理** → **自动创建**
2. 选择平台（当前支持 31 个，见下表）
3. OKIT 会打开浏览器窗口，自动进入该平台的 API Key 页面，填名称、点创建、复制新 Key
4. Key 自动写入本地加密库（AES-256-GCM），全程不落明文

## 4.3 支持的平台

| 分类 | 平台 |
|------|------|
| 国际 | OpenAI、Anthropic、Cloudflare、xAI (Grok)、Mistral、OpenRouter |
| 智谱系 | 智谱 AI（国内站）、Z.AI（国际站） |
| 火山引擎 | 火山引擎、火山引擎 Agent Plan |
| 腾讯云 | 腾讯云、腾讯云 Token Plan |
| MiniMax | MiniMax 国内/国际站、MiniMax Token Plan 国内/国际 |
| 月之暗面 | Moonshot、Moonshot Coding Plan、Kimi 国内站、Kimi 国际站 |
| 阿里云 | 阿里云百炼、百炼 Coding Plan、百炼 Token Plan |
| 百度 | 百度千帆、千帆 Token Plan |
| 其他 | DeepSeek、硅基流动、小米 MiMo（及 Token Plan）、阶跃星辰、OpenCode Go |

## 4.4 特殊情况

- **火山引擎**：创建过程中平台可能弹出安全验证或短信验证码，需要你手动完成验证，之后扩展继续接管（半自动）
- **Z.AI / 百度千帆 Token Plan**：依赖列表页的"复制"控件读取明文；个别情况下控件不返回明文，OKIT 会明确提示**停止写入并要求手动复制**——宁可不存，也不把掩码存进库
- **Anthropic**：创建后需要保持浏览器在前台，扩展通过"复制"按钮读取 Key
