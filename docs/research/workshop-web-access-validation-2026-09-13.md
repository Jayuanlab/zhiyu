# 车间网站访问修复与回测（2026-09-13）

## 原因

- 车间网页读取直接使用 Node fetch，未显式启用环境代理。相同机器直连 Meta、Hugging Face、DeepMind、Google Research 均为 UND_ERR_CONNECT_TIMEOUT；使用已有代理后均 HTTP 200。
- OpenAI 新闻页直连及代理均 HTTP 403，其官方 `https://openai.com/news/rss.xml` 实测 HTTP 200。
- 首次读取及 Reader 都失败时，只抛出最后一条异常，丢失具体失败链。
- Loop 分类器没有识别 webSearch，落入默认 write_external，错误要求审批。当前 Loop 的 defaultMode=allow、externalWrites=require_approval；没有显式禁止搜索。
- DuckDuckGo 返回 HTTP 202 人机验证页，旧解析器返回空列表，误报为无搜索结果。

## 修改

- 网页读取和搜索共用 `web-fetch.ts`，显式使用 EnvHttpProxyAgent，读取 HTTP_PROXY/HTTPS_PROXY（兼容小写及 ALL_PROXY），保留 NO_PROXY 行为。未设置全局 dispatcher，也未硬编码个人代理端口。
- 请求及正文读取共用 15 秒截止信号；连接错误保留安全的原因代码。
- 双通道失败返回完整原因及 coverage incomplete，并记录 source_checked 失败事件。
- 仅 OpenAI 新闻/博客列表遇到 403 时使用官方 RSS，返回 method=official_rss、实际来源 URL 和降级 warning。具体文章失败不会偷偷替换成列表。
- RSS 保留各条标题、URL、发布时间和摘要，解析 CDATA，不将 XML 展平为无结构长文本。
- webSearch/webReadPage/WebFetch 归为 read；显式 denied、requiresApproval 优先级不变；抖音上传和公开发布仍需审核。
- 搜索验证页明确报服务不可用，不当作空结果。
- 知识博主 skill 区分“采集不完整”和“充分检索后无合格候选”，并要求复核记忆中的历史故障状态。

## 已执行回测

- 3 个测试文件共 28 项通过：web-search-tool、workshop-web-fetch、loop-approval。覆盖代理 dispatcher、截止信号、连接错误脱敏、双通道失败、成功降级、RSS 解析、文章边界、搜索验证页和权限优先级。
- 通过真实 MCP Client/Server 调用 webReadPage，沿用当前车间权限及事件写入：5/5 原失败来源恢复读取。脚本为 `apps/web/scripts/verify-workshop-web-access.mts`，需要传入 workshopId。
- OpenAI RSS 事件：c15ef013-d3a0-434b-bcb2-704c8dceddd6；Meta：cdd5badd-b311-4886-a9ed-0f994b344256；HF：bf0b555d-4ec0-4cb8-b513-f8b9932a47e9；DeepMind：a351347b-e8e2-477d-8945-adcb732aee55；Research：6b9ec6c3-d78a-45d3-adb3-716164913e74。
- 真实 webSearch 不再遭工具权限拒绝；当前 DuckDuckGo 返回人机验证，工具明确说明该限制。未配置新的搜索密钥或绕过验证。
- 本次未运行整轮视频生产，未上传、发布或改写历史失败报告。上述验证仅证明来源读取与权限链路，不证明每条来源文章都满足时效或事实核验条件。

## 生产验收

- 独立生产构建 `.tmp/next-review-96` 完整成功，BUILD_ID=`7GoXAnGFypLH8UTnbjvhw`；编译 3.3 分钟、TypeScript 44 秒、148 个页面生成通过。
- 00:19 正常停止旧管理器，worker `settled=true`、`unsettled=[]`、退出码 0；隐藏窗口启动生产管理器 PID 51340。
- 新 worker 实例 `9900177f-8449-488a-a095-d2ccb6b6a833`，8 个模块均 success、无 lastError。
- 浏览器刷新后显示“后台在线 Web 在线”，7 个智能体及现有审核内容加载正常。原有待审核事项没有被自动批准或删除。
- 地址仍为 `http://127.0.0.1:3515`。历史来源失败报告保留，修复后的来源回测事件已写入。
- 遗留：DuckDuckGo 人机验证属于外部服务限制，未绕过；如需稳定通用搜索，需要配置当前已支持的 Brave Search API 凭证。官方站点直读及 OpenAI RSS 不依赖这项配置。
