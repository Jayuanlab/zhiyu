# G1 PostgreSQL Adapter

这是独立记录接入的存储实现；没有知语表或全局连接依赖。宿主提供 postgres.js 连接及事务授权回调。回调必须基于真实身份，在同一事务中锁定/检查所属项目的有效授权，失败时拒绝。

在独立项目数据库中显式调用 `initializeObservationSchema(sql)` 建立四张 `general_memory_*_g1` 表和原文禁止 UPDATE/DELETE 的触发器。它需要数据库建表权限；不能把不可信请求变成初始化入口。上线需使用已验收的 schema 版本，IF NOT EXISTS 不代替任意旧表的迁移兼容检查。

Adapter 在命令和来源两种键上使用事务锁，命令唯一键包含 tenant/project/principal/command，来源唯一键包含 tenant/project/source/externalId/sourceVersion。原始记录读取使用 FOR SHARE，记录与回执在同一事务提交。只提供追加与读取，不提供物理删除或业务状态更新。

知语使用 `apps/web/lib/memory-zhiyu/observations.ts` 适配已有表；不会在日常库自动建立通用表，也不会将其他项目写入尚未加入 project 列的旧表。通用接入初期使用独立数据库，独立 Adapter 的 namespace 检查不能被解释成知语旧库已完成多项目共享改造。
