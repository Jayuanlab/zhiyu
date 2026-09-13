export function isOutboxUnsettled(status:string){return status==='sending'||status==='unknown';}
export function isOutboxLocked(status:string){return status==='rejected'||status==='sent'||status==='failed'||isOutboxUnsettled(status);}
export function canDismissOutbox(status:string){return ['draft','previewed','pending','needs_approval','pending_approval','approved','blocked'].includes(status);}
export function outboxStatusLabel(status:string,boundaryResult?:Record<string,unknown>){
  if(status==='rejected'&&boundaryResult?.ownerDismissal)return '已结束 · 不再发送';
  if(status==='failed'&&(boundaryResult?.resolution as Record<string,unknown>|undefined)?.decision==='not_sent')return '已核实未发送';
  const labels:Record<string,string>={draft:'草稿',previewed:'已预览',pending:'待处理',needs_approval:'待审核',pending_approval:'待审核',approved:'已审核',blocked:'边界阻止',sending:'正在发送',unknown:'发送结果待核对',sent:'已发送',failed:'发送失败',rejected:'已拒绝'};
  return labels[status]??status;
}
