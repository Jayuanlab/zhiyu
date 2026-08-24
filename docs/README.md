# Zhiyu 技术文档

文档按用途分为四类。架构文档定义长期约束；计划文档描述具体升级路径；参考文档记录运行、存储和验收细节；归档文档只保留历史决策背景，不作为当前实现依据。

## 架构

- [`engineering-cybernetics-guiding-principles.md`](./architecture/engineering-cybernetics-guiding-principles.md)：项目工程控制论原则。
- [`zhiyu-control-architecture-contract.md`](./architecture/zhiyu-control-architecture-contract.md)：Chat、Work、Loop、记忆、工具与审核的控制架构契约。
- [`lightweight-core-capabilities-upgrade-plan.md`](./architecture/lightweight-core-capabilities-upgrade-plan.md)：底层能力的轻量化边界与演进顺序。

## 实施计划

- [`smart-agent-workshop-technical-plan.md`](./plans/smart-agent-workshop-technical-plan.md)：智能体车间与 YAML 创建/修改流程。
- [`workshop-work-architecture-plan.md`](./plans/workshop-work-architecture-plan.md)：Workshop 到可版本化 Work 的架构升级。
- [`work-runtime-tightening-plan.md`](./plans/work-runtime-tightening-plan.md)：运行时契约、状态和失败语义收紧。
- [`agentic-harness-evolution-upgrade-plan.md`](./plans/agentic-harness-evolution-upgrade-plan.md)：Harness 证据、评估、候选版本和审核发布。
- [`unified-memory-platform-architecture-plan.md`](./plans/unified-memory-platform-architecture-plan.md)：统一记忆平台、Brain 收口、写入准入和召回架构方案。
- [`wechat-interaction-memory-technical-plan.md`](./plans/wechat-interaction-memory-technical-plan.md)：微信原始观测到理解、任务与记忆的处理链路。
- [`quant-trend-following-foundation-plan.md`](./plans/quant-trend-following-foundation-plan.md)：量化趋势、规则、计划台账和模拟执行闭环。
- [`performance-runtime-plan.md`](./plans/performance-runtime-plan.md)：轻量首屏、懒加载和运行时性能方案。
- [`customer-experience-response-detailed-technical-plan.md`](./plans/customer-experience-response-detailed-technical-plan.md)：当前客户体验与响应速度改造的执行版详细技术方案，覆盖 page-state、慢源后台化、车间拆分、统一记忆、上下文治理、待处理闭环和验收门禁。
- [`platform-customer-experience-response-technical-plan.md`](./plans/platform-customer-experience-response-technical-plan.md)：平台客户体验、响应速度、page-state、快照缓存和智能体上下文治理的详细改造方案。
- [`platform-customer-experience-architecture-detailed-plan.md`](./plans/platform-customer-experience-architecture-detailed-plan.md)：平台客户体验、响应架构、统一记忆、待处理项和分阶段落地的总技术方案。
- [`platform-customer-experience-response-architecture-v2.md`](./plans/platform-customer-experience-response-architecture-v2.md)：客户体验与响应架构改造 V2，收拢页面响应、快照缓存、车间拆分、统一记忆 ContextPack、后台刷新和体验指标闭环。
- [`customer-experience-response-architecture-v3.md`](./plans/customer-experience-response-architecture-v3.md)：客户体验与平台响应架构 V3，面向页面快照、SSE 局部 patch、统一记忆 ContextPack、量化慢源后台化和体验指标闭环的可执行技术方案。
- [`customer-experience-response-architecture-v4.md`](./plans/customer-experience-response-architecture-v4.md)：客户体验与平台响应架构 V4，总结当前已落地基础，并给出页面响应、量化慢源、车间刷新、统一记忆、上下文治理、召回质量和验收门禁的长期详细方案。
- [`agent-context-cost-optimization-plan.md`](./plans/agent-context-cost-optimization-plan.md)：智能体上下文、模型路由和运行成本控制改造方案。

## 参考

- [`domain-glossary.md`](./reference/domain-glossary.md)：Work、Loop、Harness、记忆和演化相关术语。
- [`unified-memory-platform-manual.md`](./reference/unified-memory-platform-manual.md)：统一记忆平台长期说明书，定义记忆分类、需求上报、召回计划、去重、ContextPack 和维护规则。
- [`vector-backends.md`](./reference/vector-backends.md)：向量后端与召回配置。
- [`harness-evolution-local-acceptance.md`](./reference/harness-evolution-local-acceptance.md)：Harness 本地迁移验收记录。
- [`adr/0001-scope-memory-recall-policy.md`](./adr/0001-scope-memory-recall-policy.md)：记忆召回作用域策略 ADR。

## 归档

- [`loop-engineering-product-directions.md`](./archive/loop-engineering-product-directions.md)
- [`loop-runtime-roadmap.md`](./archive/loop-runtime-roadmap.md)
- [`quant-system-github-comparison.md`](./archive/quant-system-github-comparison.md)
- [`project-data-storage-inventory-2026-07-29.md`](./archive/project-data-storage-inventory-2026-07-29.md)：移除桌面端前的数据存储快照。

归档内容可能与当前 schema、命名或运行时不一致。实现判断以代码、迁移、测试、manifest 和架构文档为准。
