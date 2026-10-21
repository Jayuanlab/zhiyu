import {createHash} from 'node:crypto';
import {canonicalCommandJson} from '@/lib/work-runtime/command-payload';
import {isMemoryApplicabilityHash,memoryApplicabilityMatches} from "../kernel/runtime-applicability";
import { continuityRuntimeBindingMatches, isContinuityRuntimeBinding, type ContinuityRuntimeBinding } from './runtime-binding';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const MAX_CHECKPOINT_CHARS=8_000;
const MAX_AGE_MS=7*24*60*60*1000;
function questions(value:unknown){return Array.isArray(value)?[...new Set(value.filter((v):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=500))].slice(0,8):[];}

/** Progress is a recoverable estimate, never an approved fact or execution plan.
 * Keep the full authored checkpoint in the audit event; only bounded questions
 * and review conditions enter the next prompt. No automatic Brain promotion. */
export function prepareBusinessCheckpoint(input:{userId:string;workshopId:string;loopId:string;runId:string;report:unknown;verificationPassed:boolean;applicabilityHash?:string|null;runtimeBinding?:ContinuityRuntimeBinding|null;now?:Date}){
  const checkpoint=record(record(input.report).checkpoint);
  if(!Object.keys(checkpoint).length)return {status:'absent' as const};
  const bytes=JSON.stringify(checkpoint);
  if(bytes.length>MAX_CHECKPOINT_CHARS)return {status:'omitted' as const,reason:'business_checkpoint_budget',originalChars:bytes.length};
  if(input.applicabilityHash!==undefined&&!isMemoryApplicabilityHash(input.applicabilityHash))return {status:'omitted' as const,reason:'applicability_snapshot_unavailable'};
  if (input.runtimeBinding !== undefined && (!isContinuityRuntimeBinding(input.runtimeBinding)
    || input.runtimeBinding.userId !== input.userId || input.runtimeBinding.workshopId !== input.workshopId
    || input.runtimeBinding.loopId !== input.loopId || input.runtimeBinding.runId !== input.runId)) {
    return { status: 'omitted' as const, reason: 'continuity_binding_unavailable' };
  }
  const now=input.now??new Date();
  const nextQuestions=questions(checkpoint.nextQuestions??checkpoint.openQuestions);
  const pendingVerification=questions(checkpoint.pendingVerification);
  const progress={nextQuestions,pendingVerification,
    ...(typeof checkpoint.recheckWhen==='string'&&checkpoint.recheckWhen.length<=500?{recheckWhen:checkpoint.recheckWhen}:{}),
    ...(typeof checkpoint.timeWindow==='string'&&checkpoint.timeWindow.length<=200?{timeWindow:checkpoint.timeWindow}:{})};
  const state={schemaVersion:'loop-business-checkpoint.v1' as const,userId:input.userId,workshopId:input.workshopId,loopId:input.loopId,
    ...(Object.hasOwn(input,'applicabilityHash')?{applicabilityHash:input.applicabilityHash}:{}),
    ...(isContinuityRuntimeBinding(input.runtimeBinding) ? { runtimeBinding: input.runtimeBinding } : {}),
    sourceRunId:input.runId,createdAt:now.toISOString(),expiresAt:new Date(+now+MAX_AGE_MS).toISOString(),
    authority:'model-authored-unverified' as const,verificationPassed:input.verificationPassed,
    correctionPrecedence:'current-owner-and-brain-first' as const,recoveryScope:'questions-and-review-conditions-only' as const,
    checkpointHash:createHash('sha256').update(canonicalCommandJson(checkpoint as any)).digest('hex'),progress};
  const openQuestions=[...new Set([...nextQuestions,...pendingVerification])].slice(0,8);
  const summaryQuestions:string[]=[];for(const q of openQuestions){if(JSON.stringify([...summaryQuestions,q]).length>1800)break;summaryQuestions.push(q);}
  return {status:'saved' as const,state,checkpoint,openQuestions,
    memorySummary:`Unverified task progress; current owner instructions, current Brain revisions and permissions take priority. ${JSON.stringify(summaryQuestions)}`};
}

