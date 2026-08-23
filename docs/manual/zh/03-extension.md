# 3. 浏览器扩展配置（自动创建密钥的前提）

扩展 **OKIT**（MV3）复用 Chrome 已登录的平台会话，在官方控制台里替你点表单、创建 Key、复制并回填到 OKIT 加密库——全程只在你的浏览器和本机之间进行。

## 3.1 获取扩展

**npm / 脚本安装的用户**：无需自己构建。运行下面的命令拿到扩展目录（二进制安装会自动把扩展物化到 `~/.okit/extension`），然后直接按 3.2 加载该目录即可：

```bash
okit extension path    # 输出可直接加载的扩展目录
```

**从源码构建的用户**：仓库里的扩展源码在 `extension/`，需要先构建出 `dist/` 目录：

```bash
cd extension
npm install
npm run build        # tsc 编译 → extension/dist/
```

## 3.2 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 右上角开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `manifest.json` 所在的**扩展根目录**——npm / 脚本安装的用户选 `okit extension path` 的输出，源码用户选仓库的 `extension/` 目录（构建出 `dist/` 之后）。注意不是其中的 `dist` 子目录。

加载成功后扩展列表会出现 "OKIT"。

## 3.3 确认连接

1. 启动 OKIT（`okit web`）
2. 扩展会依次探测 3780–3785 端口，锁定第一个应答的 OKIT 服务并通过 WebSocket 连接（连接前需通过一次性令牌认证）——OKIT 因端口占用落到 3781 等端口时扩展照常工作
3. OKIT 启动日志出现 `[WS] Extension hello: v2.x.x protocol=...` 即连接成功
4. 也可以在控制台**密钥管理 → 自动创建**入口查看扩展状态

## 3.4 权限说明（重要）

扩展申请了 `debugger`、`tabs`、`cookies` 等权限，因此 Chrome 顶部会显示**"OKIT 已开始调试此浏览器"**的信息条——**这是正常现象**：扩展需要 debugger 通道读取页面内容与执行点击。调试只发生在本机 OKIT 与你的浏览器之间，不会向任何外部服务器发送数据。

## 3.5 更新扩展

- 扩展代码更新后：重新 `npm run build`，再到 `chrome://extensions/` 点扩展卡片上的 🔄 刷新
- 若 `manifest.json` 的 `permissions` 有改动：必须**移除扩展 → 重新加载已解压的扩展程序**，仅刷新无效
