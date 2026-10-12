import {workCommandChildId} from './child-id';
import {resolveExecutionLease} from './execution-context';
import {knownWorkshopRuntimeFailureMessage} from '@/lib/workshops/runtime-failure';

export const CHAT_DELIVERY_STATUSES = ['completed','failed','interrupted','cancelled','needs_review'] as const;
export type ChatDeliveryRunStatus = typeof CHAT_DELIVERY_STATUSES[number];
export type ChatDeliveryResult = {state:'delivered'|'replayed'|'blocked'|'failed';deliveryId:string;errorCode?:string};
export type ChatDeliveryCycle = {seeded:number;delivered:number;replayed:number;blocked:number;failed:number};
export type ChatDeliveryDependencies = {
  seed:(ownerId:string,limit:number)=>Promise<number>;
  next:(ownerId:string)=>Promise<ChatDeliveryResult|null>;
};
export type ChatRunDeliveryMessage = {
  deliveryId:string;messageId:string;workshopId:string;runId:string;workshopName:string;
  sourceMessageId:string|null;status:ChatDeliveryRunStatus;needsInput:boolean;
  clarification?:string|null;summary?:string|null;
  runtimeFailure?:unknown;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function literalMarkdown(value:string){return value.replace(/[\\`*_{}\[\]()<>#+!|~]/g,'\\$&');}
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

/** The store rebinds this interpretation to persisted host receipts. Preview
 * only its issue list, never raw runtime errors, model output, or prompts. */
function chatResearchFailurePreview(value:unknown,runId:string){
  const failure=record(value);
  if(failure.version!=='workshop-runtime-failure/v1'||failure.receiptAuthority!=='runtime'||failure.runId!==runId
    ||failure.code!=='research_final_validation_rejected'||typeof failure.validationEventId!=='string'||!UUID.test(failure.validationEventId)
    ||!Number.isSafeInteger(failure.attempt)||(failure.attempt as number)<0||(failure.attempt as number)>2
    ||!Array.isArray(failure.issues)||failure.issues.length<1||failure.issues.length>20
    ||!failure.issues.every(issue=>typeof issue==='string'&&Boolean(issue.trim())&&issue.length<=1200))return '';
  return chatDeliveryPreview(failure.issues.join('\n'),800);
}

function chatKnownProcessFailurePreview(value:unknown,runId:string){
  const failure=record(value);
  if(failure.version!=='workshop-runtime-failure/v1'||failure.receiptAuthority!=='runtime'||failure.runId!==runId
    ||failure.code!=='agent_runtime_failed'||typeof failure.runtimeEventId!=='string'||!UUID.test(failure.runtimeEventId))return '';
  const fixedMessage=knownWorkshopRuntimeFailureMessage(failure.runtimeError);
  return fixedMessage?chatDeliveryPreview(fixedMessage,800):'';
}

/** A small literal-text preview; source records remain available through the
 * fixed result link. Never publish raw errors or credential-shaped values. */
export function chatDeliveryPreview(value:string|null|undefined,limit:number){
  if(!value)return '';
  const text=value.slice(0,8192)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,'[已隐藏密钥]')
    .replace(/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})\b/gi,'[已隐藏凭据]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi,'Bearer [已隐藏凭据]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|密码|密钥|令牌)["']?\s*[:=：]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;，；]+)/gi,'$1[已隐藏凭据]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏凭据]@')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'')
    .replace(/\r\n?/g,'\n').trim();
  return literalMarkdown(text.length>limit?`${text.slice(0,limit)}…`:text);
}

export function chatRunDeliveryIds(ownerId:string,workshopId:string,runId:string,status:ChatDeliveryRunStatus){
  if(![ownerId,workshopId,runId].every(value=>UUID.test(value))||!CHAT_DELIVERY_STATUSES.includes(status))throw Error('invalid_chat_delivery');
  return {
    deliveryId:workCommandChildId(ownerId,workshopId,runId.toLowerCase(),`chat-delivery:${status}`),
    messageId:workCommandChildId(ownerId,workshopId,runId.toLowerCase(),`chat-delivery-message:${status}`),
  };
}

/** A notification describes persisted execution facts, never owner acceptance.
 * Keep raw executor errors and arbitrary output out of automatic messages. */
export function buildChatRunDeliveryMessage(input:ChatRunDeliveryMessage){
  if(![input.workshopId,input.runId].every(value=>UUID.test(value)))throw Error('invalid_chat_delivery');
  const name=chatDeliveryPreview(input.workshopName.replace(/[\r\n]/g,' '),160)||'车间';
  const needsInput=input.status==='completed'&&input.needsInput;
  const failurePreview=input.status==='failed'?chatResearchFailurePreview(input.runtimeFailure,input.runId):'';
  const processFailurePreview=input.status==='failed'?chatKnownProcessFailurePreview(input.runtimeFailure,input.runId):'';
  const description=failurePreview?'研究报告未通过核验，本轮未完成。尚未自动重试。':needsInput?'需要你补充信息，本事项尚未完成。':{
    completed:'本轮运行已完成，结果与验收状态可在车间查看。',
    failed:'本轮运行未完成。请查看失败原因与恢复入口，尚未自动重试。',
    interrupted:'本轮运行已中断。请查看当前结果与恢复入口，尚未自动重试。',
    cancelled:'本轮运行已取消。取消不代表已发生的效果被撤销。',
    needs_review:'本轮结果需要核对。核对完成前不会自动重试。',
  }[input.status];
  const workHref=`/workshop?workId=${input.workshopId}`;
  const resultHref=`${workHref}&tab=run&runId=${input.runId}`;
  const preview=needsInput?chatDeliveryPreview(input.clarification,800)
    :input.status==='completed'?chatDeliveryPreview(input.summary,600):'';
  const detail=failurePreview?`\n\n未通过原因：\n${failurePreview}`:processFailurePreview?`\n\n未完成原因：\n${processFailurePreview}`
    :preview?`\n\n${needsInput?'请补充：':'结果摘要：'}\n${preview}`:'';
  return {
    parts:[{type:'text',text:`${name}：${description}${detail}\n\n[查看车间](${workHref}) · [查看本轮结果](${resultHref})`}],
    attachments:[],
    metadata:{source:'workshop_result',workshopChatDelivery:{version:1,source:'workshop_result',deliveryId:input.deliveryId,workshopId:input.workshopId,
      runId:input.runId,sourceMessageId:input.sourceMessageId,status:input.status}},
  };
}

/** Notification retries have no business execution dependency and never change focus. */
export async function consumeOwnedChatDeliveries(
  input:{userId:string;limit?:number;signal?:AbortSignal},dependencies?:ChatDeliveryDependencies,
):Promise<ChatDeliveryCycle>{
  const limit=input.limit??20;
  if(!UUID.test(input.userId)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('invalid_chat_delivery');
  if(resolveExecutionLease())throw Error('A producer cannot deliver chat notifications');
  const result:ChatDeliveryCycle={seeded:0,delivered:0,replayed:0,blocked:0,failed:0};
  if(input.signal?.aborted)return result;
  const ownerId=input.userId.toLowerCase();
  const store:ChatDeliveryDependencies=dependencies??(await import('./chat-delivery-store')).chatDeliveryDependencies;
  result.seeded=await store.seed(ownerId,limit);
  for(let index=0;index<limit;index++){
    if(input.signal?.aborted)break;
    const delivered=await store.next(ownerId);
    if(!delivered)break;
    result[delivered.state]++;
  }
  return result;
}
