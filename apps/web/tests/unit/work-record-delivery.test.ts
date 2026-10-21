import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {buildWorkRecordDelivery,mergeWorkRecordEvents} from '@/lib/workshops/work-record-delivery';
import {WorkRecordDelivery} from '@/app/(chat)/workshop/work-record-delivery';
import type {WorkshopEvent} from '@/lib/workshops/run-history-types';

vi.mock('@/components/markdown',()=>({Markdown:({children}:{children:string})=>createElement('div',{},children)}));
const report='# 研究报告\n\n## 现有实现\n已有发送去重。\n\n### 改进建议\n1. 记录具体操作及回执，减少人工核对成本。\n2. 对长期未知状态提供人工核对入口。\n\n## 下一步\n先核对现有调用者，不直接改生产。';
const event=(seq:number,type:string,metadata:Record<string,unknown>={},body:string|null=null):WorkshopEvent=>({
 id:`e-${seq}`,workshopId:'work',runId:'run',loopRunId:'run',loopId:'loop',seq,type,title:type,body,metadata,createdAt:`2026-10-19T10:00:${String(seq).padStart(2,'0')}Z`,
});
const records=()=>[event(1,'loop_run_started',{},'项目理解与技术机会'),event(2,'tool_error',{},'Unknown evidence'),
 event(3,'loop_run_completed',{summary:'# 研究报告',finalMarkdownReport:report,reasoningChain:[{summary:'Task received',stepType:'input',description:'研究外部论文，提出项目修改建议。'}]},report)];
describe('owner work-record delivery',()=>{
 it('uses the Loop business summary when a later runtime completion repeats the full report',()=>{
  const value=buildWorkRecordDelivery([event(1,'loop_run_completed',{summary:'研究完成，证据不足尚需核验。',finalMarkdownReport:report},report),event(2,'run_completed',{},report)]);
  expect(value.summary).toBe('研究完成，证据不足尚需核验。');expect(value.reportMarkdown).toBe(report);
 });
 it('preserves persisted detail when a dashboard projection has the same event id',()=>{
  const detailed=event(3,'loop_run_completed',{summary:'已完成研究，提出建议，证据仍需补充。',finalMarkdownReport:report},report);
  const compact={...detailed,metadata:{summary:report.slice(0,1200)}};
  const value=buildWorkRecordDelivery(mergeWorkRecordEvents([compact],[detailed]));
  expect(value.summary).toBe(detailed.metadata.summary);expect(value.reportMarkdown).toBe(report);
 });
 it('keeps trailing references out of next steps while retaining the full report',()=>{
  const full=report+'\n\n---\n\n[^1]: 论文原文\n警告：尚未验证。';
  const value=buildWorkRecordDelivery([event(1,'loop_run_completed',{finalMarkdownReport:full},full)]);
  expect(value.nextStepsMarkdown).toBe('先核对现有调用者，不直接改生产。');expect(value.reportMarkdown).toBe(full);
 });
 it('reads the persisted full report, captured task and exact suggestion excerpt instead of a title or missing-goal placeholder',()=>{
  const events=records(),before=structuredClone(events),value=buildWorkRecordDelivery(events);
  expect(value.reportMarkdown).toBe(report);
  expect(value.goal).toBe('研究外部论文，提出项目修改建议。');
  expect(value.recommendationsMarkdown).toContain('记录具体操作及回执');
  expect(value.recommendationsMarkdown).not.toContain('已有发送去重');
  expect(value.status).toBe('completed');expect(value.processErrorCount).toBe(1);
  expect(value.failureReason).toBeNull();expect(events).toEqual(before);
 });
 it('renders suggestions before the full-report disclosure and explains that they are not implemented changes',()=>{
  const html=renderToStaticMarkup(createElement(WorkRecordDelivery,{delivery:buildWorkRecordDelivery(records())}));
  expect(html).toContain('本次工作');expect(html).toContain('报告中的建议');
  expect(html).toContain('不代表已经实施');expect(html.indexOf('记录具体操作及回执')).toBeLessThan(html.indexOf('完整报告'));
 });
 it('keeps a failed terminal and its diagnostic text separate from a completed report',()=>{
  const value=buildWorkRecordDelivery([event(1,'loop_run_started',{},'研究任务'),event(2,'tool_error',{},'Final validation correction limit exhausted'),
   event(3,'loop_run_failed',{finalMarkdownReport:report,summary:'# 研究报告'},report)]);
  expect(value.status).toBe('failed');expect(value.failureReason).toContain('Final validation correction limit exhausted');
  expect(value.recommendationsMarkdown).toBeNull();expect(value.diagnosticMarkdown).toBe(report);expect(value.reportMarkdown).toBeNull();
 });
 it('does not treat an unfinished draft as a final deliverable',()=>{
  const value=buildWorkRecordDelivery([event(1,'loop_run_started',{},'研究任务'),event(2,'agent_text',{},report)]);
  expect(value.status).toBe('running');expect(value.reportMarkdown).toBeNull();expect(value.recommendationsMarkdown).toBeNull();
 });
 it('ignores agent-authored status claims and rejects mixed-run input',()=>{
  expect(buildWorkRecordDelivery([event(1,'loop_run_started'),event(2,'run_completed',{receiptAuthority:'agent',finalMarkdownReport:report})]).status).toBe('running');
  expect(()=>buildWorkRecordDelivery([...records(),{...event(4,'loop_run_completed'),runId:'other',loopRunId:'other'}])).toThrow('single run');
 });
 it('does not extract suggestion headings from fenced code',()=>{
  const text='# Report\n\n```md\n## 改进建议\n伪建议\n```\n\n## 结论\n暂缓修改。';
  expect(buildWorkRecordDelivery([event(1,'loop_run_completed',{finalMarkdownReport:text},text)]).recommendationsMarkdown).toBeNull();
 });
});
