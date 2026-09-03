# 15. 常见问题

**Q：扩展装好了但连不上？**
扩展会自动探测 ModelSwap 的端口（3780 起逐个尝试）。确认 ModelSwap 正在运行、扩展没有被 Chrome 停用；仍连不上时重启 ModelSwap 和扩展（`chrome://extensions/` 里关开一次）。

**Q：Chrome 顶部"正在调试此浏览器"的信息条能关吗？**
关闭它扩展即断开。这个信息条是 Chrome 对 debugger 权限的强制提示，属于正常现象，保持开启即可。

**Q：自动创建到一半停了？**
多数情况是平台弹出了验证（安全验证/短信）。手动完成验证后流程会继续；或重新发起自动创建。

**Q：密钥库里看不到完整 Key？**
密钥以 AES-256-GCM 加密存储，界面默认脱敏展示；需要明文时可在界面查看完整值，或用 `modelswap vault get <key>`。

**Q：3780 端口被占了？**
先找出占用进程再决定：`lsof -i :3780`。若是别的程序，关掉它或让 ModelSwap 换端口（扩展会自动探测后备端口）；若是残留的 ModelSwap 进程，kill 掉再启动。

**Q：安装 ModelSwap 会改我的 shell 配置吗？**
不会。没有任何功能会写你的 shell 配置。（`modelswap hook` 命令已在 v1.0.3 移除——它的配套功能"项目绑定注入"已先行删除。旧版本装过 hook 的用户：打开 `~/.zshrc` / `~/.bashrc`，删除 `# >>> modelswap-hook >>>` 到 `# <<< modelswap-hook <<<` 之间的整段即可彻底清理。）

**Q：多台机器同步，冲突了算谁的？**
按修改时间新者胜：本机较新的改动永不会被远端旧数据覆盖。自动同步开启时无需关心；手动场景先 `pull` 再改再 `push`。

**Q：切换模型后 Agent 里没生效？**
正在运行的 CLI 会话可能缓存了旧配置，重启该 Agent CLI 再试。仍不行时到 设置 → 配置历史 查看最近一次切换写入了什么，或直接恢复上一个快照。

**Q：换新电脑怎么迁移？**
1. 新机器安装 ModelSwap，启动 `modelswap web`
2. 设置 → 云备份：配置同一同步密码、启用与旧机相同的平台
3. 开启自动同步（或手动 `modelswap vault pull`），密钥与 Agent/Provider 配置会合并到新机

**Q：支持 Windows / Linux 吗？**
支持。ModelSwap 与扩展在 macOS、Linux、Windows 上均可运行。
