---
name: modelswap-sync
description: ModelSwap 多机同步——查看状态、测试连接、推送/拉取、云平台增删、同步码迁移与局域网配对。当用户要求配置同步、推送/拉取数据、测试连接、生成/导入同步码或配对设备时使用；仅查看密钥列表或同步概览用 modelswap 核心技能即可。
---

# 多机同步

## 命令面

```
modelswap sync status [--test]   # 查看状态；--test 顺带测试各平台连接（只读）
modelswap sync test [platform]   # 测试云平台连接，缺省测全部已启用（只读）
modelswap sync push              # 推送密钥与 Provider 配置到已启用平台（改远端）
modelswap sync pull              # 从云端拉取并合并，修改时间新者胜（改本地）
modelswap sync password          # 设置同步密码（跨机解密的根，多台机器必须一致）
modelswap sync enable <platform> # 配置并启用云平台（supabase/cloudflare-kv/webdav/…）
modelswap sync disable <platform># 停用平台（保留配置）
modelswap sync export            # 生成一次性同步码（含平台配置，密码加密）
modelswap sync import            # 导入同步码，一键迁移云平台配置
modelswap sync pair --create     # 局域网配对：生成配对码（5 分钟有效、单次）
modelswap sync pair --code <码>  # 局域网配对：加入对方（成为接收方）
```

`modelswap vault push` / `vault pull` 是 `sync push` / `pull` 的等价别名。`vault test` 不存在——测试连接用 `sync test`。

## 只读与变更的边界

- 只读（可直接执行）：`status`、`status --test`、`test`。
- 变更远端：`push`。变更本地：`pull`（远端同名条目按修改时间较新者覆盖本地）。改变配置：`enable`/`disable`/`password`。消耗一次性凭据：`pair --code`（配对码 5 分钟过期、单次使用，失败后需对方重新生成）。

仅凭「看一下同步状态」之类的话不要执行变更类命令——先做只读检查，报告结果，获得用户明确授权后再执行。

## 执行提醒

- `push` 前：加密后的 Vault 数据（密钥与 Provider 配置）将上传到远端存储。
- `pull` 前：远端条目会按修改时间合并进本地，可能覆盖同名条目。
- `pair --code` 前：加入后本机将以对方为同步源；确认用户接受当前本地配置被对端状态合并。
- 局域网配对失败排查顺序：先 `curl http://<ip>:<port>/ping`（401=对端存活）确认网络可达，再确认配对码是否过期/已被重新生成（最常见原因），最后确认两台机器同步密码一致。
