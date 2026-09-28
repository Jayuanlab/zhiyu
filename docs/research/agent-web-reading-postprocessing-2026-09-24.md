# 智能体读取网页后的后处理：GitHub 源码调研

日期：2026-09-24。范围：开源智能体/研究智能体的实际工具实现；不把项目热度等同于效果，也不声称覆盖全部主流方案。本次只调研，不修改产品代码。来源固定到本次 GitHub HEAD，避免后续分支变化影响复核。

## 结论

实际实现分为三类：①清洗和格式转换后限制输出长度；②保留长文本，在上下文中只提供预览并允许继续读取；③面向研究问题，分块筛选或生成带来源的摘要。并不是每个智能体都先做向量检索，也不是都让模型总结全文。

HTML 转 Markdown 只解决表示格式，不自动等于正文提取；直接截取前 N 字符控制成本，但可能保留导航并丢掉文章末尾。清洗、相关性筛选、摘要属于不同处理阶段，不能混称为“去噪”。

## 已核实的项目实现

### smolagents：轻量转换和截断

`VisitWebpageTool` 使用 requests 获取页面，20 秒超时并检查 HTTP 错误；用 markdownify 将 HTML 转 Markdown，合并连续三个以上换行，再按默认 40,000 **字符**截取，追加截断提示。超时、请求错误和其他异常返回明确错误文本。这个工具函数没有实现按问题抽取、分块检索或模型摘要；也没有额外封装来源元数据对象。

来源：[default_tools.py / VisitWebpageTool](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/default_tools.py)。

### OpenCode：移除非内容标签、格式转换和响应上限

webfetch 的 Markdown 路径用 Turndown，移除 script/style/meta/link，代码块采用 fenced 格式；纯文本路径用 HTML 解析器跳过 script/style/noscript/iframe/object/embed。网络响应上限为 5 MiB。工具描述还告知模型超大输出会存储并返回预览；本次未追踪该通用输出存储层的完整调用链，因此不把它说成本文件独立实现的分页能力。

