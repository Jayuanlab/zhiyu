import {beginOutboxAttempt,settleOutboxAttempt,readOutboxAttempt} from './outbox-attempt';
import {previewWechatDesktopMessage,sendWechatDesktopMessage,getWechatDesktopSendStatus} from '@/lib/wechat-desktop/client';
import {resolveExecutionLease} from './execution-context';
import {withExecutionWrite} from './execution-lease';

type Target=Parameters<typeof beginOutboxAttempt>[0];
export type OutboxSendAdapter={
  preview:typeof previewWechatDesktopMessage;
  send:typeof sendWechatDesktopMessage;
  status:typeof getWechatDesktopSendStatus;
};
const adapter:OutboxSendAdapter={preview:previewWechatDesktopMessage,send:sendWechatDesktopMessage,status:getWechatDesktopSendStatus};

export async function reconcileOutboxAttempt(input:Parameters<typeof readOutboxAttempt>[0],provider:Pick<OutboxSendAdapter,'status'>=adapter){
  const attempt=await readOutboxAttempt(input);
  if(attempt.status==='sent')return attempt;
  const target={userId:input.userId,workId:input.workId,attemptId:attempt.id};
  try{
    const observed=await provider.status(attempt.id);
    const confirmed=observed.status==='sent'&&(observed.result?.ok===true||(observed.result?.ok===undefined&&observed.result?.sent===true));
    if(observed.ok===true&&confirmed&&observed.status==='sent')return await settleOutboxAttempt({...target,status:'sent',receipt:observed.result});
  }catch{/* A failed observation cannot authorize a resend. */}
  return settleOutboxAttempt({...target,status:'unknown',failurePhase:'recovery_unconfirmed'});
}

/** Database admission precedes external effects. Recovery only queries a stable
 * provider command; it never obtains another token and sends again. */
export async function dispatchOutboxAttempt(input:Target,provider:OutboxSendAdapter=adapter){
  const {dispatch,attempt}=await beginOutboxAttempt(input);
  const target={userId:input.userId,workId:input.workId,attemptId:attempt.id};
  if(attempt.status==='sent')return attempt;
  if(!dispatch){
    return reconcileOutboxAttempt(input,provider);
  }
  let phase='preview';
  try{
    const payload=attempt.payload as {recipientName:string;message:string};
    const preview=await provider.preview(payload);
    const lease=resolveExecutionLease();
    if(lease)await withExecutionWrite(lease,async()=>undefined);
    phase='send';
    const result=await provider.send({...payload,confirmToken:preview.confirmToken,commandId:attempt.id});
    if(result.ok!==true)throw Error('Provider did not confirm send');
    phase='persist_result';
    return await settleOutboxAttempt({...target,status:'sent',receipt:result});
  }catch{
    return settleOutboxAttempt({...target,status:'unknown',failurePhase:phase});
  }
}
