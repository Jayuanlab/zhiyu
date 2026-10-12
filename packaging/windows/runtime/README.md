# Windows 本机运行管理器

本目录是安装包运行时，不依赖全局 Node、pnpm、Docker 或 Python。由安装目录内置的 Node 启动：

```text
vendor/node/node.exe runtime/manager.mjs --install-root <安装目录> --data-dir <独立用户数据目录> --open
```

默认数据目录为 `%LOCALAPPDATA%/Zhiyu/data`。管理器只接受带自身标记的目录或空目录，拒绝采用其他现有数据，拒绝安装目录与数据目录相互包含。首次写入前以 Windows ACL 只授权当前用户和 SYSTEM；凭据不写入安装目录、状态文件、浏览器响应或事件日志。

## 发布接口

必需文件：

- `vendor/node/node.exe`
- `vendor/postgres/bin/initdb.exe`、`pg_ctl.exe`、`postgres.exe` 及 PostgreSQL 的 DLL、share、lib
- `app/apps/web/server.js` 及 Next standalone 的依赖与静态资源
- `worker/start-runtime-worker.mjs` 及外置依赖
- `migrations/migrate.mjs` 及迁移 SQL、journal
- `release-manifest.json`，含 `version` 和 `nextBuildId`
- 本目录全部运行文件，包含 `security.mjs`、`web-host.mjs`、`setup.html`、`setup.js`

worker 必须保留 IPC `runtime_ready`、`stop`、`pause`、`resume`，支持 `--status` 返回真实数据库运行租约。`ZHIYU_RUNTIME_START_PAUSED=1` 时，第一次 step 前即暂停，仍报告 ready。安装版通过 `ZHIYU_OPTIONAL_QUANT_ENABLED=false` 排除尚未安装的模拟盘调度模块。

迁移进程接收 `POSTGRES_URL` / `DATABASE_URL`（私有 `zhiyu` 库）、`ZHIYU_BOOTSTRAP_DB_URL`（同实例 `postgres` 库）和 `ZHIYU_BOOTSTRAP_OWNER_ID`；迁移应幂等创建数据库、启用随包提供的 vector 扩展并创建独立 User。只有成功退出才写入已迁移指纹。失败仅报告稳定阶段代码与受限 SQLSTATE，管理器将其写入状态和事件，不输出驱动原始消息或 SQL。

## 状态与审核

`runtime/state.json` 为可观察状态，包含 `schemaVersion`、`instanceId`、`pid`、`managerPort`、`status`、`webUrl`、`setupUrl`、`error`、`updatedAt` 和各组件状态。`runtime/control-token` 为私有控制令牌，与事件及状态分离。

管理 HTTP 只绑定 `127.0.0.1`；所有 API 都需令牌或 HttpOnly 同站 cookie，写操作同时要求精确 Origin 和 CSRF。托盘传 `X-Zhiyu-Token` 及 `Origin: http://127.0.0.1:<managerPort>` 即可，令牌 header 本身构成 CSRF 证明。

| 接口 | 行为 |
| --- | --- |
| GET `/api/status` | 当前实际状态，不回显凭据 |
| GET/POST `/api/session` | 生成本机管理会话；浏览器从 fragment 取令牌后立即清除地址栏 fragment |
| GET `/api/config` | 只返回地址、模型及 `hasApiKey` |
| POST `/api/config` | 保存主 OpenAI 兼容模型；服务地址改变时必须提供新密钥 |
| POST `/api/model-test` | 只读服务商模型列表，不发起付费生成 |
| POST `/api/start` | 准备私有数据库、迁移、启动 worker 和 Web |
| POST `/api/pause`、`/api/resume` | 持久用户意图，等待真实租约心跳确认 |
| POST `/api/stop` | 停止应用及私有数据库，管理页面仍可使用 |
| POST `/api/backup` | 经私有 pg_ctl 确认数据库停机后冷备份，恢复之前实际运行的应用；返回备份 `path` |
| POST `/api/open` | 打开本机管理页面 |
| POST `/api/shutdown` | 有活动启动或备份时拒绝；其他情况等待子进程和私有数据库关闭，再退出管理器 |

关闭管理器保留先前运行或暂停意图，下次打开可恢复；显式停止应用则下次不自动运行。任何未确认停止、失效心跳或模块错误都单独暴露，不将 PID 存活当作任务成功。

## 备份与恢复边界

备份在 `backups/<时间与随机标识>`，复制 `postgres`、`app-data`、`private`，成功后才生成 `backup.json`。备份包含凭据，使用与数据目录相同的用户权限保护，未做单独文件加密。符号链接仅保留链接，不复制外部目标。

已有数据库跨发布指纹启动，会在实际停机后、迁移前自动生成冷备份。停止不成功即禁止备份。迁移失败保留原始错误与备份，不自动回滚可能已经发生的数据变化。

恢复目前由维护者在停止所有组件后执行：保留故障目录，选择与备份 PostgreSQL major 及应用迁移版本相容的安装版本，再恢复冷副本。自动恢复向导、数据库跨 major 升级、安装包签名、真实模型生成与干净机器完整安装验收仍需独立完成，不能由本目录单测推定成功。

## 验证

```text
node --test packaging/windows/runtime/runtime.test.mjs
```

测试覆盖管理 HTTP 的令牌/Origin/CSRF、密钥脱敏及服务地址隔离、数据目录边界、首次配置状态、重复启动、显式失败、冷备份、孤儿数据库停机确认、拒绝复制运行中数据库、数据库真实心跳状态、初次暂停及 Web 子进程自己的监听确认。测试使用独立临时目录及私有模拟组件，不连接开发数据库。

`node scripts/windows/fresh-migration-smoke.mjs` 使用已准备的发行 PostgreSQL/Node 工具链，在系统 Temp 的独立私有目录中验证真实初始化、151 条迁移、vector 扩展、独立 owner 和二次迁移幂等。它保留报告及日志，最后确认私有数据库停机，不加载开发 `.env`，也不启动 Web。
