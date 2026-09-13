# 求职类项目如何获取职位与招聘交互数据

> 研究日期：2026-09-12  
> 面向项目：Zhiyu / 求职运营官  
> 方法：只读检查公开仓库源码、项目 README、产品官方帮助文档、ATS 官方 API 文档与招聘平台协议；未运行任何第三方项目，未登录任何招聘账号。仓库链接尽量固定到本次检查的 commit。

## 结论

公开项目并不存在一种既稳定、覆盖 BOSS/LinkedIn、又可以无约束自动搜索和聊天的通用接口。它们实际采用五类数据入口：

1. **企业 ATS 的公开职位接口**：Greenhouse、Lever、Ashby 等面向企业公开职位页提供 JSON。无需求职者登录，结构稳定，最适合长期增量同步。
2. **招聘平台的匿名网页或内部接口**：例如 LinkedIn guest endpoint、Indeed/Glassdoor GraphQL、HiringCafe 的公开 SSR 页面。这类接口并非都面向第三方开放，限流、字段与页面结构会变化。
3. **登录浏览器自动化**：Selenium、Playwright 或 AI browser agent 读取 DOM、点击、填表并提交。它能接触登录后数据，但必须持有账号、Cookie 或浏览器 profile，维护和封号风险最高。
4. **浏览器扩展辅助**：扩展只在用户正在看的申请页读取表单 DOM，调用用户资料填充，再由用户检查和提交。覆盖面弱于后台爬虫，但人与动作边界更清楚。
5. **用户导入与邮件回执**：用户粘贴职位/聊天，或通过 Gmail OAuth 导入投递回执、拒信、面试邀请。这是获取“申请后状态”的可靠方式，不需要逆向招聘平台聊天接口。

对 Zhiyu 最合理的组合是：**公开 ATS/API 做持续发现，用户主动导入 BOSS 职位与聊天，浏览器内只做可见、可审核的辅助，邮件做结果反馈，所有阶段写入可追溯状态机。**

## 项目逐项核验

