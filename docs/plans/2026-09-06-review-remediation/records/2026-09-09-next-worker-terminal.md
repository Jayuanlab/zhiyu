# 持续弹窗的实际来源与修复

前一阶段只枚举 `ConsoleWindowClass`，未覆盖默认终端宿主 Windows Terminal，不能据此认定没有弹窗。本次扩大窗口观测到 `CASCADIA_HOSTING_WINDOW_CLASS` / `PseudoConsoleWindow`，并关联进程父子链。

实际复现：3516 开发服务 PID 15992 创建短命 Node 子进程（捕获 PID 8412、780），命令为 `node.exe D:/zhiyu/node_modules/next/dist/compiled/jest-worker/processChild.js`；相关 Windows Terminal 窗口先显示、随后隐藏，约 30 秒重复。进程来自 Next 开发静态路径检查 worker，框架该 fork 路径没有 windowsHide。不是模拟撮合服务反复启停。

修复：新增 `apps/web/scripts/hidden-next-workers.mjs`，在本地开发服务加载 Next 之前安装仅匹配 Next 内置 Jest worker 路径的 fork 包装，设置 `windowsHide:true`，保留 args、环境、stdio、IPC 和其它选项，不修改 node_modules。只重启3516开发服务（新 PID27352），生产宿主和量化服务均保持运行。同时按精确窗口类和量化终端标题隐藏已存在的量化终端，不关闭服务。

回测：

- `node --test scripts/hidden-next-workers.test.mjs`：2/2 通过；两种 fork 签名、其它进程不受影响、真实 Next 内置 Jest worker IPC请求/响应及退出通过。
- 窗口与进程联合观察44.14秒，捕获13次开发服务子进程相关观测，新增可见 Windows Terminal 窗口0。证据 `2026-09-09-terminal-before.json`、`2026-09-09-terminal-after-summary.json`；详细修复后原始记录在 `apps/web/.tmp/terminal-trace.json`。
- 多轮实际工作详情页面及运行审核API返回200。
- 生产运行时在线，paper-matching最近成功、无错误。模拟账户现金985280.90元，515980.SH持仓10300、002716.SZ持仓400，未变化。

边界：本次证据覆盖复现的Next开发子进程弹窗，不宣称所有第三方程序未来均不会弹窗。
