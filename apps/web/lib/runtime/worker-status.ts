import {sql,type SQL} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {runtimeMode} from './mode';
import type {RuntimeModuleState} from './module-supervisor';

export type RuntimeWorkerStatus={configuredMode:ReturnType<typeof runtimeMode>;state:'online'|'offline'|'unavailable';
  online:boolean|null;instanceId:string|null;instanceMode:string|null;phase:string|null;desiredStatus:string|null;
  heartbeatAt:string|null;heartbeatAgeMs:number|null;leaseUntil:string|null;modules:RuntimeModuleState[];warning:string|null};
const date=(value:unknown)=>value==null?null:new Date(value as string).toISOString();
export async function getRuntimeWorkerStatus(userId:string,execute:(query:SQL)=>Promise<any>=query=>db.execute(query)):Promise<RuntimeWorkerStatus>{
  const empty:RuntimeWorkerStatus={configuredMode:runtimeMode(),state:'unavailable',online:null,instanceId:null,instanceMode:null,
    phase:null,desiredStatus:null,heartbeatAt:null,heartbeatAgeMs:null,leaseUntil:null,modules:[],warning:null};
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId))return {...empty,warning:'runtime_identity_invalid'};
  try{
    const [row]=await execute(sql`SELECT i.id,i.mode,i.phase,i.desired_status,i.last_heartbeat_at,i.modules,l.lease_until,
      l.lease_until>clock_timestamp() AND i.phase NOT IN ('stopped','lost') AS online,
      GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-i.last_heartbeat_at))*1000)::double precision AS heartbeat_age_ms
      FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id AND i.owner_id=l.owner_id WHERE l.owner_id=${userId}::uuid`);
    if(!row)return {...empty,state:'offline',online:false,warning:'runtime_not_started'};
    if(!Array.isArray(row.modules))throw Error('invalid_runtime_modules');
    const modules=row.modules.map((module:RuntimeModuleState)=>({...module,lastError:module.lastError==null?null:
      /^[a-z][a-z0-9_]{0,100}$/.test(module.lastError)?module.lastError:'module_execution_failed'}));
    return {...empty,state:row.online?'online':'offline',online:Boolean(row.online),instanceId:row.id,instanceMode:row.mode,
      phase:row.phase,desiredStatus:row.desired_status,heartbeatAt:date(row.last_heartbeat_at),heartbeatAgeMs:Number(row.heartbeat_age_ms),
      leaseUntil:date(row.lease_until),modules,warning:row.online?null:'runtime_heartbeat_expired_or_stopped'};
  }catch{
    // Missing schema or database failure is unknown, never evidence of offline.
    return {...empty,warning:'runtime_status_unavailable'};
  }
}
