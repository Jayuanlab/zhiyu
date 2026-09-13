import {sql} from 'drizzle-orm';
import type {WorkshopWriteContext} from './service';

/** Caller holds the Work lock and has established an immutable send outcome. */
export async function closeTerminalOutboxReviews(ctx:WorkshopWriteContext,input:{workId:string;outboxId:string;attemptId?:string|null}){
  const resolution={source:'outbox_terminal',outboxId:input.outboxId,attemptId:input.attemptId??null};
  const rows=await ctx.db.execute(sql`UPDATE workshop_review_items r SET status='superseded',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),metadata=metadata||jsonb_build_object('resolution',${JSON.stringify(resolution)}::jsonb) WHERE r.workshop_id=${input.workId}::uuid AND r.status='pending' AND r.kind IN ('service_error','permission_boundary') AND (r.metadata->>'outboxId'=${input.outboxId} OR EXISTS (SELECT 1 FROM workshop_events e WHERE e.id=r.source_event_id AND e.workshop_id=r.workshop_id AND e.metadata->>'outboxId'=${input.outboxId})) RETURNING r.id`);
  if(rows.length)await ctx.append({workshopId:input.workId,type:'outbox_reviews_resolved',title:'发信核实相关审核项已收敛',metadata:{...resolution,reviewItemIds:rows.map((row:{id:string})=>row.id)}});
}
