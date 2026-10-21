import {NextResponse} from 'next/server';
import { readBoundedJson } from "@/app/api/memory/_shared";
import { errorResponse } from "@/app/api/memory/owner-route-helpers";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import {z} from 'zod';
import {requireMemoryUser} from "@/app/api/memory/owner-route-helpers";
import { CanonicalBackfillError } from "@/lib/memory/kernel/canonical-backfill-errors";
import { prepareCanonicalBatch, listCanonicalBatches, readCanonicalBatch, controlCanonicalBatch, applyCanonicalBatchPage, rollbackCanonicalBatchPage } from "@/lib/memory/governance/canonical-backfill";

export const dynamic='force-dynamic';
const identity={batchId:z.string().uuid()};
const plan={...identity,planHash:z.string().regex(/^[a-f0-9]{64}$/)};
const control={...plan,commandId:z.string().uuid(),expectedVersion:z.string().regex(/^\d{1,20}$/)};
const operation={...plan,commandId:z.string().uuid(),limit:z.number().int().min(1).max(100).optional()};
const command=z.discriminatedUnion('action',[
  z.object({...identity,action:z.literal('prepare'),cursor:z.string().uuid().optional(),limit:z.number().int().min(1).max(500).optional()}).strict(),
  z.object({...control,action:z.literal('approve')}).strict(),
  z.object({...control,action:z.literal('pause')}).strict(),
  z.object({...control,action:z.literal('resume')}).strict(),
  z.object({...operation,action:z.literal('apply')}).strict(),
  z.object({...operation,action:z.literal('rollback')}).strict(),
]);
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
function failure(error:unknown){
  if(error instanceof MemoryModuleError || error instanceof SyntaxError)return errorResponse(error,"Backfill request unavailable");
  if(error instanceof CanonicalBackfillError)return json({code:error.code,error:error.message},error.status);
  // Driver exceptions may include SQL parameters and private content.
  return json({code:'backfill_unavailable',error:'Backfill is temporarily unavailable; retry the same command ID or check batch status.'},503);
}
export async function GET(request:Request){
  const user=await requireMemoryUser();if(user.error)return user.error;
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>key!=='batchId')||params.getAll('batchId').length>1)return json({code:'invalid_query'},400);
  const batchId=params.get('batchId');
  if(batchId!==null&&!z.string().uuid().safeParse(batchId).success)return json({code:'invalid_batch_id'},400);
  try{return json(batchId?await readCanonicalBatch(user.userId,batchId):await listCanonicalBatches(user.userId));}
  catch(error){return failure(error);}
}
export async function POST(request:Request){
  const user=await requireMemoryUser();if(user.error)return user.error;
  try{
    const parsed=command.safeParse(await readBoundedJson(request));
    if(!parsed.success)return json({code:'invalid_command',error:'Invalid backfill command'},400);
    const input={...parsed.data,userId:user.userId};
    switch(input.action){
      case 'prepare':return json(await prepareCanonicalBatch(input));
      case 'apply':return json(await applyCanonicalBatchPage(input));
      case 'rollback':return json(await rollbackCanonicalBatchPage(input));
      default:return json(await controlCanonicalBatch(input));
    }
  }catch(error){return failure(error);}
}
