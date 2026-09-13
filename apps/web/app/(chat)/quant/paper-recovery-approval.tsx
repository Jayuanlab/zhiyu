"use client";
import {useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import type {PaperRecoveryDecision} from '@/lib/quant/paper-client';

type Review={reviewId:string;reviewHash:string;decision:'pending'|'approved'|'rejected';evidence:{review:{sourceHash:string;
  evidence:{balances:Record<string,string>};openingProposal:{baseline:{cashAdjustment:string;realizedPnlAdjustment:string;
    lots:Array<{lotId:string;code:string;quantity:number;costPrice:string;tradeDate:string}>}}}}};
const labels={historicalCashIncomplete:'我理解恢复前的现金流水不完整，期初差额不是新成交。',
  historicalPnlIncomplete:'我理解历史损益不完整，不能据此评价完整历史绩效。',
  preserveCurrentBalances:'我已核对，确认保留当前余额、持仓与现有成交，以该基线继续记录。'};
const button='rounded-md border px-3 py-2 disabled:opacity-50';

export function PaperRecoveryApproval({sourceHash}:{sourceHash:string}){
  const {data:session}=useSession();
  const owner=session?.user?.id;
  return owner?<OwnerApproval key={`${owner}:${sourceHash}`} owner={owner} sourceHash={sourceHash}/>:<p>主人身份加载完成后可进行审核。</p>;
}

function OwnerApproval({owner,sourceHash}:{owner:string;sourceHash:string}){
  const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [checks,setChecks]=useState<Record<string,boolean>>({});
  const [uncertain,setUncertain]=useState(false);
  const pending=useRef<PaperRecoveryDecision|null>(null);
  async function call(url:string,body?:unknown){
    const response=await fetch(url,{method:body===undefined?'GET':'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','X-Work-Actor':owner},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error==='identity_changed'?'身份已变化，请刷新页面重新核对。':
      value.error==='import_source_changed'?'账户快照已变化，请重新核对差异。':'审核服务暂不可用，请稍后查询或重试。');
    return value;
  }
  async function load(id:string){
    const value=await call(`/api/quant/paper/migration/reviews/${encodeURIComponent(id)}`) as Review;
    if(value.reviewId!==id||value.evidence?.review?.sourceHash!==sourceHash||!['pending','approved','rejected'].includes(value.decision))throw new Error('审核快照已变化，请重新核对差异。');
    setReview(value);
    return value;
  }
  async function prepare(){
    setBusy(true);setMessage('');
    try{
      const value=await call('/api/quant/paper/migration/reviews',{});
      await load(value.reviewId);
    }catch(error){setMessage(error instanceof Error?error.message:'核对失败');}
    finally{setBusy(false);}
  }
  async function query(){
    if(!review)return;
    setBusy(true);
    try{const value=await load(review.reviewId);setUncertain(value.decision==='pending');
      setMessage(value.decision==='pending'?'尚未查到决定，可用原命令重试。':'已找回保存的审核决定。');}
    catch(error){setMessage(error instanceof Error?error.message:'查询失败');}
    finally{setBusy(false);}
  }
  async function decide(decision:'approved'|'rejected'){
    if(!review||busy)return;
    const payload=pending.current??{commandId:crypto.randomUUID(),reviewHash:review.reviewHash,decision,acknowledgements:{...checks}};
    pending.current=payload;setBusy(true);setMessage('');
    try{
      await call(`/api/quant/paper/migration/reviews/${review.reviewId}`,payload);
      await load(review.reviewId);setUncertain(false);setMessage('审核决定已保存，账户尚未迁移。');
    }catch(error){setUncertain(true);setMessage(`${error instanceof Error?error.message:'请求未完成'} 请先查询确认结果。`);}
    finally{setBusy(false);}
  }
  const baseline=review?.evidence.review.openingProposal.baseline;
  return <div className="space-y-3 border-t pt-3" aria-label="恢复基线主人审核">
    {!review?<button type="button" className={button} disabled={busy} onClick={()=>void prepare()}>{busy?'正在核实来源…':'核实来源并打开审核'}</button>:<>
      <p>历史仓位来源已核对。以下为将保留的恢复基线；确认仅保存审核决定，停写、备份与正式导入仍须完成。</p>
      <p>当前现金：{review.evidence.review.evidence.balances.cash} 元；冻结：{review.evidence.review.evidence.balances.frozen_cash} 元。</p>
      <p>期初现金差额：{baseline?.cashAdjustment} 元；期初损益差额：{baseline?.realizedPnlAdjustment} 元。</p>
      <details><summary className="cursor-pointer">查看 {baseline?.lots.length} 个恢复成本批次</summary>
        <ul className="space-y-2 py-2">{baseline?.lots.map(lot=><li key={lot.lotId}>{lot.code} · {lot.quantity} 股 · 成本 {lot.costPrice} 元 · {lot.tradeDate}</li>)}</ul>
      </details>
      {review.decision==='pending'?<>
        <fieldset disabled={busy||uncertain} className="space-y-2"><legend className="font-medium">逐项核对后确认</legend>
          {Object.entries(labels).map(([key,label])=><label key={key} className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={checks[key]===true} onChange={event=>setChecks(value=>({...value,[key]:event.target.checked}))}/><span>{label}</span></label>)}
        </fieldset>
        {uncertain?<div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void query()}>查询确认结果</button>
          <button type="button" className={button} disabled={busy} onClick={()=>void decide(pending.current!.decision)}>用原命令重试</button></div>:
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy||!Object.keys(labels).every(key=>checks[key]===true)} onClick={()=>void decide('approved')}>确认恢复基线</button>
            <button type="button" className={button} disabled={busy} onClick={()=>void decide('rejected')}>拒绝此基线</button></div>}
      </>:<p role="status">{review.decision==='approved'?'恢复基线已确认；账户尚未迁移。':'此基线已拒绝，不会据此迁移。'}</p>}
    </>}
    {message?<p role="status">{message}</p>:null}
  </div>;
}
