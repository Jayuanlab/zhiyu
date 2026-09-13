import type {Sql} from 'postgres';
import type {RuntimeModuleState} from './module-supervisor';

export type HostLease={ownerId:string;instanceId:string;token:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(owner:string,instance:string){if(!uuid.test(owner)||!uuid.test(instance))throw Error('invalid_host_identity');}
function duration(ms:number){if(!Number.isSafeInteger(ms)||ms<1000||ms>300000)throw Error('invalid_host_lease_duration');}

/** A durable owner fence; domain command leases still guard each external effect. */
export class RuntimeHostStore {
  constructor(private readonly sql:Sql){}
  async acquire(ownerId:string,instanceId:string,mode:'worker'|'embedded',ttlMs:number):Promise<HostLease|null>{
    identity(ownerId,instanceId);duration(ttlMs);
    ownerId=ownerId.toLowerCase();instanceId=instanceId.toLowerCase();
    if(!['worker','embedded'].includes(mode))throw Error('invalid_host_mode');
    return this.sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'runtime-host:'+ownerId},0))`;
      const [old]=await tx`SELECT *,lease_until>clock_timestamp() AS live FROM runtime_owner_leases WHERE owner_id=${ownerId} FOR UPDATE`;
      if(old?.live)return old.instance_id===instanceId?{ownerId,instanceId,token:old.token}:null;
      if(old)await tx`UPDATE runtime_instances SET phase='lost' WHERE id=${old.instance_id} AND phase!='stopped'`;
      await tx`INSERT INTO runtime_instances(id,owner_id,mode) VALUES (${instanceId},${ownerId},${mode})`;
      const token=(old?.token??0)+1;
      await tx`INSERT INTO runtime_owner_leases(owner_id,instance_id,token,lease_until)
        VALUES (${ownerId},${instanceId},${token},clock_timestamp()+${ttlMs}*interval '1 millisecond')
        ON CONFLICT(owner_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,token=EXCLUDED.token,lease_until=EXCLUDED.lease_until`;
      return {ownerId,instanceId,token};
    }) as Promise<HostLease|null>;
  }
  async heartbeat(lease:HostLease,ttlMs:number,modules:RuntimeModuleState[],desired:'running'|'paused'|'stopped'='running'){
    identity(lease.ownerId,lease.instanceId);duration(ttlMs);
    if(!['running','paused','stopped'].includes(desired))throw Error('invalid_host_desired_status');
    return this.sql.begin(async tx=>{
      const renewed=await tx`UPDATE runtime_owner_leases SET lease_until=clock_timestamp()+${ttlMs}*interval '1 millisecond'
        WHERE owner_id=${lease.ownerId} AND instance_id=${lease.instanceId} AND token=${lease.token} AND lease_until>clock_timestamp() RETURNING token`;
      if(!renewed.length)return false;
      await tx`UPDATE runtime_instances SET last_heartbeat_at=clock_timestamp(),modules=${this.sql.json(modules)},
        desired_status=${desired},phase=${desired==='stopped'?'stopping':'running'} WHERE id=${lease.instanceId} AND owner_id=${lease.ownerId}`;
      return true;
    });
  }
  async release(lease:HostLease,modules:RuntimeModuleState[]){
    identity(lease.ownerId,lease.instanceId);
    if(modules.some(module=>module.inFlight))throw Error('host_operations_unsettled');
    return this.sql.begin(async tx=>{
      const stopped=await tx`UPDATE runtime_owner_leases SET lease_until=clock_timestamp()
        WHERE owner_id=${lease.ownerId} AND instance_id=${lease.instanceId} AND token=${lease.token} AND lease_until>clock_timestamp() RETURNING token`;
      if(!stopped.length)return false;
      await tx`UPDATE runtime_instances SET phase='stopped',desired_status='stopped',stopped_at=clock_timestamp(),
        modules=${this.sql.json(modules)} WHERE id=${lease.instanceId} AND owner_id=${lease.ownerId}`;
      return true;
    });
  }
  async status(ownerId:string){
    if(!uuid.test(ownerId))throw Error('invalid_host_identity');
    const [row]=await this.sql`SELECT i.*,l.instance_id,l.token,l.lease_until,l.lease_until>clock_timestamp() AND i.phase!='stopped' AS online
      FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id AND i.owner_id=l.owner_id WHERE l.owner_id=${ownerId}`;
    return row??null;
  }
}
