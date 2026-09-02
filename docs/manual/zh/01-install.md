# 1. 安装与启动

## 1.1 安装

**NPM 安装（推荐）：**

```bash
npm install -g modelswap
```

**从源码构建：**

```bash
git clone https://github.com/Cing-self/modelswap.git
cd modelswap
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

### 桌面版提示"已损坏，无法打开"？

macOS 对"浏览器下载 + 未签名"的应用会显示这个误导性提示——应用没有坏。解除（只需一次）：

```bash
xattr -dr com.apple.quarantine /Applications/ModelSwap.app
```

或系统设置 → 隐私与安全性 → 底部"仍要打开"。这是缺少 Apple 开发者签名导致的已知体验问题，签名已在规划中。

## 1.2 启动 Web 控制台

```bash
modelswap web              # 默认 3780 端口
modelswap web -p 3800      # 指定端口
modelswap web -o           # 启动后自动打开浏览器
```

Web 控制台默认运行在 **http://localhost:3780**。如果 3780 被占用会自动尝试 3781、3782……启动日志会打印实际地址。

> 💡 浏览器扩展会自动探测 ModelSwap 的端口（从 3780 起逐个尝试），正常情况下无需关心端口。

## 1.3 升级与卸载

```bash
modelswap upgrade          # 升级到最新版（npm 安装的用户）
npm uninstall -g modelswap   # 卸载
```

> ModelSwap 不常驻后台、不在请求路径上：写完配置就退出，Agent 直连模型平台。卸载后 Agent 配置照常工作。

> ⚠️ **卸载 CLI 不影响桌面版**（桌面应用完全自包含）。但 `~/.modelswap` 是 CLI 与桌面版**共享的数据目录**（密钥库、Provider 配置、快照）——如果你手动执行"完全卸载"（`rm -rf ~/.modelswap`），桌面版的数据也会被一起清空。只想卸载 CLI 时，`npm uninstall -g` 就够了，不要删 `~/.modelswap`。

## 1.4 桌面版更新

桌面版会在启动后检查更新，并在运行期间定期刷新。也可以从应用菜单选择**检查更新…**，或前往**设置 → 关于与诊断 → 检查更新**手动检查。

发现新版本后，桌面窗口左上角会出现下载图标。将指针移到图标上即可查看本次更新说明；点击图标下载更新包。下载完成后，ModelSwap 会自动安装更新并重新打开，无需再点击“重启安装”。

> 建议将桌面应用安装在 `/Applications/ModelSwap.app`。自动更新会安全地替换这个应用副本；更新失败时，左上角图标会保留，可再次点击重试。