| 项目 | 职位数据入口 | 登录 / Cookie | 交互与投递 | 主要风险 | 对 Zhiyu 的启示 |
|---|---|---|---|---|---|
| JobSpy | LinkedIn 匿名 guest HTML、Indeed GraphQL、Glassdoor GraphQL/JSON 等站点适配器 | LinkedIn 适配器主动清 Cookie，不要求账号；支持代理 | 只聚合职位，不管理聊天或真正提交 | 非官方端点、429、选择器和响应结构变化；README 直接提示各站积极封禁 | 可参考统一职位 schema、provider adapter、并发和错误显式化；不要把平台逆向接口当稳定核心 |
| ScottCoffin/Job_Scraper | LinkedIn guest endpoint、HiringCafe SSR `__NEXT_DATA__`、JobSpy、政府站点/API | LinkedIn/HiringCafe 路径无需登录；部分 API 可选 key | 生成本地看板、去重、通知和人工工作状态，不自动聊天 | 匿名接口随时改变；GitHub Actions IP 易被限制；结果可能突然归零 | 借鉴增量窗口、上一轮结果保护、去重、source heartbeat 与通知；HiringCafe 只宜作为可替换源 |
| outscal/OpenJobs | 以公司 ATS URL 为 seed，调用 Greenhouse、Lever、Ashby、Workable 等适配器 | 公开职位 GET 通常无需求职者账号 | 对没有公开接口的 LinkedIn/Wellfound 明确输出 manual CSV | ATS slug 失效、厂商迁移、部分“公开接口”实际是页面内部接口 | 最适合作为 Zhiyu 的职位发现主干：公司目录 + ATS 适配器 + 手工回退 |
| OpenPostings | 80+ ATS 适配器同步；扩展让用户把当前企业职位板 URL 添加为 seed | 职位同步侧通常无需个人账号；本地 SQLite 保存申请人/MCP 设置 | MCP 选择候选、起草求职信、记录结果；外部浏览器工具负责真正打开和申请；默认支持 dry-run/最终批准 | ATS 数量多导致长期维护面很大；账号/MFA 交给浏览器工具仍有安全边界问题 | 借鉴“URL seed → 分类 → 同步”和候选/执行分层；Zhiyu 应把最终提交保持在人审边界内 |
| freehire | 直接抓企业 ATS/职业页并归一化；公开 API 提供搜索结果 | 发现职位不依赖求职者登录；Gmail 用 OAuth；扩展有单独会话令牌 | 浏览器扩展在当前表单上填充；申请看板保存阶段；Gmail/托管邮箱把招聘回复关联到申请 | 系统复杂，ATS DOM 仍会变化；邮箱含敏感个人数据；自动提交会遇到验证码与字段歧义 | 最值得借鉴其“发现、申请、邮件反馈、事件账本”闭环，以及邮箱证据只先生成候选、用户确认后关联 |
| AIHawk（原 Jobs Applier） | 当前版本已变成通用真实浏览器 agent，由模型读页面、点击、输入 | `--profile-dir` 持久化 Cookie 和登录；可带代理/浏览器身份 | 能执行浏览器中的表单动作；README 要求不要提交未经人工阅读的内容 | 当前仓库已移除第三方 provider 插件；浏览器 profile 权限高，页面注入、账号风控和站点改版风险高 | 可把它视为执行器而不是职位数据源；若接入 Zhiyu，必须限定域名、动作、资料字段、提交审批和审计 |
| NathanDuma/LinkedIn-Easy-Apply-Bot | 登录 LinkedIn 后用 Selenium 读取搜索结果 DOM | 配置文件直接保存邮箱和密码；自动登录；安全检查交给用户处理 | 点击 Easy Apply，逐页填写并点击最终 submit，CSV 记录成功/失败 | 明文凭据、陈旧 CSS class、宽泛异常吞噬、账号封禁；LinkedIn 明确禁止此类机器人/扩展 | 这是“能工作但不适合产品化”的反例；不要复制其凭据和全自动提交模式 |
| Simplify Copilot | 商业浏览器扩展读取用户当前打开的申请页；职位/申请详情来自当前页和 Simplify 账号 | 用户登录 Simplify；官方未公开扩展实现源码 | 填简历、常见/特有问题，多页连续填充；官方默认叙事仍强调用户检查并提交，提交后写 Job Tracker | 实现不可审计；支持站点、选择器和远程规则的变化由服务方控制；扩展拥有页面数据权限 | 产品交互值得借鉴：用户进入真实表单后再启动辅助，显示可填/未填项，最终由用户发送 |
| BossHunter | 连接用户已登录的可见 Chrome，通过 CDP/DOM 采集 BOSS，并把职位写入本地库 | 用户自己登录，复用当前 Chrome 会话 | AI 评分；BOSS 在人工确认后低频发送并监听回复；其他国内平台只读并人工回填 | 即使较克制，仍是第三方自动浏览/操作；BOSS 协议与账号风控风险存在；非商业许可证 | 可参考验证码/登录墙立即停、人工确认、限额、状态跟踪；不能直接复制或当官方接入 |
| 职位猎人 job-hunting | 浏览器扩展从当前 BOSS 页面 DOM、响应 JSON 和同源内部 `wapi` 读取职位，保存本地历史快照 | 复用用户当前浏览器 Cookie/登录态 | 重点做页面增强、历史与分析，不以自动投递为主 | DOM、响应结构、内部接口都会变化；README 禁止大规模采集 | 说明“当前页伴随式采集”能做出实用体验，但 Zhiyu 仍应优先让用户显式导入 |
| mcp-bosszp / boss-auto-apply | 模拟扫码登录或在已登录页面读取 Cookie/内部对象，调用 `wapi` 推荐、详情和沟通接口 | 后台维护 session，或复用页面 Cookie | MCP/油猴脚本可直接调用发起沟通接口 | 私有接口、Cookie、扫码会话与真实发送集中在一起，误发和封号风险最高 | 只作为工程现状与禁止模式的证据，不纳入产品主链路 |
| poboll/bosszhipin_spider | Pyppeteer 打开 BOSS 城市页、输入关键词、读取职位卡 DOM、翻页 | 可选浏览器 `user_data_dir`；遇安全验证要求用户在有头浏览器完成，不主动绕过 | 只采集职位并导出 Excel，不聊天、不投递 | 页面选择器频繁变化；仍属于第三方自动采集，和 BOSS 协议冲突；自动化特征会触发验证 | 只能作为技术现状证据，不适合作为 Zhiyu 正式 BOSS 接入方案 |
| jhcoco/bosszp | 旧版 Scrapy 请求城市接口与职位 HTML，XPath 解析 | 源码内硬编码多组 `__zp_stoken__` Cookie，并轮换 User-Agent | 只采集，不处理聊天或投递 | 仓库自述不再维护；Cookie 泄露、反爬对抗、选择器过时、协议风险都很高 | 明确列入禁止模式：不接收用户 Cookie、不存账号密码、不轮换身份规避限制 |

