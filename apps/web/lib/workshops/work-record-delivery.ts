import {buildWorkPresentation,type WorkPresentationStatus} from './work-presentation';
import type {WorkshopEvent} from './run-history-types';

const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():null;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const statuses:Record<string,WorkPresentationStatus>={run_queued:'queued',run_started:'running',loop_run_started:'running',
 run_completed:'completed',loop_run_completed:'completed',run_failed:'failed',loop_run_failed:'failed',
 run_cancelled:'cancelled',loop_run_cancelled:'cancelled',run_interrupted:'interrupted',loop_run_interrupted:'interrupted',run_needs_review:'needs_review'};

export type WorkRecordDeliveryView={
 status:WorkPresentationStatus;goal:string|null;summary:string|null;reportMarkdown:string|null;
 recommendationsMarkdown:string|null;nextStepsMarkdown:string|null;diagnosticMarkdown:string|null;
 failureReason:string|null;processErrorCount:number;
};

/** History contains persisted details; dashboard events may be compact projections. */
export function mergeWorkRecordEvents(current: readonly WorkshopEvent[], history: readonly WorkshopEvent[]): WorkshopEvent[] {
 const merged=new Map<string,WorkshopEvent>();
 for(const event of [...current,...history])merged.set(event.id,event);
 return [...merged.values()];
}

/** Exact excerpts from delivered Markdown, never generated advice or execution proof. */
function reportSection(report:string,patterns:RegExp[]):string|null{
 const lines=report.split(/\r?\n/),headings:Array<{line:number;level:number;title:string}>=[];
 let fence:string|null=null;
 for(let i=0;i<lines.length;i++){
  const marker=lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence=null;continue;}
  if(fence)continue;
  const match=lines[i].match(/^\s{0,3}(#{2,6})\s+(.+?)\s*#*\s*$/);
  if(match)headings.push({line:i,level:match[1].length,title:match[2]});
 }
 for(const pattern of patterns){
  const heading=headings.find(h=>pattern.test(h.title));if(!heading)continue;
  const end=headings.find(h=>h.line>heading.line&&h.level<=heading.level)?.line??lines.length;
  const section=lines.slice(heading.line+1,end);
  // References after a thematic break belong to the full report, not this excerpt.
  let boundary=section.length,sectionFence:string|null=null;
  for(let i=0;i<section.length;i++){
   const marker=section[i].match(/^\s{0,3}(`{3,}|~{3,})/);
   if(marker){if(!sectionFence)sectionFence=marker[1][0];else if(marker[1][0]===sectionFence)sectionFence=null;continue;}
   if(!sectionFence&&/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(section[i])){boundary=i;break;}
  }
  const excerpt=section.slice(0,boundary).join('\n').trim();if(excerpt)return excerpt;
 }
 return null;
}

/** Read-only interpretation of one already-authorized run's persisted events. */
export function buildWorkRecordDelivery(input:readonly WorkshopEvent[]):WorkRecordDeliveryView{
 const ids=new Set(input.map(e=>e.loopRunId??e.runId).filter(Boolean));
 if(ids.size>1)throw new Error('Work record delivery requires a single run');
 const events=input.filter(e=>e.metadata.receiptAuthority!=='agent').slice().sort((a,b)=>a.seq-b.seq);
 const terminal=[...events].reverse().find(e=>statuses[e.type]&& !['running','queued'].includes(statuses[e.type]));
 const latestLifecycle=[...events].reverse().find(e=>statuses[e.type]);
 const status=latestLifecycle?statuses[latestLifecycle.type]:'unknown';
 const outcomeEvents=[...events].reverse().filter(e=>statuses[e.type]===status);
 const presentation=buildWorkPresentation({events});
 const goal=text(terminal?.metadata.goal)??events.flatMap(e=>Array.isArray(e.metadata.reasoningChain)?e.metadata.reasoningChain:[])
  .map(object).filter(s=>s.stepType==='input'||s.summary==='Task received').map(s=>text(s.description)).find(Boolean)
  ??text(events.find(e=>e.type==='loop_run_started')?.body)??null;
 const rawReport=outcomeEvents.map(e=>text(e.metadata.finalMarkdownReport)).find(Boolean)??text(object(terminal?.metadata.presentation).reportMarkdown)
  ??text(presentation?.reportMarkdown)??text(terminal?.body);
 const completed=status==='completed';
 const reportMarkdown=completed?rawReport:null;
 const processErrors=events.filter(e=>e.type==='tool_error');
 const failed=['failed','interrupted','cancelled','needs_review'].includes(status);
 const failureReason=failed?(text(object(terminal?.metadata.runtimeFailure).message)
  ??text([...processErrors].reverse().find(e=>e.body&&!e.body.trim().startsWith('#')&&e.body.length<1200)?.body)
  ??(terminal?.body&&!terminal.body.trim().startsWith('#')&&terminal.body.length<1200?text(terminal.body):null)
  ??'本轮未完成，请查看执行过程中的失败回执。'):null;
 return {status,goal,summary:completed?outcomeEvents.map(e=>text(e.metadata.summary)).find(Boolean)??text(presentation?.summary):null,
  reportMarkdown,recommendationsMarkdown:reportMarkdown?reportSection(reportMarkdown,[/改进建议|修改建议|建议行动|建议方案/,/结论与建议|结论和建议/]):null,
  nextStepsMarkdown:reportMarkdown?reportSection(reportMarkdown,[/下一步|下一轮|后续计划/]):null,
  diagnosticMarkdown:failed&&rawReport&&rawReport!==failureReason?rawReport:null,
  failureReason,processErrorCount:processErrors.length};
}
