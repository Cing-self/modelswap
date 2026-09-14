---
name: modelswap-sync
description: ModelSwap Vault 云同步——push/pull/test 与已配置的远端存储交互。当用户要求推送、拉取 Vault 数据或测试云同步连接时使用；仅查看同步状态或密钥列表用 modelswap 核心技能即可。
---

# 云同步

`modelswap vault push`、`pull`、`test` 会接触已配置的外部存储。`push` 改变远端状态；`pull` 把远端 key 合并进本地 Vault。仅凭一句「看一下同步状态」不要执行它们——先只读检查（同步状态查询），获得用户明确授权后再执行。

推送前提醒用户：加密后的 Vault 数据会上传到远端存储；拉取前提醒：远端 key 会合并进本地 Vault，可能覆盖同名条目。
