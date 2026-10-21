"use client";

import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {Button} from '@openzhiyu/ui';

type Batch={id:string;userId:string;status:string;planHash:string;approvedAt:string|null;nextCursor:string|null;createdAt:string};
type Item={memoryId:string;status:string;changes:Record<string,string>;detail:{missingEvidence?:boolean|null;reason?:string;review?:{subject:string;contentPreview:string;scopeType:string;status:string}}};
type View={batch:Batch;items:Item[];counts:Record<string,number>;version:string};
type Command={action:string;batchId:string;planHash?:string;commandId?:string;expectedVersion?:string;cursor?:string;limit?:number};
const endpoint='/api/memory/backfill';
const statusNames:Record<string,string>={planned:'待审核',ready:'可继续执行',paused:'已暂停',completed:'本批已完成',partial:'部分完成，需核对冲突',rolling_back:'回退中',rolled_back:'本批已回退',rollback_partial:'部分回退，需核对冲突',pending:'待处理',applied:'已补索引',conflict:'来源已变更',error:'无法映射',skipped:'无需修改',cancelled:'已取消',rollback_conflict:'回退冲突'};
const kindNames:Record<string,string>={boundary:'边界',preference:'偏好',state:'状态',plan:'计划',commitment:'承诺',lesson:'经验',profile:'档案',fact:'事实'};
const errors:Record<string,string>={version_conflict:'批次已被其他操作更新，请核对最新状态后再操作。',plan_conflict:'计划已变化，请重新查看计划。',command_conflict:'操作编号与原请求不一致，请核对批次状态。',batch_not_found:'批次不存在或当前账号无权访问。',approval_required:'请先审核并批准本批计划。',unsupported_storage:'当前存储模式不支持此回填功能。',invalid_command:'操作参数无效，请刷新后重新核对。'};
class ApiError extends Error{constructor(public status:number,public code:string){super(errors[code]??'暂时无法确认操作结果，请保留原请求重试。');}}
async function api<T>(query='',command?:Command):Promise<T>{
  const response=await fetch(endpoint+query,{method:command?'POST':'GET',cache:'no-store',headers:command?{'Content-Type':'application/json'}:undefined,body:command?JSON.stringify(command):undefined,signal:AbortSignal.timeout(30000)});
  const body=await response.json();if(!response.ok)throw new ApiError(response.status,body.code??'unavailable');return body as T;
}
const key=(owner:string)=>`brain-backfill-command:v1:${owner}`;

