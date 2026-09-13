'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Button} from '@openzhiyu/ui';
import {createWorkCommandClient,type PendingWorkRequest} from '@/lib/work-runtime/client-command';
import {LegacyExecutionReviewPanel,type LegacyExecution,type LegacyReviewDecision} from './legacy-execution-review-panel';

type Preview={snapshotHash:string;blockers:string[];source:{loop:{workshopId:string|null;status:string};legacyJob?:{executions?:LegacyExecution[];name:string;description:string|null;scheduleType:string;cronExpression:string|null;intervalMinutes:number|null;scheduledAt:string|null;timezone:string;hasCustomHandler:boolean;hasCharacterContext:boolean;hasModelOverrides:boolean}|null};proposed:{name:string;mission:string;boundaryPolicy:{externalMessages:string};effectivePolicies:{actionPolicy:{allowed?:string[];requiresApproval?:string[];denied?:string[]};metadata:{movedAllowedExternalActions:string[]}}}};
type Receipt={workId:string;loopId:string;status:'paused';snapshotHash:string};
type CommandReceipt=Receipt|{executionId:string;reviewedAt:string;outcome:string};
const blockerLabels:Record<string,string>={already_owned:'任务已归属车间，无需再次迁移。',unsupported_status:'请先处理任务的异常或归档状态。',legacy_scheduled_job:'旧定时任务需先转换执行配置，当前不可迁移。',unfinished_run:'仍有运行未结束或需要核对，请先处理。',unresolved_approval:'仍有待审核或待继续的审批，请先处理。'};
Object.assign(blockerLabels,{legacy_source_missing:'无法确认所属旧任务，请先核对来源。',legacy_execution_unfinished:'旧执行仍未结束，请先停止并核对结果。',legacy_source_ambiguous:'同一旧任务对应多个 Loop，请先核对重复绑定。'});

