# 1. 安装与启动

## 1.1 安装

**NPM 安装（推荐）：**

```bash
npm install -g @cing-self/okit-cli
```

**脚本安装：**

```bash
curl -fsSL https://raw.githubusercontent.com/Cing-self/okit/refs/heads/main/install.sh | bash
```

**从源码构建：**

```bash
git clone https://github.com/Cing-self/okit.git
cd okit
npm ci --ignore-scripts
npm run build
node dist/main.js web
```

## 1.2 启动 Web 控制台

```bash
okit web              # 默认 3780 端口
okit web -p 3800      # 指定端口
okit web -o           # 启动后自动打开浏览器
```

Web 控制台默认运行在 **http://localhost:3780**。如果 3780 被占用会自动尝试 3781、3782……启动日志会打印实际地址。

> 💡 浏览器扩展会自动探测 OKIT 的端口（从 3780 起逐个尝试），正常情况下无需关心端口。

## 1.3 升级与卸载

```bash
okit upgrade          # 升级到最新版（npm 安装的用户）
npm uninstall -g @cing-self/okit-cli   # 卸载
```

> OKIT 不常驻后台、不在请求路径上：写完配置就退出，Agent 直连模型平台。卸载后 Agent 配置照常工作。
