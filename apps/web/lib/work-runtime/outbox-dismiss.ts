import {and,eq,sql} from 'drizzle-orm';
import {workshops,workshopOutbox} from '@/lib/db/schema';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {closeTerminalOutboxReviews} from '@/lib/workshops/outbox-reviews';
import {canDismissOutbox} from '@/lib/workshops/outbox-view';
import {resolveExecutionLease} from './execution-context';
import {WorkCommandConflict} from './command-ledger';

/** Owner-only terminal decision. Never invokes the sender or deletes evidence. */
export async function dismissWorkOutbox(input:{userId:string;workId:string;outboxId:string;expectedUpdatedAt:string}){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(resolveExecutionLease()||![input.userId,input.workId,input.outboxId].every(x=>uuid.test(x))||!Number.isFinite(Date.parse(input.expectedUpdatedAt)))throw new WorkCommandConflict('invalid_command');
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.select({id:workshops.id}).from(workshops).where(and(eq(workshops.id,input.workId),eq(workshops.userId,input.userId))).for('update');
    if(!work)throw new WorkCommandConflict('not_found');
    const [item]=await db.select().from(workshopOutbox).where(and(eq(workshopOutbox.id,input.outboxId),eq(workshopOutbox.workshopId,work.id))).for('update');
    if(!item)throw new WorkCommandConflict('not_found');
    if(item.status==='rejected'&&item.boundaryResult?.ownerDismissal)return {outboxId:item.id,status:'rejected',replayed:true};
    if(!canDismissOutbox(item.status))throw new WorkCommandConflict('target_busy');
    const attempts=await db.execute(sql`SELECT id FROM workshop_outbox_attempts WHERE outbox_id=${item.id}::uuid LIMIT 1`);
    if(attempts[0])throw new WorkCommandConflict('target_busy');
    if(new Date(item.updatedAt).getTime()!==Date.parse(input.expectedUpdatedAt))throw new WorkCommandConflict('version_conflict');
    const at=new Date();
    await db.update(workshopOutbox).set({status:'rejected',updatedAt:at,boundaryResult:{...item.boundaryResult,ownerDismissal:{actorId:input.userId,at:at.toISOString(),previousStatus:item.status,reason:'owner_no_longer_wants_to_send'}}}).where(eq(workshopOutbox.id,item.id));
    await closeTerminalOutboxReviews({db,append},{workId:work.id,outboxId:item.id});
    await append({workshopId:work.id,type:'outbox_dismissed',title:'主人已选择不再发送',body:'保留草稿内容和原始拦截记录，不再作为待发事项。',metadata:{actorId:input.userId,outboxId:item.id,previousStatus:item.status,status:'rejected'}});
    return {outboxId:item.id,status:'rejected',replayed:false};
  });
}
