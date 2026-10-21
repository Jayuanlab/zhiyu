import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {closeDb} from '@/lib/db/adapters';
import {createLocalOwnerMemoryClient} from '@/lib/memory/client';
import type {Identity} from '../../../../packages/memory/src/ports';
import {MemoryModuleError} from '@/lib/memory/kernel/errors';
import {createMemoryCandidate,reviewMemory} from '@/lib/memory/revision/writes';
import {reviseBrainMemory} from '@/lib/memory/revision/revision';
import {proposeBrainMemoryUpdate,decideBrainMemoryUpdate} from '@/lib/memory/revision/proposals';
import {buildBrainContextFromMemoryRequest} from '@/lib/memory/retrieval/recall';

/** Trusted deployment module. The generic service never imports this project by default. */
export async function createInstalledMemoryProject(){
 const owner=process.env.ZHIYU_MEMORY_SERVICE_OWNER;
 if(!owner||process.env.ZHIYU_MEMORY_CONNECTION_FILE)throw Error('service_owner_required_and_remote_recursion_forbidden');
 function identity(i:Identity){if(i.namespace.projectId!=='zhiyu'||i.namespace.tenantId!==owner||i.principalId!==owner)throw new MemoryModuleError('memory_access_denied',403,'Installed project identity mismatch');return owner!;}
 function legacy(fn:(input:any)=>Promise<unknown>){return{permission:'project.write',call:async(i:Identity,input:unknown)=>{
  const userId=identity(i);
  if(!input||typeof input!=='object'||Array.isArray(input)||'now'in input)throw new MemoryModuleError('invalid_memory_request',400,'Invalid legacy operation');
  const requester=(input as {requester?:any}).requester;
  if(!requester||requester.type!=='chat'||requester.userId!==userId)throw new MemoryModuleError('memory_access_denied',403,'Owner identity required');
  return fn({...input,requester:{...requester,userId,type:'chat'}});
 }};}
 return{
  capabilities:{id:'zhiyu.compatibility.v1',authoritativeStorage:'existing_zhiyu_postgres',operations:['owner.submit','owner.read','owner.explain','status','dispatch.authorize','legacy.candidate','legacy.review','legacy.revise','legacy.propose','legacy.decide','runtime.recall'],runtimeProofs:'host_project_adapter',automaticFallback:false},
  async ready(){await db.execute(sql`SELECT id FROM brain_memories LIMIT 0`);await db.execute(sql`SELECT id FROM memory_operation_receipts LIMIT 0`);},
  close:closeDb,
  operations:{
   'legacy.candidate':legacy(createMemoryCandidate),
   'legacy.review':legacy(reviewMemory),
   'legacy.revise':legacy(reviseBrainMemory),
   'legacy.propose':legacy(proposeBrainMemoryUpdate),
   'legacy.decide':legacy(decideBrainMemoryUpdate),
   'runtime.recall':{...legacy(buildBrainContextFromMemoryRequest),permission:'project.read'},
   'owner.submit':{permission:'project.write',call:async(i:Identity,input:unknown)=>createLocalOwnerMemoryClient(identity(i)).submit(input)},
   'owner.read':{permission:'project.read',call:async(i:Identity,input:unknown)=>createLocalOwnerMemoryClient(identity(i)).read(input)},
   'owner.explain':{permission:'project.read',call:async(i:Identity,input:unknown)=>createLocalOwnerMemoryClient(identity(i)).explain(input)},
   status:{permission:'project.read',call:async(i:Identity,input:unknown)=>{identity(i);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new MemoryModuleError('invalid_memory_request',400,'Empty status input required');return{ready:true,adapter:'zhiyu.compatibility.v1',pid:process.pid};}},
   'dispatch.authorize':{permission:'project.use',call:async(i:Identity,input:unknown)=>{identity(i);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new MemoryModuleError('invalid_memory_request',400,'Empty authorization input required');return{authorized:true,sourceProofRequired:true};}},
  },
 };
}
