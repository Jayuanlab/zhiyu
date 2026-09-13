type Log={evidenceReadAudit?:unknown};
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function summarizeEvidenceQuality(logs:Log[]){
  const statuses={executed:0,degraded:0,failed:0,skipped:0};
  let audited=0,missing=0,invalid=0,requested=0,resolved=0,unresolved=0,notChecked=0,memoriesWithoutRefs=0;
  for(const log of logs){
    if(log.evidenceReadAudit===undefined||log.evidenceReadAudit===null){missing++;continue;}
    const audit=record(log.evidenceReadAudit),quality=record(audit.quality);
    const values=['requested','resolved','unresolved','notChecked','memoriesWithoutRefs'].map(key=>quality[key]);
    const validCounts=values.every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0);
    if(!validCounts||!Object.hasOwn(statuses,String(audit.status))||typeof quality.checkedAt!=='string'||!Number.isFinite(Date.parse(quality.checkedAt))){invalid++;continue;}
    const [total,yes,no,unchecked,noRefs]=values as number[];
    if(total!==yes+no+unchecked||(audit.status==='executed'&&(no+unchecked+noRefs>0))||(audit.status==='skipped'&&total!==0)) {invalid++;continue;}
    audited++;statuses[audit.status as keyof typeof statuses]++;
    requested+=total;resolved+=yes;unresolved+=no;notChecked+=unchecked;memoriesWithoutRefs+=noRefs;
  }
  return {
    scope:'sampled_context_logs' as const,sampledRecallCount:logs.length,auditedRecallCount:audited,missingAuditCount:missing,invalidAuditCount:invalid,statusCounts:statuses,
    requestedReferences:requested,resolvedReferences:resolved,unresolvedReferences:unresolved,notCheckedReferences:notChecked,memoriesWithoutRefs,
    auditCoverage:logs.length?audited/logs.length:null,
    resolvedReferenceRate:requested?resolved/requested:null,
    resolutionDenominator:requested,
    interpretation:'Counts describe recorded evidence checks in sampled recall logs, not factual accuracy or recall precision. Missing/invalid audits are excluded from reference totals; an empty denominator has no rate.',
  };
}
