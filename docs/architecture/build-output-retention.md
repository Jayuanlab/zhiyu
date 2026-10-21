# 构建产物保留规则

桌面 Windows 工作区总共保留最近两套构建产物，正在运行的日常实例也占用名额。构建前申请名额；构建或验收完成、失败后再次收敛。若两个名额都被运行进程、活动租约或锁保护，新构建明确失败，不停止已有实例。

入口：

- `pnpm build` / `pnpm --filter web build`：`apps/web/scripts/build-with-retention.mjs`。
- 独立 review：`apps/web/scripts/build-review.mjs`。
- Windows 发行：`scripts/windows/build-release.mjs`。
- Memory 隔离验收：`memory-module-t1-isolated.mjs` 的 HTTP 生命周期外层，覆盖新构建、开发服务和已验收产物启动。
- 手工检查：`pnpm build:retention:inventory`；执行保留策略：`pnpm build:retention`。

`scripts/build-retention.mjs` 提供 `reserveBuildOutput` 和 `withBuildRetention`。`outputPath` 是一个已知生成目录；发行脚本可用固定的 `outputPaths: [next-windows-distribution, windows-installer]` 登记同一发行构建的两种投影，其他任意目录组合不合并。后来的单路径预约会使旧多投影关联失效，旧 installer 不能靠历史分组继续占用同一名额。发行父目录内历史 payload、旧版本与 previous/archived 备份分别处理，不能隐藏在同一父目录里无限保留。

发行入口同时声明 `currentPayload`，只接受 installer 直系版本化 payload；已经存在的准备目录必须有同版本 Zhiyu manifest 或当前构建 owner marker。预先复制的 components stage 不会因旧 owner marker 仍指向 base 而被删除。预约回执记录 preparation 的当前 stage、已有投影和名额语义；准备阶段占用当前发行的一套名额，完成或失败后清掉历史 payload，不把临时准备目录伪装成额外永久档案。

安全执行器为 PowerShell 7 的 `scripts/windows/build-retention.ps1`。只允许工作区的 `.next`、review 输出和明确 Windows 发行目录，以及有项目 owner marker、prepare 回执、精确路径匹配的项目专用外部目标。解析每级 junction，按实际目标去重；删除前再次核对目标和生成标记，拒绝数据库目录。子链接先单独解除，不递归进入未知链接。递归删除只使用 PowerShell `Remove-Item -LiteralPath`。

每次操作记录在 `.runtime/build-retention/operations`；租约记录在 `leases`，包含进程启动时间以防 PID 重用。清理前把日志、trace、BUILD_ID、发行 manifest、delivery、验收和回执文件复制到 `retirements` 并核对 SHA-256。旧验收成功记录不修改，retirement 记录说明产物何时被回收。`.runtime` 中原始验收日志、截图、证据目录，以及 vendor/toolchain、个人文件和数据库不属于清理目标。

当前自动保护覆盖已登记的进程链、可追溯的旧日常启动器、已知输出中的运行程序，以及构建/配置锁。无法识别的项目 Next 进程会阻断清理。手工绕过上述构建入口的历史脚本没有自动租约，仍需先用库存命令确认；任意外部进程和操作系统级对抗性文件系统修改不宣称由本模块完全隔离。

非 Windows 主机保留既有构建行为并显式输出 `build_retention_not_enforced`；当前没有跨平台删除已验证的承诺。

验证：`node --test scripts/build-retention.test.mjs` 在 Windows 上执行真实合成目录、租约、链接、故障与日志归档测试，不运行 Next、数据库或真实模型。
