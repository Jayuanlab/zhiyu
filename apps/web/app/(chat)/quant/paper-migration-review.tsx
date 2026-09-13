"use client";

import { useState } from 'react';
import useSWR from 'swr';
import {PaperRecoveryApproval} from './paper-recovery-approval';

async function fetchReview(url:string) {
  const response = await fetch(url, {cache:'no-store'});
  if (!response.ok) throw new Error('账户核对暂不可用，请检查量化服务及主人身份配置后重试。');
  return response.json();
}

export function PaperMigrationReview() {
  const [opened, setOpened] = useState(false);
  const {data, error, isLoading, isValidating, mutate} = useSWR(opened ? '/api/quant/paper/migration/review' : null, fetchReview,
    {revalidateOnFocus:false, shouldRetryOnError:false});
  return <section aria-label="模拟账户迁移核对" className="rounded-md border border-amber-500/40 bg-card p-4 text-sm space-y-3">
    <h2 className="font-medium">模拟账户待迁移，当前仅供查看</h2>
    <p>先核对历史余额与成交记录，再恢复交易。查看差异不会修改账户。</p>
    <button type="button" className="rounded-md border px-3 py-2 disabled:opacity-50" disabled={isValidating}
      onClick={()=>{if(opened) void mutate(); else setOpened(true);}}>
      {isValidating ? '正在核对…' : opened ? '重新核对' : '查看迁移差异'}
    </button>
    {isLoading ? <p role="status">正在读取账户快照…</p> : null}
    {error ? <p role="alert">{error.message}</p> : null}
    {data ? <div className="space-y-2" aria-live="polite">
      {error || isValidating ? <p>以下保留上次核对结果，当前源文件是否变化尚未确认。</p> : null}
      <p>{data.validation?.status === 'valid' ? '账本校验通过，尚未执行迁移。' : '历史账本尚未通过校验，需要核对恢复来源。'}</p>
      {data.evidence ? <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div><dt>未解释现金差额</dt><dd>{data.evidence.unexplainedCash} 元</dd></div>
        <div><dt>未解释已实现损益差额</dt><dd>{data.evidence.unexplainedRealizedPnl} 元</dd></div>
        <div><dt>订单 / 成交 / 成本批次</dt><dd>{data.evidence.counts.orders} / {data.evidence.counts.fills} / {data.evidence.counts.lots}</dd></div>
      </dl> : <p>快照结构不完整，暂时无法计算差额。</p>}
      <p>差额表示现有记录尚不能解释的部分，不代表确认亏损或需要补入的资金。完成来源核对和主人审核后，才能进行正式迁移。</p>
      <details><summary className="cursor-pointer">核对依据</summary><p className="break-all">源文件指纹：{data.sourceHash}</p><p className="break-all">报告指纹：{data.reviewHash}</p></details>
      {!error&&!isValidating&&data.openingProposal?.status==='needs_owner_review'?<PaperRecoveryApproval sourceHash={data.sourceHash}/>:null}
    </div> : null}
  </section>;
}