export function LoopMigrationPanel({loopId,workshopId,onChanged}:{loopId:string;workshopId?:string|null;onChanged:()=>void}){
  const [preview,setPreview]=useState<Preview|null>(null),[stopped,setStopped]=useState(false);
  const [pending,setPending]=useState<PendingWorkRequest|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
  const [error,setError]=useState<string|null>(null),[receipt,setReceipt]=useState<Receipt|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [goal,setGoal]=useState(''),[mode,setMode]=useState('manual'),[minutes,setMinutes]=useState('15'),[cron,setCron]=useState('0 9 * * *'),[timezone,setTimezone]=useState('Asia/Shanghai'),[once,setOnce]=useState(''),[confirmed,setConfirmed]=useState(false);
  const initialized=useRef(false);
  const alive=useRef(false),client=useRef<ReturnType<typeof createWorkCommandClient>|null>(null),read=useRef<AbortController|null>(null);
  useEffect(()=>{
    let disposed=false;
    alive.current=true;
    try{
      client.current=createWorkCommandClient({storage:window.localStorage,fetch:window.fetch.bind(window),uuid:()=>crypto.randomUUID(),onPending:value=>{if(!disposed)setPending(value);}});
      client.current.pending().then(()=>{if(!disposed)setReady(true);}).catch(failure=>{if(!disposed)setError(failure.message);});
    }catch(failure){setError(failure instanceof Error?failure.message:'无法读取提交记录。');}
    return ()=>{disposed=true;alive.current=false;read.current?.abort();};
  },[]);
  async function checkPending(){
    if(busy||!client.current)return;setBusy(true);setError(null);
    try{await client.current.pending();if(alive.current)setReady(true);}
    catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:'无法核对提交状态。');}
    finally{if(alive.current)setBusy(false);}
  }
  async function inspect(force=false){
    if(busy&&!force)return;setBusy(true);setError(null);setNotice(null);setStopped(false);setConfirmed(false);setPreview(null);
    const controller=new AbortController();read.current=controller;
    try{
      const response=await fetch(`/api/loops/${loopId}/migration`,{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error(response.status===404?'任务已不存在或无法访问。':'无法读取迁移预检，请稍后重试。');
      const result=await response.json();if(alive.current){setPreview(result);if(!initialized.current&&result.source?.legacyJob){setGoal(result.source.legacyJob.description||result.proposed.mission);initialized.current=true;}}
    }catch(failure){if(alive.current&&!controller.signal.aborted)setError(failure instanceof Error?failure.message:'预检失败。');}
    finally{if(alive.current)setBusy(false);}
  }
  async function submit(recover=false){
    if(busy||!client.current)return;
    if(!recover&&(!preview||!stopped||blockers.length||(legacy&&(!confirmed||!validReplacement))))return;
    setBusy(true);setError(null);setNotice(null);
    try{
      const triggerConfig=mode==='cron'?{type:'cron',expression:cron,timezone}:mode==='interval'?{type:'interval',minutes:Number(minutes)}:mode==='once'?{type:'once',at:once?new Date(once).toISOString():''}:{type:'manual'};
      const result=recover?await client.current.recover<CommandReceipt>():await client.current.submit<Receipt>({url:`/api/loops/${loopId}/migration`,method:'POST',expectedVersion:0,body:{expectedSnapshotHash:preview!.snapshotHash,controllersStopped:true,...(legacy?{nativeReplacement:{goal,triggerConfig,confirmLegacyReplacement:true}}:{})}});
      if(!alive.current)return;
      if(result&&'loopId' in result&&result.loopId===loopId&&result.status==='paused'&&result.workId){setReceipt(result);setPreview(null);setStopped(false);}
      else if(result&&'executionId' in result){await inspect(true);setNotice('旧执行已核对并停用。请审核最新迁移预检。');}
      else setNotice('上次提交已核对，请查看对应任务的最新状态。');
      onChanged();
    }catch(failure){if(alive.current){setError(failure instanceof Error?failure.message:'迁移结果尚未确认。');setStopped(false);setConfirmed(false);}}
    finally{if(alive.current)setBusy(false);}
  }
  const owned=receipt?.workId??workshopId??preview?.source.loop.workshopId;
  async function reviewExecution(decision:LegacyReviewDecision){
    if(busy||pending||!ready||!client.current)return;setBusy(true);setError(null);
    try{
      const {executionId,...body}=decision;
      await client.current.submit<CommandReceipt>({url:`/api/loops/${loopId}/legacy-executions/${executionId}/review`,method:'POST',expectedVersion:0,body});
      if(alive.current){await inspect(true);setNotice('旧执行已核对并停用。请审核最新迁移预检。');onChanged();}
    }catch(failure){if(alive.current)setError(failure instanceof Error?failure.message:'核对提交尚未确认。');}
    finally{if(alive.current)setBusy(false);}
  }
  const policy=preview?.proposed.effectivePolicies.actionPolicy;
  const legacy=preview?.source.legacyJob;
  const blockers=preview?.blockers.filter(code=>code!=='legacy_scheduled_job'||!legacy)??[];
  const validReplacement=Boolean(goal.trim())&&goal.length<=8000&&(mode!=='interval'||(Number.isSafeInteger(Number(minutes))&&Number(minutes)>0))&&(mode!=='cron'||Boolean(cron.trim()&&timezone.trim()))&&(mode!=='once'||Boolean(once&&Number.isFinite(Date.parse(once))));
  function changed(){setConfirmed(false);setStopped(false);}
  return <section aria-label="迁入车间" className="min-w-0 max-w-full space-y-3 rounded-md border border-border p-4 [overflow-wrap:anywhere]">
    <h3 className="font-medium">{owned?'任务归属':'迁入车间'}</h3>
    {receipt?<p role="status">迁移已完成，提交时车间与任务均暂停，原历史已保留。请在车间查看当前状态并审核启用。</p>:owned?<p className="text-sm text-muted-foreground">此任务已归属车间，请在车间管理运行与权限。</p>:<p className="text-sm text-muted-foreground">将独立任务迁入一个暂停的新车间，保留任务、观测与运行历史。迁移后由车间统一管理执行。</p>}
    {owned&&<Link className="text-sm underline" href="/workshop">前往车间核对</Link>}
    {!ready&&error&&<Button variant="outline" disabled={busy} onClick={()=>void checkPending()}>重新检查提交状态</Button>}
    {pending&&<div role="status" className="space-y-2 rounded border p-3"><p>有一项提交尚未确认。请先核对原请求，避免重复操作。</p><Button variant="outline" disabled={busy} onClick={()=>void submit(true)}>核对上次提交</Button></div>}
    {!owned&&<p className="text-sm text-muted-foreground">独立任务的原生执行与自动调度已停用，请先迁入车间。</p>}
    {!owned&&!pending&&<Button variant="outline" disabled={busy||!ready} onClick={()=>void inspect()}>{busy?'处理中…':preview?'重新读取预检':'查看迁移预检'}</Button>}
    {preview&&!owned&&<div className="space-y-3 text-sm">
      <p>新车间：{preview.proposed.name}；车间与任务均暂停。原任务状态：{({active:'已启用',paused:'已暂停',archived:'已归档',error:'异常'} as Record<string,string>)[preview.source.loop.status]??'待核对'}。</p>
      <p>外部写入：{preview.proposed.boundaryPolicy.externalMessages==='blocked'?'保持禁止':'需要主人审批'}。</p>
      <dl className="space-y-2 break-words">
        <div><dt className="font-medium">允许的动作</dt><dd>{policy?.allowed?.join('、')||'无'}</dd></div>
        <div><dt className="font-medium">需要审批的动作</dt><dd>{policy?.requiresApproval?.join('、')||'无'}</dd></div>
        <div><dt className="font-medium">禁止的动作</dt><dd>{policy?.denied?.join('、')||'无'}</dd></div>
      </dl>
      {preview.proposed.effectivePolicies.metadata.movedAllowedExternalActions.length>0&&<p>原自动外部动作已收紧：{preview.proposed.effectivePolicies.metadata.movedAllowedExternalActions.join('、')}。</p>}
      {legacy&&<fieldset disabled={busy||!!pending} className="min-w-0 space-y-3 rounded border p-3">
        <legend className="px-1 font-medium">审核旧任务转换</legend>
        <p>旧任务：{legacy.name}；原触发配置：{legacy.cronExpression||legacy.scheduledAt||(legacy.intervalMinutes?`每 ${legacy.intervalMinutes} 分钟`:legacy.scheduleType)}；时区：{legacy.timezone}。</p>
        <p>旧任务包含：{[legacy.hasCustomHandler?'自定义处理器':null,legacy.hasCharacterContext?'角色上下文':null,legacy.hasModelOverrides?'模型覆盖':null].filter(Boolean).join('、')||'普通任务配置'}。这些配置与旧聊天历史不会自动带入新执行器，请在新说明中补全所需上下文。</p>
        <label className="block space-y-1"><span>新任务说明</span><textarea className="block min-h-28 w-full rounded border bg-background p-2" maxLength={8000} value={goal} onChange={event=>{setGoal(event.target.value);changed();}} /></label>
        <label className="block space-y-1"><span>新触发方式</span><select className="block w-full rounded border bg-background p-2" value={mode} onChange={event=>{setMode(event.target.value);changed();}}><option value="manual">手动触发</option><option value="interval">固定间隔</option><option value="cron">定时表达式</option><option value="once">指定时间一次</option></select></label>
        {mode==='interval'&&<label className="block space-y-1"><span>间隔分钟</span><input className="block w-full min-w-0 rounded border bg-background p-2 sm:max-w-48" type="number" min="1" step="1" value={minutes} onChange={event=>{setMinutes(event.target.value);changed();}} /></label>}
        {mode==='cron'&&<><label className="block">定时表达式<input className="block w-full rounded border bg-background p-2" value={cron} onChange={event=>{setCron(event.target.value);changed();}} /></label><label className="block">时区<input className="block w-full rounded border bg-background p-2" value={timezone} onChange={event=>{setTimezone(event.target.value);changed();}} /></label></>}
        {mode==='once'&&<label className="block">执行时间（本机时区）<input className="block w-full rounded border bg-background p-2" type="datetime-local" value={once} onChange={event=>{setOnce(event.target.value);changed();}} /></label>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} /><span>我已审核新任务说明与触发方式，同意替换旧执行逻辑并停用旧任务。</span></label>
      </fieldset>}
      {legacy?.executions?.map(execution=><LegacyExecutionReviewPanel key={`${execution.id}:${execution.snapshotHash}`} execution={execution} disabled={busy||!!pending||!ready} onReview={decision=>void reviewExecution(decision)} />)}
      {blockers.length>0?<ul role="alert" className="list-disc pl-5">{blockers.map(code=><li key={code}>{blockerLabels[code]??'存在未处理状态，暂不可迁移。'}</li>)}</ul>:<>
        <label className="flex items-start gap-2"><input type="checkbox" checked={stopped} disabled={busy||!!pending} onChange={event=>setStopped(event.target.checked)}/><span>我已停止此任务的旧执行器与调度进程，并核对没有进行中的外部动作。</span></label>
        <Button disabled={busy||!!pending||!ready||!stopped||Boolean(legacy&&(!confirmed||!validReplacement))} onClick={()=>void submit()}>迁入并保持暂停</Button>
      </>}
    </div>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
