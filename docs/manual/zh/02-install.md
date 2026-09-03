# 2. 安装与启动

推荐**桌面版**：图形界面、内置浏览器扩展，开箱即用；习惯命令行的用户可选 CLI。两者共享同一数据目录 `~/.modelswap`，二选一即可。

## 2.1 安装桌面版（目前仅 macOS）

桌面版目前**仅支持 macOS**（Apple Silicon 与 Intel）；Windows / Linux 用户请安装 CLI（见 2.2）。

从 GitHub Release 下载对应 dmg，拖入「应用程序」并打开：

| 版本 | 下载 | SHA-256 |
|------|------|---------|
| Apple Silicon（M1/M2/M3/M4+） | [ModelSwap-1.0.57-arm64.dmg](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-arm64.dmg) | [sha256](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-arm64.dmg.sha256) |
| Intel | [ModelSwap-1.0.57-x64.dmg](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-x64.dmg) | [sha256](https://github.com/Cing-self/modelswap/releases/download/v1.0.57/ModelSwap-1.0.57-x64.dmg.sha256) |

更新版本：[全部 Release](https://github.com/Cing-self/modelswap/releases)。桌面版装好后会自动更新（见 2.3），dmg 主要在首次安装时用到。

**macOS 拦截首次启动？**

如果提示"无法打开"（文案因系统而异，如"已损坏"或"来自未识别的开发者"）——应用没问题，只是 macOS 还没验证它。放行一次：

1. 打开 **系统设置 → 隐私与安全性**
2. 点击底部的 **仍要打开**

打开即用：桌面版启动后会自建服务（http://127.0.0.1:3780）并显示控制台窗口；浏览器扩展也内置其中（**设置 → 浏览器插件 → 打开扩展目录**）。

> 💡 浏览器扩展会自动探测 ModelSwap 的端口（从 3780 起逐个尝试），正常情况下无需关心端口。

## 2.2 安装 CLI

两种方式：

- **npm：**

  ```bash
  npm install -g modelswap
  modelswap web        # 自检：打开 http://localhost:3780
  ```

- **从源码构建：**

  ```bash
  git clone https://github.com/Cing-self/modelswap.git
  cd modelswap
  npm ci --ignore-scripts
  npm run build
  node dist/main.js web
  ```

CLI 内置 Web 管理台与 Agent Skill，支持全部三个平台。`modelswap web` 默认占用 3780 端口，被占用时自动递增；`-p` 指定端口，`-o` 启动后自动打开浏览器。

## 2.3 升级与更新：CLI vs 桌面版

**CLI（npm 安装的用户）：**

```bash
modelswap upgrade          # 升级到最新版
```

**桌面版：** 启动后自动检查更新，运行期间定期刷新。发现新版本时，窗口左上角出现下载图标——悬停可查看更新说明，点击下载后自动安装并重新打开（无需手动点"重启安装"）。手动检查：应用菜单 → **检查更新…**，或 **设置 → 关于与诊断 → 检查更新**。

> 建议安装在 `/Applications/ModelSwap.app`，自动更新会安全替换该副本；更新失败时左上角图标会保留，可再次点击重试。

## 2.4 卸载

- **只卸 CLI：** `npm uninstall -g modelswap`
- **只卸桌面版：** 把 `/Applications/ModelSwap.app` 拖入废纸篓

> ⚠️ CLI 与桌面版**共享** `~/.modelswap`（密钥库、Provider 配置、快照）——删掉它会把桌面版的数据一起清空。只移除其中一种形态时，别动 `~/.modelswap`。
>
> ModelSwap 不常驻后台、不在请求路径上：写完配置就退出，Agent 直连模型平台。卸载后 Agent 配置照常工作。

装好了？接下来花十分钟 [快速上手](03-quickstart.md)，完成第一次模型切换。如果安装过程中遇到问题，先看 [常见问题](15-faq.md)。