export default function MemoryBackfillPage(){
  const [owner,setOwner]=useState(''),[batches,setBatches]=useState<Batch[]>([]),[truncated,setTruncated]=useState(false);
  const [view,setView]=useState<View|null>(null),[pending,setPending]=useState<Command|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[lookup,setLookup]=useState('');
  const [reviewed,setReviewed]=useState(false),[rollbackReview,setRollbackReview]=useState(false),[storageError,setStorageError]=useState(false);
  const lock=useRef(false),ownerRef=useRef('');
  function locate(id:string){const url=new URL(window.location.href);url.searchParams.set('batchId',id);window.history.replaceState(null,'',url);setLookup(id);}
  async function reload(id?:string){
    const list=await api<{userId:string;batches:Batch[];truncated:boolean}>();
    if(ownerRef.current&&ownerRef.current!==list.userId){setView(null);setPending(null);}
    ownerRef.current=list.userId;
    setOwner(list.userId);setBatches(list.batches);setTruncated(list.truncated);
    let saved:Command|null=null;
    try{const text=sessionStorage.getItem(key(list.userId));if(text){const value=JSON.parse(text);if(!value||typeof value.batchId!=='string'||typeof value.action!=='string')throw Error('Invalid saved command');saved=value;}setStorageError(false);}
    catch{setStorageError(true);setError('无法读取本标签页的恢复记录，已暂停新操作。请检查浏览器存储设置。');}
    setPending(saved);
    const target=id??saved?.batchId??new URL(window.location.href).searchParams.get('batchId');
    setReviewed(false);setRollbackReview(false);
    if(target){locate(target);const next=await api<View>(`?batchId=${encodeURIComponent(target)}`);setView(next);}
    else setView(null);
  }
  async function refresh(id?:string){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    if(id&&id!==view?.batch.id)setView(null);
    try{await reload(id);}catch(e){setError(e instanceof ApiError&&e.status!==503?e.message:e instanceof ApiError&&e.code==='unsupported_storage'?e.message:'读取失败，当前展示可能已过期，请刷新重试。');}
    finally{lock.current=false;setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  async function execute(command:Command){
    if(lock.current||!owner||storageError)return;lock.current=true;setBusy(true);setError('');setNotice('');
    let written=false;
    try{
      sessionStorage.setItem(key(owner),JSON.stringify(command));written=true;setPending(command);locate(command.batchId);
      await api('',command);
      sessionStorage.removeItem(key(owner));setPending(null);setNotice('操作已收到回执，以下为重新读取的当前状态。');
      await reload(command.batchId);
    }catch(e){
      if(e instanceof ApiError&&[400,401,403,404,409].includes(e.status)){
        try{sessionStorage.removeItem(key(owner));setPending(null);}catch{setStorageError(true);}
      }
      if(!written){setStorageError(true);setError('无法保存恢复记录，操作尚未发送。请检查浏览器存储设置。');}
      else setError(e instanceof ApiError?e.message:'连接中断，结果尚未确认。请重试原请求或刷新状态，避免另建重复操作。');
      setReviewed(false);setRollbackReview(false);
    }finally{lock.current=false;setBusy(false);}
  }
  const disabled=busy||!!pending||storageError||!owner||!!error;
  const action=(name:string)=>{
    if(!view)return;
    void execute({action:name,batchId:view.batch.id,planHash:view.batch.planHash,commandId:crypto.randomUUID(),...(['approve','pause','resume'].includes(name)?{expectedVersion:view.version}:{limit:20})});
  };
  const prepare=(cursor?:string)=>{setView(null);void execute({action:'prepare',batchId:crypto.randomUUID(),limit:100,...(cursor?{cursor}:{})});};
  const batch=view?.batch;
  return <main className="h-full overflow-y-auto bg-background text-foreground">
    <div className="mx-auto grid max-w-5xl gap-5 px-5 py-6">
      <Link href="/memory" className="w-fit text-sm underline">返回统一记忆召回</Link>
      <header><h1 className="text-2xl font-semibold">记忆索引维护</h1><p className="mt-2 text-sm text-muted-foreground">为旧记忆补齐分类与分组索引。保留原文、原有时间和确认状态；补索引不代表事实已确认，也不代表来源证据已核实。</p></header>
      {busy&&<p role="status">正在读取或处理，请稍候…</p>}
      {error&&<p role="alert" aria-label="回填状态警告" className="rounded border border-destructive p-3 text-sm">{error}</p>}
      {notice&&<p role="status" className="text-sm">{notice}</p>}
      {pending&&<section aria-label="待确认操作" className="grid gap-2 rounded border p-4"><p>有一条操作尚待确认。重新发送会使用原编号，不会重复推进。</p><p className="break-all text-xs text-muted-foreground">批次：{pending.batchId}</p><Button disabled={busy||storageError} onClick={()=>void execute(pending)}>重试原请求</Button></section>}
      <div className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={()=>prepare()}>生成回填预览</Button><Button variant="outline" disabled={busy} onClick={()=>void refresh()}>刷新当前状态</Button></div>
      <section aria-label="已有回填批次" className="grid gap-3 rounded border p-4">
        <h2 className="font-medium">已有批次</h2><p className="text-sm text-muted-foreground">最近 50 个批次。{truncated?'还有更早批次，可用批次编号打开。':'可继续之前的审核或执行。'}</p>
        <label className="grid gap-1 text-sm">选择批次<select className="min-w-0 rounded border bg-background p-2" value={batches.some(item=>item.id===batch?.id)?batch?.id:''} disabled={busy||!!pending} onChange={e=>{if(e.target.value)void refresh(e.target.value);}}><option value="">选择已有批次</option>{batches.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {statusNames[item.status]??item.status} · {item.id.slice(0,8)}</option>)}</select></label>
        <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void refresh(lookup.trim());}}><label className="grid min-w-0 flex-1 gap-1 text-sm">批次编号<input className="min-w-0 rounded border bg-background p-2" value={lookup} onChange={e=>setLookup(e.target.value)} /></label><Button variant="outline" disabled={busy||!!pending||!lookup.trim()}>打开批次</Button></form>
      </section>
      {view&&batch&&<section aria-label="回填计划" className="grid gap-4 rounded border p-4">
        <h2 className="font-medium">当前批次：{statusNames[batch.status]??batch.status}</h2><p className="break-all text-xs text-muted-foreground">{batch.id}</p>
        <div className="flex flex-wrap gap-3 text-sm">{Object.entries(view.counts).map(([name,count])=><span key={name}>{statusNames[name]??name}：{count}</span>)}<span>缺证据：{view.items.filter(item=>item.detail.missingEvidence===true).length}</span><span>证据可达性：未核实</span></div>
        <p className="text-sm text-muted-foreground">以下是生成计划时的样本，执行前会再次核对原记录。来源变化会跳过，回退也会保留后续用户纠错。每次执行或回退最多处理 20 条。</p>
        <div className="max-h-80 space-y-3 overflow-y-auto" aria-label="计划条目">{view.items.map(item=><article key={item.memoryId} className="rounded bg-muted/40 p-3 text-sm"><p className="font-medium break-words">{item.detail.review?.subject??'旧批次未保存样本标题'}</p><p className="mt-1 whitespace-pre-wrap break-words">{item.detail.review?.contentPreview??'请根据原记录编号核对。'}</p><p className="mt-2">{statusNames[item.status]??item.status} · 分类：{kindNames[item.changes.canonicalKind]??'保持原分类'} · {item.detail.missingEvidence?'缺少证据引用':'证据需另行核实'}</p><details className="mt-1 break-all text-xs text-muted-foreground"><summary>查看记录标识与映射详情</summary><p>{item.memoryId}</p><p>分组：{item.changes.canonicalGroupId??'保持原分组'}</p><p>原状态：{item.detail.review?.status??'未记录'}；范围：{item.detail.review?.scopeType??'未记录'}</p>{item.detail.reason&&<p>原因：{item.detail.reason}</p>}</details></article>)}</div>
        {(batch.status==='planned'||(batch.status==='paused'&&!batch.approvedAt))&&<><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>我已核对本批计划，同意仅补分类与分组索引。</label><Button disabled={disabled||!reviewed} onClick={()=>action('approve')}>批准本批计划</Button></>}
        <div className="flex flex-wrap gap-2">
          {batch.status==='ready'&&<Button disabled={disabled} onClick={()=>action('apply')}>执行下一段</Button>}
          {['planned','ready'].includes(batch.status)&&<Button variant="outline" disabled={disabled} onClick={()=>action('pause')}>暂停本批</Button>}
          {batch.status==='paused'&&batch.approvedAt&&<Button disabled={disabled} onClick={()=>action('resume')}>恢复本批</Button>}
          {batch.nextCursor&&['completed','partial'].includes(batch.status)&&<Button variant="outline" disabled={disabled} onClick={()=>prepare(batch.nextCursor!)}>预览后续记录</Button>}
        </div>
        {batch.approvedAt&&['ready','paused','completed','partial','rolling_back'].includes(batch.status)&&<details><summary className="cursor-pointer text-sm">回退本批修改</summary><label className="my-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={rollbackReview} onChange={e=>setRollbackReview(e.target.checked)}/>我理解回退会取消本批未处理项，仅恢复本批写入且未被后续修改的索引。</label><Button variant="outline" disabled={disabled||!rollbackReview} onClick={()=>action('rollback')}>回退下一段</Button></details>}
      </section>}
    </div>
  </main>;
}
