import type {Sql} from 'postgres';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PaperTickStore {
  constructor(private readonly sql:Sql){}
  async prepare(ownerId:string,accountId:string){
    if(!uuid.test(ownerId)||!uuid.test(accountId))throw Error('invalid_paper_tick_identity');
    ownerId=ownerId.toLowerCase();accountId=accountId.toLowerCase();
    return this.sql.begin(async tx=>{
      await tx`INSERT INTO runtime_paper_ticks(owner_id,account_id) VALUES (${ownerId},${accountId}) ON CONFLICT DO NOTHING`;
      const [row]=await tx`SELECT *,next_tick_at<=clock_timestamp() AS due FROM runtime_paper_ticks WHERE owner_id=${ownerId} AND account_id=${accountId} FOR UPDATE`;
      if(row.status==='pending')return String(row.command_id);
      if(!row.due)return null;
      const sequence=Number(row.sequence)+1,commandId=`paper-tick:${accountId}:${sequence}`;
      await tx`UPDATE runtime_paper_ticks SET sequence=${sequence},command_id=${commandId},status='pending',receipt=NULL,updated_at=clock_timestamp() WHERE owner_id=${ownerId} AND account_id=${accountId}`;
      return commandId;
    }) as Promise<string|null>;
  }
  async complete(ownerId:string,accountId:string,commandId:string,receipt:unknown){
    const rows=await this.sql`UPDATE runtime_paper_ticks SET status='completed',receipt=${this.sql.json(receipt as any)},next_tick_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
      WHERE owner_id=${ownerId} AND account_id=${accountId} AND command_id=${commandId} AND status='pending' RETURNING command_id`;
    return rows.length===1;
  }
}
