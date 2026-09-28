# Jina + Defuddle 网页读取实现与验证

2026-09-24。范围为桌面 Web 的聊天与车间网页读取后端。

## 流程与状态

公开 URL → Jina Reader（HTML）→ inert DOM → Defuddle 0.19.4 → Markdown → 保存证据 → 按字符窗口返回模型。

输入不包含站点 Cookie；可选 JINA_API_KEY 仅发往 Jina。默认无需 Key，但受上游匿名限流约束。公网 URL 校验复用 public-page-reader。HTML 上限 2 MiB，超限明确失败；仅对传输错误和上游 5xx 重试一次。Defuddle 不执行网页脚本，关闭异步提取和额外网络请求。

原始 HTML、清洗 Markdown、含来源和哈希的 snapshot、各次窗口结果分别写入 WEB_READ_EVIDENCE_DIR，默认进程工作目录下的 .data/web-read-evidence。聊天按可信用户 ID 隔离，车间按可信车间 ID 隔离。模型不能指定存储作用域。保存失败即读取失败，不伪造可追溯成功。

首次读取返回 evidenceId、contentHash、totalChars、truncated、nextOffset。续读传同一 URL、evidenceId 和 offset，不再请求上游。工具仍受运行时权限及读取预算约束。车间原有直接读取作为显式标记的降级路径保留；保存证据的续读失败不会换源，避免拼接不同快照。取消后不进入直接读取降级或报告成功。

车间 source_checked 事件记录 provider 对应的读取方法、清洗器版本、哈希、证据 ID、截断和降级错误。返回正文明确标记为不可信外部证据，不能作为指令。返回的质量分为启发式，不代表事实准确率。

## 真实页面验证

页面：https://blog.csdn.net/qq_31532979/article/details/162139401

- 未提供 API Key，真实 Jina HTML 请求成功。
- 原始 HTML：563,677 字节；清洗正文：9,047 字符。
- 对比原始文章 DOM：12/12 标题和 7/7 pre 代码块保留。
- 检查的扫码支付、打赏作者、登录领取、推荐文章文本未进入正文。
- 真实 reader 首窗 3,000 字符，续窗 6,047 字符；续读禁用网络后仍能取得末尾总结。
- 实测证据、清洗全文和验证 JSON 存在忽略提交的 .tmp/web-reader-validation/。

Jina HTML 响应报告 x-usage-tokens=179514；此前 Markdown 请求报告 28945。这些是不同响应的上游用量，不能用正文字符数推算模型 token 节省，也不能宣称 Jina 费用下降。Defuddle 本地清洗主要减少模型输入噪声。

## 限制与验收范围

- SVG 转为图中文字标签，并返回警告；不能保留箭头方向、位置等视觉关系，必要时需要查看原图。
- 未独立核验重定向后的最终 URL；返回 finalUrlVerified=false。页面锚点不自动定位，明确提示使用保存正文的窗口。
- 简单错误页识别不能覆盖所有反爬或登录页面；提取不是绕过登录、付费墙的能力。
- 尚未设置证据自动保留期限/清理任务。目录需使用持久磁盘；多实例部署应共享受控存储或做实例路由。
- 完成真实网络冒烟，6 个针对性测试文件共 63 项通过，覆盖清洗、保存与续读、用户隔离、权限拒绝、取消和读取预算；TypeScript 检查通过。未重启现有服务，未完成浏览器端到端和生产构建验收，因此不标记已部署。
- 扩展回归中的 native-pi-web-chat-tools 搜索用例失败：HTML 模拟返回被搜索适配器按 JSON 读取。该用例未涉及新网页读取链路，作为独立遗留记录，不以过滤测试声称全套通过。

复现：在 apps/web 执行 pnpm exec tsx scripts/smoke-jina-defuddle.ts；验证下载的文章 DOM 则执行 pnpm exec tsx scripts/validate-jina-defuddle.ts。前者会请求公开 URL，并产生证据文件。
