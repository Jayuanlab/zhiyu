# 网页图表按需读取：实现与验证

## 范围和流程

聊天与车间继续使用同一个 webReadPage 权限，不新增默认放行的工具。首次读取公开网页仍由 Jina 返回 HTML、Defuddle 提取正文。正文中的 SVG、图片和 Canvas 候选转为图表编号；只保留清洗后正文实际引用的候选，过滤隐藏标记和小图标。原始 HTML 和 SVG markup 留在同一作用域的证据快照中。

智能体随后使用 url、evidenceId、figureId 按需读图。内联 SVG 在临时无头浏览器中离线渲染，不访问原网站；禁用网页 JavaScript、Service Worker 和外部资源请求。PNG/JPEG/WebP 图片通过有 DNS 地址约束的公开网络下载器读取，限制重定向、大小和解码像素，再转 PNG。Canvas 未包含像素、外部 SVG 图片等不支持的情况明确失败，不伪装成看懂。

返回真实 image 内容块与来源元数据。修正了聊天工具适配器只能返回文本、车间适配器将图片 JSON 化的问题；模型必须支持图像输入。未配置视觉能力时不应根据标签推断图中关系。

看图后可再次调用 webReadPage，附带 figureDescription。说明单独保存为 model_interpretation_unverified，关联原始来源哈希、图片哈希、时间和调用方身份。它不会覆盖原始事实，也不被当作已核验事实。再次读取图表会返回最近的说明；正文续读可查看图表渲染及理解状态。

## 边界、反馈和恢复

- 证据目录继续按可信用户或车间 ID 隔离，调用参数不能指定作用域或任意文件路径。denied 规则优先。
- 读取复用保存的 PNG，不重复渲染；图表说明为追加记录，重复提交不会覆盖历史。
- 页面、图形和渲染图片均带哈希。用户可通过原始材料纠正模型理解，再追加说明。
- 取消信号在网络、启动浏览器和返回前检查；浏览器在 finally 中关闭。单进程同时只允许一个 SVG 渲染，繁忙时明确提示重试。
- 渲染失败记录为 unavailable / not_interpreted；车间 source_checked 事件携带证据和状态。图片不可用时退回正文并报告视觉证据缺口。
- 图片最多下载 5 MiB，解码最多 2000 万像素；渲染图片也限制 5 MiB。浏览器 launch 和截图均有超时。
- 当前没有新增图表管理页面；利用既有工具结果和车间事件显示状态。可暂停运行、禁用 webReadPage 或纠正说明。

## 配置

新增生产依赖 playwright@1.59.1，Next 将 playwright/playwright-core 作为服务端外部依赖加载。本机使用 Edge 无头模式；其他系统默认使用 Playwright Chromium，可执行 pnpm exec playwright install chromium 安装运行所需浏览器。WEB_FIGURE_BROWSER_PATH 可指定已安装浏览器可执行文件。

正文提取不启动浏览器，只有实际读 SVG 时临时启动。没有新增常驻抓取服务。保存目录仍使用 WEB_READ_EVIDENCE_DIR；生产使用持久磁盘。自动过期清理仍未实现。

## 验证

使用之前从 Jina 真实取得的 CSDN HTML 快照回放，页面 URL 为 https://blog.csdn.net/qq_31532979/article/details/162139401 。这次不是重新抓取网站，不将回放时刻当作新的网站观测证据。

- 清洗正文保留两张主要 SVG 的编号和标签，原始 SVG 不进入普通模型文本。
- Edge 实际渲染“整体架构概览”和“自注意力机制”两张 PNG，分别为 8,897 和 68,023 字节。
- 人工视检：中文、连线、箭头、Q/K/V 分支及 foreignObject 文字均可见。
- 视觉说明基于已检查的精确 PNG 哈希写入独立记录；说明也明确图中没有展示哪些细节。
- 7 个针对性测试文件共 72 项通过，覆盖保存/续读、隔离、权限、私网重定向、大小限制、失败记录、图片块传递；真实 Agent Harness 配合模拟模型确认下一轮模型上下文包含 image 内容块。
- TypeScript 检查通过。未向用户配置的远程模型发送测试图片，未进行生产构建或重启现有服务，不声称已部署或完成浏览器聊天端到端验收。

复现脚本位于 apps/web/scripts/smoke-web-figures.ts；结果在 .tmp/web-reader-validation/figure-smoke.json、clean-with-figures.md 与 figure-evidence/。record-web-figure-validation.ts 仅回放对固定图片哈希的人工视觉审阅，不是自动图片理解服务。

## 已知限制

离线 SVG 依赖系统字体和 SVG 自带样式；网页外部 CSS/字体/资源不可用时可能与原图不同，返回警告。超长图缩放后小字可能难读。外部图片是按需取得，时间可能晚于 HTML 快照，会保留这个差异。当前提供真实图片给现有模型，由其按需解释，不另行调用第三方视觉服务；模型视觉能力的真实可用性仍由所选供应商决定。
