# Release Notes 写作规范

这里的 JSON 会同时渲染到三处：应用内更新弹框、GitHub Release 正文、发版流水线校验。
读者是**用户**，不是开发者。

## 三条铁律

1. **只写"做了什么"**。一条 highlight = 一句话说清一个用户可感知的变化。
2. **不写"为什么"**（背景、动机、踩坑过程）——那是 PR 描述和设计文档的事。
3. **不写"怎么干"**（实现方式、模块/文件名、命令行、内部术语、代码概念）——那是 git commit 的事。

## 文案标准

- 用用户看得懂的词：「密钥」不是「vault entry」，「模型列表」不是「models cache」，「界面」不是「frontend」。
- summary 一两句话，概括这个版本最重要的变化；highlights 每条一个变化，3-6 条。
- 中英文独立通顺，英文不是中文的逐字直译。
- 有数字就给数字（「从 33 个精简到 31 个」），但只给用户能对上的数字。

## 对比例子（v1.0.57 实例）

❌ 改前（技术视角，解释动机和实现）：
> Cloudflare（需先手动持有 parent token，对新用户是先有鸡还是先有蛋）与 Google AI Studio（gcloud 安装+登录的前置成本高……）……服务代码保留便于日后恢复。

✅ 改后（用户视角，只说做了什么）：
> 自动创建列表移除了 Cloudflare 和 Google AI Studio 两个入口，保留 31 个一键创建的平台。

## 格式

```json
{
  "version": "vX.Y.Z",
  "publishedAt": "YYYY-MM-DD",
  "summary": { "zh": "…", "en": "…" },
  "highlights": [
    { "category": "new|improved|fixed", "zh": "…", "en": "…" }
  ]
}
```

校验：`node .github/scripts/release-notes.js validate vX.Y.Z`
