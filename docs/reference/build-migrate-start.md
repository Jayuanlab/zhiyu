# 构建、迁移与启动

从仓库根目录执行以下命令。构建生成代码产物，迁移修改目标数据库，启动运行服务；三者分别执行并分别检查退出状态。

| 命令 | 职责 |
|---|---|
| `pnpm build` | 构建共享包与 Web，使用 webpack；不调用数据库迁移 |
| `pnpm --filter web build:ci` / `build:turbo` | 构建共享包与 Web，使用 Next 默认构建器；不调用数据库迁移 |
| `pnpm db:migrate` | 显式执行 PostgreSQL 迁移；必须配置 `POSTGRES_URL`，缺失或执行失败退出非零 |
| `pnpm build:with-migrations` | 显式组合入口：先迁移再构建；任一步失败即停止，构建失败不会回滚已成功的迁移 |
| `pnpm dev` | 启动本机依赖与开发模式应用，用于日常修改和页面回测 |
| `pnpm start` | 启动本机依赖与生产应用；使用已有构建产物，不替代构建或迁移验收 |

迁移命令在 `apps/web` 中执行，读取该目录 `.env`，进程环境中的 `POSTGRES_URL` 优先。执行前核实目标环境及备份；不要把测试库地址替换成日常库后直接复用故障注入脚本。升级已有数据库应先保存备份、确认迁移版本，迁移后核验 journal 和关键数据，再切换应用。迁移失败保留状态并诊断，不盲目删除 journal 或重建库。

默认构建入口从 12H 起不再隐式迁移。依赖旧一键行为的部署脚本应改为显式迁移步骤，或使用名称明确的 `build:with-migrations`。编译本身仍可能加载环境与执行静态生成；“不调用迁移”不等于“构建不访问任何服务”。验证构建必须使用隔离数据库和独立输出目录。

## 隔离回测

在 `apps/web` 执行：

```text
node scripts/test-isolated-migrations.mjs --build-migration-separation --record-prefix=12H-migration
```

脚本创建临时库，验证空库升级、重复迁移、显式迁移入口、缺配置失败和表结构覆盖，最后清理临时库。`--verify-production-build` 另外运行独立候选构建 69，记录编译前后迁移 journal 与测试数据是否保持；不要在另一个进程使用同一候选目录时运行。

生产构建成功仅是编译门槛；服务冷启动、worker、量化/微信边界、迁移恢复和用户路径须按整改台账继续完成组合验收。
