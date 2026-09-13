# 生产重启回测（2026-09-12）

## 结果

- 23:58 已切换到生产模式，地址 `http://127.0.0.1:3515`。
- 完整构建退出码 0；编译 2.9 分钟，TypeScript 检查 40 秒，148 个静态页面生成通过，构建追踪完成。
- 构建目录：`apps/web/.tmp/next-review-97`；BUILD_ID：`cperSYLLrx1JMjGFOLrzr`。
- 启动方式：在 `apps/web` 设置 `ZHIYU_REVIEW_BUILD=97`、`NODE_ENV=production`，运行 `node --import tsx scripts/start-managed-application.mjs start --port 3515`。后台启动使用隐藏窗口。
- 管理进程 44184，Web 子进程 32792，worker 子进程 56356；worker 实例 `ac99cf26-b69d-47e2-a0ee-9d64ad112554`。

## 构建耗时排查与处理

生产构建长时间停留在编译提示。CPU 采样显示实际热点为 Next 文件追踪器中的 glob、目录读取和路径匹配。运行时采样发现以下通配符会扫描历史构建目录：

- `D:\zhiyu\apps\web/**/*\local-cut-*\script.md`
- `D:\zhiyu\apps\web/**/*\.agents\skills`

处理：

1. 将视频运行时文件操作封装在 `lib/video/runtime-file-io.ts`，避免将动态输出路径推断为静态部署资产。中文文本写入读取、文件存在判断、缺失文件错误传递回测通过。
2. 尝试提前添加追踪排除规则仍无法阻止 NFT 内部 glob 展开，已撤回该尝试，没有保留对 Next 内部插件的修改。
3. 将 63 个未使用的 `next-review-NN` 构建目录完整移动至 `D:\zhiyu-build-cache\archive-20260912`。保留本次构建 97 和开发构建 98，未删除业务数据。未来可从归档路径找回历史构建；不应继续在扫描范围内无限积累构建产物。
4. 归档并重新启动构建后完整通过。此前中止的构建不计为成功；本次不是纯粹由代码封装单独带来的性能改善。

## 服务切换及验证

- 排查时临时修改 next.config 触发开发管理器退出（code 77），曾导致页面不可用；发现后恢复开发服务。
- 生产构建成功后，向开发管理器发送其已有 SIGTERM 处理事件，worker 正常停止：`settled=true`、`unsettled=[]`，管理器退出码 0。
- 隐藏窗口启动生产管理器，成功获得新 worker 租约。
- `/workshop`、`/api/runtime/status` 均 HTTP 200。
- runtime 状态：online=true、phase=running；8 个模块均 success、lastError=null。
- 浏览器实际打开生产车间，显示“后台在线 Web 在线”、7 个智能体；AI 知识博主审核列表第一项为“剪辑链路验收样片：流程展开与双栏对比”。
- 样片接口 `/api/douyin/drafts/editorial-preview-23ddf58666058e04/video` 支持 Range，返回 HTTP 206、video/mp4。
- 未触发视频上传、发布或新的整轮业务任务。本次验证范围为生产构建、服务启动、页面读取和已有视频预览链路。

本记录补充此前视频接入记录中“生产构建尚未通过”的状态；本次完整生产构建及启动验收已通过。
