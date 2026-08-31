# extension-dist-sample — 真实扩展产物的快照夹具

`extension/dist/` 是 git 忽略的构建产物（CI checkout 上不存在），而
live-acceptance 的补丁测试需要一份稳定输入。本目录是真实
`npm run build-extension` 产物（manifest.json + dist/*.js）的逐字节快照。

同步方法（扩展产物变更后必须执行，否则锚点漂移测试会在本地报红）：

    cp extension/manifest.json tests/fixtures/extension-dist-sample/manifest.json
    cp extension/dist/*.js tests/fixtures/extension-dist-sample/dist/

`tests/provider-live-acceptance.test.ts` 用本夹具驱动补丁器；
当真实 `extension/dist/background.js` 存在（本地或构建环境）时，另有
锚点计数一致性断言捕捉“扩展改版后补丁锚点漂移”。
