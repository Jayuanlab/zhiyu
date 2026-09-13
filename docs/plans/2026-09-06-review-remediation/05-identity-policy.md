# 05 身份模式与动作边界

覆盖 F1 和工具策略一致性；依赖 01。共享部署前必须完成。

实施进度：本机边界和真实登录链路已通过回测；整包共享验收尚未完成。详见 [回测记录](records/2026-09-06-05.md)。当前主人仍使用历史 guest 资料，未擅自迁移其账号。共享资源隔离和 T05-6 全路径覆盖必须继续完成，不能把本机通过解释为可公开部署。

## 1. 控制目标
保留显式本机单主人体验；共享部署必须真实身份；任何写入口不能靠客户端 actor 或工具名称取得权限。

## 2. 被控对象
Next session、HTTP 写路由、MCP/native 调用、内部 Python 执行器、工具 registry。

## 3. 观测输入
生产无 Cookie session 有 user；dev-auth 无条件 true；模拟订单写路由缺少 auth。当前仅回环监听，不把风险说成已公开暴露。

## 4. 状态模型
拟定 AUTH_MODE=local_owner/authenticated：未配置按 authenticated 处理；现有本机启动配置显式选择 local_owner。身份上下文含 ownerId、actorId、actorType、workId、scope、authenticationMethod；客户端 actor 仅能作为不可信说明，不能成为审计身份。

## 5. 控制器/角色
身份 Module 提供可信主体；Work Runtime 执行资源所有权和策略。操盘交易员只消费当前自选股，自选股猎手维护池子；工具 registry 声明 risk/scope/approvalRequirement，同一声明驱动可见性和执行门禁。

## 6. 控制动作与工具矩阵
| 入口 | 主体来源 | 检查 |
|---|---|---|
| 本地浏览器 | 显式本机模式及受控 session | 回环部署、可信 Host/Origin、写请求 CSRF |
| 共享浏览器 | 真实登录 session | 身份、owner、资源作用域、CSRF |
| 本地脚本/worker | 范围受限的内部凭据 | actor 固定、命令 scope、审计 |
| Python 执行器 | Web/worker 内部凭据 | 仅回环监听、拒绝无凭据写入、策略透传校验 |

仅检查 Host 不足以识别来源，不信任客户端自填 X-Forwarded-*。浏览器写请求要求同源与 CSRF，缺 Origin 的脚本用内部凭据而非免检；拒绝跨站简单请求和宽泛 CORS。内部凭据不得进入 NEXT_PUBLIC 或日志。

## 7. 边界与审核
denied 优先于 allowed，审核通过也不能越过硬禁止。不能只修 middleware：领域命令 Interface 自身检查，所有 HTTP/MCP/native 调用汇入。免登录不等于免动作策略。

## 8. 反馈与评价
每次拒绝记录 commandId、reasonCode、策略版本和主体，不记录密钥。UI 说明被谁/哪条边界阻止。目标：跨用户读写与伪造主体全部拒绝。

## 9. 异常、扰动和降级
身份系统不可用拒绝写入，不静默切 local_owner。local_owner 与非回环绑定同时出现则启动失败。内部凭据失效显示执行器未授权，不回退匿名。

## 10. 页面可观测性
设置页展示“本机信任模式”或“登录模式”；审核页显示主体、目标与影响。配置切换通过现有配置流程记录，不新增自动开放网络动作。

## 11. 数据模型与文件修改顺序
1. D:/zhiyu/apps/web/lib/auth/dev-auth.ts、app/(auth)/auth.ts、proxy.ts：显式模式及主体解析。
2. D:/zhiyu/apps/web/lib/work-runtime/commands.ts、resources.ts：统一命令鉴权；盘点所有写路由形成受保护入口清单。
3. D:/zhiyu/apps/web/app/(chat)/api/quant/paper/orders/route.ts 等量化写入口：移除 actor 信任。
4. D:/zhiyu/apps/web/lib/agent-tools/registry.ts、lib/loops/tool-gate.ts、Work MCP/native Adapter：一致策略。
5. D:/zhiyu/tools/wechat-desktop-service/server.py、tools/quant-service/app/main.py：内部身份校验；启动脚本同步配置。
不在本包发明新的用户体系，优先恢复现有登录链路；若现有链路无法满足共享验收，则共享模式保持未验收。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T05-1 | authenticated 下匿名请求 | 无默认主人 session；写入拒绝 |
| T05-2 | local_owner 本地正常访问与伪造 Host/跨站 Origin | 正常体验保留；跨站写和非回环部署拒绝 |
| T05-3 | 伪造 actor、跨 owner/work | 被拒，审计主体不随 payload 改变 |
| T05-4 | 同时 allowed/denied、越角色工具 | denied 生效；可见性与执行一致 |
| T05-5 | 直连 Python 写入口、凭据失效 | 无内部凭据拒绝，无静默降级 |
| T05-6 | MCP/native/HTTP 等价动作 | 相同权限决策；新增路由遗漏由入口清单测试发现 |

全部写操作测试使用临时状态和 fake 外部 Adapter。

## 13. 分阶段落地与回退
先显式部署模式和入口清单，再领域鉴权，再 Python 内部凭据。回退身份版本时只允许回环隔离运行；不得恢复共享环境无条件 bypass。模式切换前验证已有用户能登录，防止误锁日常使用。