### 1. JobSpy：把多个非统一来源包成同一职位 schema

JobSpy 的核心价值不在浏览器，而在 provider adapter 和统一模型。LinkedIn 适配器直接请求 `jobs-guest/jobs/api/seeMoreJobPostings/search`，解析公开 HTML 卡片；Indeed 适配器向 `https://apis.indeed.com/graphql` POST 查询；Glassdoor 同样构造 GraphQL 请求。源码没有招聘者聊天或申请状态读取能力。

来源：

- [JobSpy README 与统一输出字段](https://github.com/speedyapply/JobSpy/tree/fda080a373e8226f3fd60635323f5da9af9892b1)
- [LinkedIn guest endpoint 与 HTML 解析](https://github.com/speedyapply/JobSpy/blob/fda080a373e8226f3fd60635323f5da9af9892b1/jobspy/linkedin/__init__.py)
- [Indeed GraphQL 调用](https://github.com/speedyapply/JobSpy/blob/fda080a373e8226f3fd60635323f5da9af9892b1/jobspy/indeed/__init__.py)
- [Glassdoor GraphQL 调用](https://github.com/speedyapply/JobSpy/blob/fda080a373e8226f3fd60635323f5da9af9892b1/jobspy/glassdoor/__init__.py)

这说明“无需登录”不等于“官方开放 API”。JobSpy README 自己记录 LinkedIn 常在约第十页附近限流，所有站点都可能返回 429，并建议等待或使用代理。代理规避不是 Zhiyu 应默认采用的产品策略。

### 2. Job_Scraper：定时发现 + 结果保护，而非账号内自动化

该项目将每个来源做成 GitHub Actions watcher。LinkedIn 走 guest search/jobPosting endpoint；HiringCafe 在公开 `/jobs/<query>` SSR 页面解析 `__NEXT_DATA__`，原因是旧的匿名 API 已经返回 401/405；Indeed、Glassdoor、ZipRecruiter、Google Jobs 多数交给 JobSpy。它把结果写成 JSON/HTML，按 ID 去重，并在来源本轮异常或全空时保留上轮结果，避免一次限流清空用户看板。

来源：

- [项目 README 和 watcher 说明](https://github.com/ScottCoffin/Job_Scraper/tree/06d6f6b614d2f570466dcb65227777947ace13ac)
- [LinkedIn 与 HiringCafe 的实际采集代码](https://github.com/ScottCoffin/Job_Scraper/blob/06d6f6b614d2f570466dcb65227777947ace13ac/scrape_jobs.py)

这也是 HiringCafe 路径的现实情况：HiringCafe 本身不是一个可审计的开源数据源；外部项目依赖其网页或内部接口，一旦鉴权或渲染方式变化就必须重写。因此可以做补充源，不能成为 Zhiyu 的唯一发现入口。

### 3. OpenJobs：优先用企业 ATS，而不是聚合招聘平台

OpenJobs 维护公司及其 ATS URL，`harvest.mjs` 识别 ATS 后分发给适配器。Greenhouse 使用公开 Job Board API，Lever 使用 Postings API，Ashby 使用 Posting API；LinkedIn、Wellfound 等没有适合该项目的公开接口时，直接进入 `jobs-manual-<date>.csv`，没有假装自动覆盖。

来源：

- [OpenJobs 架构和 manual fallback](https://github.com/outscal/OpenJobs/tree/cdcc533521afb61f4e60657b3dbe06e484ccddcf)
- [Greenhouse adapter](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/adapters/greenhouse.mjs)
- [Lever adapter](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/adapters/lever.mjs)
- [Ashby adapter](https://github.com/outscal/OpenJobs/blob/cdcc533521afb61f4e60657b3dbe06e484ccddcf/adapters/ashby.mjs)

官方文档也验证了这条路的边界：Greenhouse 明确说明 Job Board 的 GET 数据公开且不需要认证，但 application POST 需要 Basic Auth；Lever 的 published posting 公开可见，申请接口需要企业 API key 并受限流。这些是“职位发现公开、代表求职者提交不公开”的直接证据。

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html)
- [Lever Postings API](https://github.com/lever/postings-api)

### 4. OpenPostings：由用户提供企业职位板 seed

OpenPostings 的浏览器扩展不负责读取任意招聘平台账号，而是读取当前 tab URL，将它分类为受支持的企业 ATS source，再交给本地后端同步。项目明确区分 seeded ATS 与 dynamic ATS，后者不会由扩展加入。MCP 层负责从本地数据库挑候选、生成求职信、记录完成；源码要求 `dry_run_only` 或最终用户批准时才提交状态变更，真正网页申请仍由外部浏览器工具执行。

来源：

- [OpenPostings README](https://github.com/Masterjx9/OpenPostings/tree/114fccf64d29d7ccb19406e6490be3df18a0fc83)
- [扩展 popup：读取当前 URL 并提交 seed](https://github.com/Masterjx9/OpenPostings/blob/114fccf64d29d7ccb19406e6490be3df18a0fc83/chrome-extension/openpostings-seeded-url-capture/popup.js)
- [MCP 候选、dry-run 与最终批准](https://github.com/Masterjx9/OpenPostings/blob/114fccf64d29d7ccb19406e6490be3df18a0fc83/server/mcp-apply-server.js)

### 5. freehire：用邮箱补齐投递后的真实反馈

freehire 把来源、申请和结果连接得最完整：后台采集企业 ATS；浏览器扩展通过专用连接在当前申请页面执行 autofill；申请看板维护阶段；Gmail OAuth、托管邮箱或客户端批量导入邮件，再将招聘回复关联到具体申请。其设计文档特别强调：Gmail 搜索先返回候选，只有用户点击关联时才导入和落库。

来源：

- [freehire README](https://github.com/strelov1/freehire/tree/ed7b983dd2f1fb1a59146cf5302b14ae4fe80242)
- [来源架构](https://github.com/strelov1/freehire/blob/ed7b983dd2f1fb1a59146cf5302b14ae4fe80242/docs/sources.md)
- [邮件链路和 OAuth 边界](https://github.com/strelov1/freehire/blob/ed7b983dd2f1fb1a59146cf5302b14ae4fe80242/docs/agents/mail-stack.md)
- [公开 API 中的 autofill 与邮箱入口](https://github.com/strelov1/freehire/blob/ed7b983dd2f1fb1a59146cf5302b14ae4fe80242/docs/API.md)

这条模式非常适合长期车间：平台内的聊天不是唯一反馈源，真实的申请回执、拒信和面试邀请通常会进入邮箱，并且更适合被结构化为可审计事件。

### 6. AIHawk：从职位机器人转为通用浏览器执行器

本次检查的原 AIHawk 仓库已不再提供第三方招聘 provider 插件；README 明确说当前产品是通用 browser agent。它通过 Playwright 兼容引擎控制真实浏览器，`--profile-dir` 让 Cookie 与登录跨运行保留，模型根据页面状态点击和输入。该模式能覆盖任意网页，却把高权限浏览器会话交给 agent，风险面远大于只读职位 API。

来源：

- [AIHawk 当前 README](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk/tree/033f848cb72b1890e5b243c8fbe47f515e496e01)
- [浏览器 MCP 动作实现](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk/blob/033f848cb72b1890e5b243c8fbe47f515e496e01/src/aihawk/mcp/actions.py)

### 7. LinkedIn Easy Apply Bot：账号自动化的典型反例

该项目把邮箱、密码、简历路径和问卷答案写进 YAML。Selenium 自动打开 LinkedIn 登录页、提交账号密码、搜索职位、点击 Easy Apply、填写多页表单，直到点击 `Submit application`；遇 security check 时暂停等待用户手动处理。

来源：

- [README 与凭据配置](https://github.com/NathanDuma/LinkedIn-Easy-Apply-Bot/tree/5729dc092e45b8b2149ccd753b5d6d6a6ddb12a0)
- [登录、DOM 解析与最终提交代码](https://github.com/NathanDuma/LinkedIn-Easy-Apply-Bot/blob/5729dc092e45b8b2149ccd753b5d6d6a6ddb12a0/linkedineasyapply.py)

LinkedIn 官方明确表示，未经许可的 crawler、bot、浏览器插件或扩展不得抓取或自动化网站活动；需要自动抓取必须申请明确许可。因此这个模式不应进入 Zhiyu 默认能力。

- [LinkedIn Crawling Terms](https://www.linkedin.com/legal/crawling-terms)
- [LinkedIn：Prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions)

### 8. Simplify Copilot：在用户当前页面上辅助填表

Simplify 不是开源实现，本次无法从源码审计其选择器、远程规则或数据传输，只能核实官方产品行为。官方帮助说明它是浏览器扩展：用户打开受支持的申请页后点击 Autofill，扩展填简历、常见问题和特有问题；用户检查并自行提交；提交后可自动写入 Job Tracker。用户还可以关闭 AI 特有问题、多页连续填充或某些敏感字段。

来源：

- [官方：安装与工作方式](https://help.simplify.jobs/en/articles/1749022-installing-and-setting-up-copilot)
- [官方：填充申请与写入 Tracker](https://help.simplify.jobs/articles/2415391-using-copilot-to-autofill-applications)
- [官方：控制自动填充字段和多页行为](https://help.simplify.jobs/articles/8686025-manage-autofill-settings-in-the-simplify-extension)

这种 UX 比“后台悄悄代投”更适合 Zhiyu：先展示将要填入的资料和无法回答的问题，用户检查后在原网站完成提交。

### 9. 国内 BOSS 项目：主流实现都在复用浏览器会话或内部接口

相对克制的代表是 BossHunter：用户先在可见 Chrome 中自己登录，程序通过 Chrome DevTools Protocol 连接该浏览器，DOM 抽取职位并写入本地数据库；BOSS 投递要求人工确认，其他国内平台保持只读，检测到验证码、频率限制、登录墙或未知页面结构就停止。它仍明确警告平台封禁风险，并采用 PolyForm Noncommercial License，不能作为可直接拷贝的商业开源依赖。

- [BossHunter README、能力边界与许可证](https://github.com/shengjidaguai-china/BossHunter)
- [BOSS 职位采集实现](https://github.com/shengjidaguai-china/BossHunter/blob/main/src/bosshunter/scraper/jobs.py)

`lastsunday/job-hunting` 则代表浏览器扩展路线：扩展运行在 BOSS 页面中，从页面响应 JSON/DOM 获得岗位，并用当前登录态访问同源详情接口，主要用于增强展示、本地快照和分析。它没有解决接口授权问题，README 也明确限制为学习研究并禁止大规模采集。

- [职位猎人 README](https://github.com/lastsunday/job-hunting)
- [BOSS content script](https://github.com/lastsunday/job-hunting/blob/dev/apps/extension/entrypoints/content/plantforms/boss/index.js)

更激进的实现会直接复用私有业务接口。`mcp-bosszp` 模拟扫码登录并在 requests session 中维护 Cookie，随后调用推荐职位和发起沟通的 `wapi`；`boss-auto-apply` 一类油猴脚本从已登录页面取 `securityId`、职位 ID 和 Cookie，再调用详情和沟通接口。这些项目展示了技术路径，但也是最不适合 Zhiyu 产品化的路径。

- [mcp-bosszp：登录、推荐和沟通接口实现](https://github.com/mucsbr/mcp-bosszp/blob/main/boss_zhipin_fastmcp_v2.py)
- [boss-auto-apply 油猴脚本](https://github.com/muyuniao/boss-auto-apply/blob/main/boss-auto-apply.user.js)

两个旧式爬虫进一步说明维护成本。`poboll/bosszhipin_spider` 用 Pyppeteer 打开城市页面，像用户一样输入关键词，再从多个候选 CSS/XPath 中解析职位卡。可配置持久化 browser profile；检测到 `/verify` 或“安全验证”文本时暂停让用户处理，或明确失败。它不获取聊天和申请状态。

- [Pyppeteer BOSS 采集实现](https://github.com/poboll/bosszhipin_spider/blob/3d70ae397a61b288c416ec7995d8e6f6216f6d31/p.py)
- [README 的验证与改版说明](https://github.com/poboll/bosszhipin_spider/tree/3d70ae397a61b288c416ec7995d8e6f6216f6d31)

更早的 `jhcoco/bosszp` 用 Scrapy 请求城市 JSON 和职位 HTML，通过 XPath 解析。源码硬编码并轮换多个 `__zp_stoken__` Cookie 与 User-Agent，README 已声明停止维护。这正好展示直接爬平台的寿命和凭据风险。

- [旧版 Scrapy BOSS 项目（`bosszp/spiders/boss.py`）](https://github.com/jhcoco/bosszp/tree/522250ff097909439bd72a58d2433bfc1a5bdab3)
- [项目 README](https://github.com/jhcoco/bosszp/tree/522250ff097909439bd72a58d2433bfc1a5bdab3)

BOSS 官方用户协议的边界比技术难度更明确：第 4 条第 8 款要求用户通过 BOSS 软件使用服务，未经许可不得通过第三方软件登录、浏览职位、收发简历；第 8 条第 10、13、14 款禁止未经许可的插件/第三方接入、蜘蛛/爬虫/拟人程序等非正常浏览，以及为用户提供自动登录。协议还限制对外公布其他用户聊天记录。

- [BOSS直聘用户协议](https://www.zhipin.com/web/common/protocol/protocol-2019-09-30.html)

因此，BOSS 接入不能以“隐藏 Cookie + 后台持续爬 + 自动开聊”为正式产品路径。

## 哪些模式适合 Zhiyu

### A. 建议直接采用

#### 1. 公开职位源适配层

以 `source_adapter` 统一接入：

- Greenhouse、Lever、Ashby 等公开 ATS；
- 企业官网公开招聘页/RSS；
- 有明确开发者条款的官方招聘 API；
- 用户主动添加的公司职业页 seed。

每条职位必须保存 `provider`、`source_url`、`external_id`、`observed_at`、`source_updated_at`、`content_hash` 和原始响应摘要。单个 provider 失败时展示原因，保留上一轮快照，不把“抓取为零”当成“市场没有岗位”。

#### 2. BOSS 的用户主动导入

优先支持：

- 粘贴职位描述或分享文本；
- 上传/拖入职位截图，用 OCR 结构化；
- 粘贴一段聊天，由用户选择是否保存原文；
- 保存职位 URL 作为来源凭证，不由后台反复访问；
- 提供“复制建议回复”，由用户回 BOSS 自行发送。

导入后，Zhiyu 的价值在状态管理和下一步建议，而不是冒充用户操作 BOSS：

```text
原始职位/聊天观测
  -> 结构化职位与对方意图
  -> 匹配评分、风险与证据
  -> 建议回复/简历版本
  -> 用户复制并发送
  -> 用户标记已发送或导入新消息
  -> 更新等待方、截止时间和跟进提醒
```

#### 3. 邮箱结果反馈

用 OAuth 只读接入用户明确授权的邮箱，按公司、职位、申请时间窗检索：投递回执、拒信、测评、约面和 Offer。先生成候选关联，不自动修改状态；用户确认或规则证据足够后，再写 application event。邮箱撤销连接时应删除 token，并提供删除已同步邮件正文的入口。

#### 4. 求职状态事件账本

职位不是一张静态卡，而是持续状态：

```text
discovered -> shortlisted -> preparing -> contacted -> applied
           -> recruiter_replied -> interview -> offer / rejected / withdrawn
```

每次变化记录来源：用户操作、导入聊天、邮件证据、日历事件或系统推断。推断不能伪装成事实，必须能被用户纠正。

### B. 只能作为可替换、受控实验

- LinkedIn guest、HiringCafe SSR、Indeed/Glassdoor 内部 GraphQL 等匿名接口；
- 无官方保证的企业 ATS 页面内部 JSON；
- 用户当前页的一次性 DOM 读取。

这些 adapter 必须有请求频率、缓存、熔断、schema 版本、空结果保护、失败详情和随时关闭开关。不得使用代理池、指纹伪装或验证码绕过作为产品可用性的基础。

### C. 不建议进入 Zhiyu

- 保存 BOSS/LinkedIn 的账号密码或导入其 Cookie；
- 自动登录、验证码绕过、代理轮换和浏览器指纹伪装；
- 后台批量开聊、自动回复招聘者、自动点击最终投递；
- 采集或公开招聘者的非必要个人资料、完整聊天和联系方式；
- 用“已访问网页”推断“已投递成功”，或在无确认页/回执时写成功状态。

## 对“求职运营官”第一版的建议

第一版不用等待 BOSS 自动化。最短可用闭环可以是：

1. **机会源**：先接 Greenhouse/Lever/Ashby 与几个目标公司官网；BOSS 由用户粘贴/截图导入。
2. **统一职位卡**：去重、匹配简历、显示缺口、来源与数据新鲜度。
3. **申请准备**：生成针对 JD 的简历建议、开场白和问题回复；所有事实只来自用户已确认资料。
4. **待我处理**：把待回复、待投递、待跟进、待面试集中到一个页面。
5. **结果反馈**：先由用户手动改状态，随后接 Gmail 只读候选关联。
6. **Loop**：每天同步公开源、检查超时事项、更新优先级；不自动向招聘平台发送任何内容。

这个版本已经能验证长期执行价值：它能发现新机会、记住每次互动、提醒下一步并从真实回复率/约面率中调整策略，同时避免把产品生命线押在 BOSS 的逆向接口上。

## 还未证实的事项

- 本次没有发现 BOSS 面向个人求职者开放的职位搜索、聊天或投递 API。不能据此断言其内部或商业合作接口绝对不存在，只能说公开文档与检查到的开源项目没有提供可合法复用的个人接口。
- Simplify Copilot 为闭源扩展，其底层字段识别和数据传输只能从官方行为说明确认，不能像开源项目一样逐行核验。
- 匿名网页/内部 endpoint 的可访问状态会随时间、地区、频率和风控变化；源码里存在 URL 不代表今天或未来稳定可用。
