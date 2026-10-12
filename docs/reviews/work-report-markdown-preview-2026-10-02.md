# 工作汇报预览 Markdown 渲染验收

日期：2026-10-02。

用户要求：打开完整报告前，工作汇报预览也渲染 Markdown，继续保留原有截断。

## 修改范围

`apps/web/app/(chat)/workshop/work-presentation-area.tsx` 的三个摘要槽位复用现有 `Markdown` 组件：工作桌预览、未完成任务摘要、完整汇报弹窗的“本轮结论”。容器改为可承载 Markdown 块元素的 `div`，预览添加换行与溢出约束。

摘要选择、800 字符截断、完整正文及查看按钮保持原有行为，未改历史报告内容或后台任务配置。

## 验证与实际生效

- 现有 `workshop-work-presentation.test.ts`：9 项通过；差异空白检查通过。
- 隔离生产构建 `next-review-13`：编译、TypeScript、页面生成及最终构建成功，退出码 0。
- 本地 3515 服务实际装载新构建，后台心跳在线；启动日志保存在 `.runtime/project-researcher-host/markdown-preview-production-stdout.log`。
- 真实报告接口仍返回 800 字符摘要与 3994 字符完整正文。页面预览已出现独立标题、加粗文本和行内代码，预览区域宽度与滚动宽度同为 543 像素。
- 点击“查看完整汇报”，弹窗包含预览外的“六、来源限制”及完整正文；关闭后回到渲染过的摘要。
- 真实页面截图：`.runtime/project-researcher-host/markdown-preview-proof.jpg`。

## 验证限制与回退

浏览器尺寸控制超时，宽窗口缩放回测未完成；已验证当前窗口的真实渲染、无横向溢出和全文入口。Markdown 截断落在未闭合标记时，渲染器按普通文本处理末尾残片，原始摘要不作改写。

原 `.next` 构建保留。需要回退显示时，可在遵守后台租约过期约束后，将托管服务恢复到原构建；本次没有修改业务数据。