/** Invalid, expired or cross-scope state stays in the database audit trail but
 * cannot become input for a different controller. Inheritance never renews TTL. */
export function scopedBusinessCheckpoint(value:unknown,input:{userId:string;workshopId:string;loopId:string;applicabilityHash?:string|null;runtimeBinding?:ContinuityRuntimeBinding|null;now?:Date}){
  const c=record(value),now=+(input.now??new Date());
  if(c.schemaVersion!=='loop-business-checkpoint.v1'||c.userId!==input.userId||c.workshopId!==input.workshopId||c.loopId!==input.loopId
    ||!memoryApplicabilityMatches(c.applicabilityHash,input.applicabilityHash)
    ||c.authority!=='model-authored-unverified'||c.correctionPrecedence!=='current-owner-and-brain-first'
    ||c.recoveryScope!=='questions-and-review-conditions-only'||typeof c.createdAt!=='string'||typeof c.expiresAt!=='string'
    ||!Number.isFinite(Date.parse(c.createdAt))||Date.parse(c.createdAt)>now||Date.parse(c.expiresAt)<=now
    ||Date.parse(c.expiresAt)-Date.parse(c.createdAt)!==MAX_AGE_MS)return null;
  if (input.runtimeBinding !== undefined && (!continuityRuntimeBindingMatches(c.runtimeBinding, input.runtimeBinding,
    { userId: input.userId, workshopId: input.workshopId, loopId: input.loopId, runId: String(c.sourceRunId) }))) return null;
  return c;
}

export function verifyBusinessCheckpointReceipt(value:unknown,input:{userId:string;workshopId:string;loopId:string;applicabilityHash?:string|null;runtimeBinding?:ContinuityRuntimeBinding|null;now?:Date},event:unknown){
  const c=scopedBusinessCheckpoint(value,input),e=record(event),m=record(e.metadata);
  if(!c||typeof c.sourceRunId!=='string'||typeof c.receiptEventId!=='string'||e.id!==c.receiptEventId
    ||e.workshopId!==input.workshopId||e.loopId!==input.loopId||e.runId!==c.sourceRunId||e.loopRunId!==c.sourceRunId
    ||e.type!=='loop_business_checkpoint_saved'||m.receiptAuthority!=='runtime'||m.status!=='saved')return null;
  const {receiptEventId,...state}=c;
  if(canonicalCommandJson(state as any)!==canonicalCommandJson(m.state as any)
    ||createHash('sha256').update(canonicalCommandJson(record(m.checkpoint) as any)).digest('hex')!==c.checkpointHash)return null;
  return c;
}

/** Projection only, after the host verifies the full saved receipt. Historical
 * free-form progress/summary/conditions never become current conclusions. */
export function projectBusinessCheckpointQuestions(value: unknown) {
  const c = record(value), progress = record(c.progress);
  return { schemaVersion: c.schemaVersion, userId: c.userId, workshopId: c.workshopId, loopId: c.loopId,
    sourceRunId: c.sourceRunId, receiptEventId: c.receiptEventId, checkpointHash: c.checkpointHash,
    createdAt: c.createdAt, expiresAt: c.expiresAt, authority: 'model-authored-unverified' as const,
    recoveryScope: 'questions-only-no-source-verification' as const,
    correctionPrecedence: 'current-owner-and-brain-first' as const,
    ...(Object.hasOwn(c, 'applicabilityHash') ? { applicabilityHash: c.applicabilityHash } : {}),
    ...(isContinuityRuntimeBinding(c.runtimeBinding) ? { runtimeBinding: c.runtimeBinding } : {}),
    progress: { nextQuestions: questions(progress.nextQuestions), pendingVerification: questions(progress.pendingVerification) } };
}
