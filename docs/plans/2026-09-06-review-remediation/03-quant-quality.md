# 03 量化数据质量与页面刷新

覆盖 F5 的观测/展示部分；撮合控制由 08 实施。依赖 01。

## 1. 控制目标
让用户明确数据来源、统计范围、报价时间及刷新结果；后台更新能够到达已打开的页面。

## 2. 被控对象
Python dashboard、Next 聚合缓存、浏览器快照与信号质量标识。

## 3. 观测输入
启动预热曾返回 watchlist_fallback、涨 1/跌 0/温度 100，之后恢复 full_market、温度 46。周日周五报价正常；账户 updated_at 是状态变更时间。

## 4. 状态模型
统一 QualityEnvelope：provider、detail、scope、observedAt、fetchedAt、generatedAt、expiresAt、refreshing、lastRefreshError、warnings、qualityStatus。scope 至少 full_market/watchlist/sample/unknown；qualityStatus 区分 ready/degraded/stale/unavailable。现有字段通过 Adapter 兼容。
行情另有 exchange、quoteSessionDate、calendarVersion；账户 stateChangedAt 独立保留。缓存 fetchedAt 变新不能把原始 observedAt 改成现在。

## 5. 控制器/角色
行情 Module 提供质量事实；投影 Module 决定显示；08 的动作门禁决定能否撮合。沿用现有数据源分层，不新增另一个抓行情体系。

## 6. 控制动作与工具矩阵
刷新按资源键合并 in-flight，请求失败保留最后成功数据并显式降级。复用已安装 SWR，页面可见时按服务给出的刷新进度和 TTL 重验证；候选策略：refreshing 时 2 秒、一般 15 秒、失败退避至 60 秒，离开页面停止高频轮询。后台完成后页面须自动收到新快照，不要求用户手工 reload。

## 7. 边界与审核
刷新不下单、不改自选股。统计范围不足不输出全市场判断；降级值可显示为“自选股范围参考”。未知数显示 —，保留有效 0。

## 8. 反馈与评价
记录缓存年龄、观测年龄、刷新耗时、降级原因；目标：隔离环境中后台完成后可见页面 5 秒内更新，前提为 refreshing 阶段。一般 TTL 更新目标另记录，不能混成固定实时承诺。

## 9. 异常、扰动和降级
覆盖进程离线、源超时、只剩历史缓存、部分市场数据、时钟偏差。正常非交易时段显示最近交易日行情；交易日历未知则可展示历史参考，动作不能据此放行。

## 10. 页面可观测性
分开“来源在线”“报价时间”“全市场/自选股范围”“缓存刷新失败”；错误独立于数据存在与否显示。更新时间必须注明是行情观测、抓取还是账户变更。

## 11. 数据模型与文件修改顺序
1. D:/zhiyu/tools/quant-service/app/provider.py、app/main.py：规范现有 quality 元数据。
2. D:/zhiyu/apps/web/lib/quant/direct-snapshot.ts 及量化 page-state 聚合：逐层保留质量与原始时间，按资源合并错误。
3. D:/zhiyu/apps/web/app/(chat)/quant/page.tsx：接入统一重验证和范围提示。
4. D:/zhiyu/apps/web/lib/markets/a-share-trading-calendar.ts：与 08 约定可版本化交易日事实输入；不在 TS/Python 分别写两份规则。
5. 缓存 schemaVersion 升级；旧缓存缺元数据时 unknown，不能默认 fresh。

## 12. 测试与验收
| 编号 | 场景 | 必须结果 |
|---|---|---|
| T03-1 | watchlist_fallback 仅 1 股 | 不显示为全市场温度；warning 可见 |
| T03-2 | 后台预热完成 | 已打开页面自动更新至 full_market |
| T03-3 | 旧缓存 + 依赖离线 | 历史可读，错误可见，非“实时正常” |
| T03-4 | 周日周五报价、账户无变更 | 不误报离线；明确报价日期 |
| T03-5 | unknown/0、时钟偏差、部分成功 | 不互相替换，不伪造观测时间 |
| T03-6 | 多组件并发刷新、卸载 | 同键合并、旧响应不覆盖新结果、无失控轮询 |

时间与提供方用 fixture；生产 smoke 只验证展示和刷新，不制造真实源故障。

## 13. 分阶段落地与回退
先元数据贯通，再展示，再自动刷新。旧客户端保留原字段；缓存版本升级可丢缓存重建，不能清空模拟账户。轮询出现负载异常时降低频率并保留手动刷新和质量提示。