来源：[webfetch.ts](https://github.com/anomalyco/opencode/blob/0f549842ee746e400b1f72516b0b2e292e267e2c/packages/core/src/tool/webfetch.ts)。

### OpenClaw：正文提取、预算、元数据与不可信内容包装

web-fetch 使用 Readability、provider 与基础提取等分支和降级路径。源码包含默认 20,000 字符输出预算、默认 750,000 字节响应读取上限，以及更大文本的 spill 处理。工具结果提供 provider/extractor、fetchedAt、truncated、rawLength、warning/cached 等用于解释结果来源、截断与降级的字段；外部文本另经不可信内容包装。包装和提示是防护的一层，不是“保证网页无法进行提示注入”。

来源：[web-fetch.ts](https://github.com/openclaw/openclaw/blob/0fa428d6f6de2261c89fee1c7ea97d7282f2e3f6/src/agents/tools/web-fetch.ts)、[external-content.ts](https://github.com/openclaw/openclaw/blob/0fa428d6f6de2261c89fee1c7ea97d7282f2e3f6/src/security/external-content.ts)。

### GPT Researcher：先清洗，再按问题挑选原文片段

BeautifulSoup 抓取路径移除 script/style/footer/header/nav/menu/sidebar/svg 标签，以及 class 精确匹配 nav/menu/sidebar/footer 的元素；随后提取文本并整理空白。这是其一条 scraper 路径，不代表所有 provider 都执行同一套 HTML 规则。该路径对请求失败和部分临时 HTTP 状态重试一次；最终失败返回空结果，不解析 HTTP 错误页为正文。

来源：[scraper/utils.py](https://github.com/assafelovic/gpt-researcher/blob/6f998577d547b1e54ec662dac63583aa11e3b84b/gpt_researcher/scraper/utils.py)、[beautiful_soup.py](https://github.com/assafelovic/gpt-researcher/blob/6f998577d547b1e54ec662dac63583aa11e3b84b/gpt_researcher/scraper/beautiful_soup/beautiful_soup.py)。

`ContextCompressor` 的短内容路径在总 raw_content 少于默认 8,000 字符、文档数量不超过 max_results 时直接返回，避免支付 embedding 费用。长内容路径中，SearchAPIRetriever 默认每页先限制为 50,000 字符；再以 1,000 字符分块、重叠 100 字符，使用 EmbeddingsFilter 按问题相似度过滤（默认阈值 0.35，可配置），最终默认输出最多 5 个文档块。这里的“压缩”主要是选取原文，不是让 LLM 改写摘要，也没有必要先建立持久向量库。

Source URL 和 Title 随 Document metadata 保存，最终格式化为 Source / Title / Content。保留来源使报告能引用，但不等同于系统已自动验证每条最终断言。

来源：[compression.py](https://github.com/assafelovic/gpt-researcher/blob/6f998577d547b1e54ec662dac63583aa11e3b84b/gpt_researcher/context/compression.py)、[retriever.py](https://github.com/assafelovic/gpt-researcher/blob/6f998577d547b1e54ec662dac63583aa11e3b84b/gpt_researcher/context/retriever.py)、[prompts.py / pretty_print_docs](https://github.com/assafelovic/gpt-researcher/blob/6f998577d547b1e54ec662dac63583aa11e3b84b/gpt_researcher/prompts.py)。

### LangChain Open Deep Research：去重与摘要加关键摘录

Tavily 路径获取 raw_content 后按 URL 去重；每页默认先取前 50,000 字符，再并行调用摘要模型，输出结构化 summary 和 key_excerpts。没有 raw_content 时使用搜索结果 content；摘要 60 秒超时或异常时记录 warning 并回退到传入的网页内容，即已经过长度限制的内容。最后给每个来源保留编号、标题和 URL。

来源：[utils.py / tavily_search 与 summarize_webpage](https://github.com/langchain-ai/open_deep_research/blob/1b7d2e80db9faa586165c60e09096dbbfd483a64/src/open_deep_research/utils.py)、[configuration.py / max_content_length](https://github.com/langchain-ai/open_deep_research/blob/1b7d2e80db9faa586165c60e09096dbbfd483a64/src/open_deep_research/configuration.py)。

此仓库在 GitHub 显示已于 2026-08-21 归档；这里只把它作为可核实的研究智能体参考实现，不视为当前持续维护方案。[仓库](https://github.com/langchain-ai/open_deep_research)。

## 针对 Zhiyu + Jina 的建议（推导，不是上述项目的共同默认行为）

1. **先判断读到的是什么。** 抓取成功与正文成功分开：登录页、验证码、付费墙、异常短内容应标为 degraded/blocked。HTTP 200 本身不能证明读到了文章。
2. **先选正文，再限制长度。** Jina 已返回 Markdown 时，避免重复 HTML 转换；Readability 面向 HTML，不能直接当作 Markdown 正文清洗器。能在上游按已核实的页面 HTML 选择正文区域则优先做，否则保守地按 Markdown 块结构去导航、推荐和评论。代码、公式、标题、表格与链接应尽量保留。不要把“让 LLM 总结 3 万 tokens”作为默认去广告方法。
3. **保留可回读的事实。** 原始抓取、清洗正文、片段与摘要分层；记录 URL、抓取时间、provider、清洗版本、内容哈希、截断与警告。原文不能被摘要覆盖。
4. **按任务决定给模型多少。** 短文章直接提供正文；长文章先给目录、预览和可继续读取的 chunk ID；问一个具体问题时按标题/关键词检索，必要时才加 embeddings 或重排；需要跨网页报告时再做带片段来源的摘要。
5. **明确权限与反馈。** 网页仅是观测输入，内容里的“指令”不授予工具权限；denied 优先。把缺失、降级、摘要失败和截断反馈给模型与桌面用户，允许回到来源、更换 provider、重试或停止；外部发送等行动继续经过现有审核边界。

后续如进入实施，应按项目工程控制论原则单独形成方案，明确状态存储、动作幂等、事件来源、人工纠错入口和异常恢复。本次不扩展成实现承诺。针对当前 CSDN 场景，最有价值的验证是：正文保留率、广告残留量、代码/公式完整性、输入 tokens、端到端耗时，以及长文末尾仍能通过续读取回；不能仅以返回更短作为成功标准。

## 补充：可以直接集成的正文提取开源库

追加核实日期：2026-09-24。下面是专门的内容处理组件，不需要把整个智能体项目搬进来。

### Defuddle：JavaScript 正文清洗与 Markdown 输出

README 描述其接受 URL/HTML/DOM，移除评论、侧栏、页眉页脚，输出干净 HTML 或 Markdown 与元数据；能整理代码块、去行号并保留语言信息，完整包还支持 MathJax/KaTeX 等数学表达处理。基础正文提取不需要模型。项目仍标注在持续开发，应按目标页面测试。官方生态中已有面向智能体的 Defuddle skill，说明它可以直接作为读取后的工具组件使用，而不必实现整个研究框架。

来源：[Defuddle README](https://github.com/kepano/defuddle)、[Obsidian 官方 skills 仓库中的 Defuddle skill](https://github.com/kepano/obsidian-skills/blob/main/skills/defuddle/SKILL.md)。这里将后者仅作为使用方式证据，不执行其指令。对技术博客的 JavaScript 后处理，Defuddle 是值得优先试验的候选；这是选型推导，不是质量保证。

### Crawl4AI Fit Markdown：抓取、清洗与相关性筛选整合

提供基于文本密度、链接密度等指标的 pruning，以及按问题执行 BM25 内容筛选；输出区分 `raw_markdown`、`fit_markdown`、`fit_html`。这些过滤发生在 HTML 转 Markdown 前；并不是把已有 Markdown 任意传进去就能完成相同的 DOM 去噪。其规则/BM25 路径不要求 LLM，适合希望一起接管抓取和处理链路的场景。

来源：[官方 Fit Markdown 文档](https://docs.crawl4ai.com/core/fit-markdown/)、[仓库](https://github.com/unclecode/crawl4ai)。

### Trafilatura：Python 正文与元数据提取

- 输入为已获取的 HTML 字符串、响应或 HTML 树；输出可选 Markdown、TXT、JSON、HTML、XML 等，可附带标题、作者、日期、站点等元数据。
- 正文算法以规则为主，并有 jusText/readability-lxml 回退；核心提取不需要调用 LLM 或提供模型 API Key。
- API 提供 `include_comments`、`include_tables`、`include_links`、`deduplicate`、`favor_precision`、`favor_recall` 和 `prune_xpath` 等选项。注意评论默认包含、链接默认不保留，不能把默认参数直接当作智能体阅读的最佳配置。
- 其输入契约是 HTML，输出支持 Markdown 不代表它是 Markdown 去噪器。提取也可能返回 None，需要由调用方记录失败或降级。

来源：[固定版本 README](https://github.com/adbar/trafilatura/blob/c852cae9708a59f04521b19395d8ed49771a5c78/README.md)、[extract API 源码](https://github.com/adbar/trafilatura/blob/c852cae9708a59f04521b19395d8ed49771a5c78/trafilatura/core.py)、[官方 API 文档](https://trafilatura.readthedocs.io/en/latest/corefunctions.html)。

### Mozilla Readability：JavaScript 文章正文提取

- Firefox 阅读模式使用的独立库；传入 DOM Document 后 `parse()` 返回正文 HTML、纯文本、标题、作者、站点、语言、发布时间等，不需要 LLM。
- Node.js 侧通常配合 jsdom 将 HTML 转成 DOM；传入原始页面 URL 可帮助转换相对链接。它本身不输出 Markdown，若需要 Markdown 可在正文 HTML 后追加转换器。
- `parse()` 会修改输入 DOM，可先 clone；快速判断函数 `isProbablyReaderable` 有误报和漏报。它不是安全净化库，若把提取 HTML 渲染给用户，官方要求另用 sanitizer 等防护。
- 同样不能直接接收 Jina 的 Markdown 并恢复原网页 DOM；它解决的是文章提取，不是任意网页的语义摘要、检索和引用核验。

来源：[固定版本 README 与 API](https://github.com/mozilla/readability/blob/ab4027a8b37669745016869a37a504727992b2ba/README.md)。

**选型推导：** 已有 Node.js 抓取链路且能拿到 HTML，Readability 是便于嵌入的候选；Python 侧需要正文、元数据和多种输出格式，优先试 Trafilatura。如果输入只剩 Jina Markdown，应优先改上游正文选择或做 Markdown 结构过滤，不建议为套用上述库而把 Markdown 转回伪 HTML——原网页的布局和标签证据已经丢失。以上是集成判断，实际效果仍需用目标网站样本验证。
