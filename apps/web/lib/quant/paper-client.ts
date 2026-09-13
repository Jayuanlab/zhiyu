import {createHash,createHmac} from 'node:crypto';
import type {QuantPaperOrder,QuantPaperOrderInput} from './types';

export type PaperClientContext={ownerId:string;actorId:string;role:'owner'|'trader'|'scheduler';execution?:{
  workshopId:string;runId:string;workerId:string;token:number;policyHash:string;
}};
export class PaperCommandError extends Error {
  constructor(public code:string,public status:number,public commandId?:string,public receipt?:unknown){super(code);}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function accountId(explicit?:string){const value=explicit??process.env.QUANT_PAPER_ACCOUNT_ID;if(!value||!uuid.test(value))throw new PaperCommandError('paper_migration_required',503);return value;}
function commandId(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>200)throw new PaperCommandError('invalid_command',400);return value;}

export function paperSignedHeaders(context:PaperClientContext,method:string,path:string,body:string,now=Date.now()){
  const key=process.env.QUANT_PAPER_SIGNING_KEY,token=process.env.QUANT_INTERNAL_TOKEN,owner=process.env.QUANT_PAPER_OWNER_ID;
  if(!key||key.length<32||!token||!owner)throw new PaperCommandError('paper_identity_not_configured',503);
  if(!uuid.test(context.ownerId)||context.ownerId.toLowerCase()!==owner.toLowerCase())throw new PaperCommandError('paper_owner_denied',403);
  if(context.role==='trader'&&!context.execution)throw new PaperCommandError('paper_execution_required',403);
  const claims={ownerId:context.ownerId,actorId:context.actorId,role:context.role,execution:context.execution,
    method,path,bodySha256:createHash('sha256').update(body).digest('hex'),issuedAt:now/1000,expiresAt:now/1000+60};
  const encoded=Buffer.from(JSON.stringify(claims),'utf8').toString('base64url');
  return {Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${token}`,
    'X-Zhiyu-Paper-Context':encoded,'X-Zhiyu-Paper-Signature':createHmac('sha256',key).update(encoded).digest('hex')};
}

async function request(context:PaperClientContext,path:string,body?:unknown,id?:string,signal?:AbortSignal){
  signal?.throwIfAborted();
  const base=new URL(process.env.QUANT_SERVICE_URL??'http://127.0.0.1:8766');
  if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||!['http:','https:'].includes(base.protocol))throw new PaperCommandError('paper_local_service_required',503,id);
  const text=body===undefined?'':JSON.stringify(body),method=body===undefined?'GET':'POST';
  const headers=paperSignedHeaders(context,method,path,text);
  let response:Response,value:any;
  try{response=await fetch(new URL(path,base),{method,headers,body:body===undefined?undefined:text,cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});value=await response.json();}
  catch{throw new PaperCommandError('paper_result_unknown',503,id);}
  if(!response.ok)throw new PaperCommandError(typeof value?.reasonCode==='string'?value.reasonCode:typeof value?.detail==='string'?value.detail:'paper_service_unavailable',response.status,id);
  return value;
}

function orderResult(value:any,id:string){
  if(value?.commandId!==id||!Number.isSafeInteger(value.version)||value.version<1||!value.result||typeof value.result!=='object'||Array.isArray(value.result))throw new PaperCommandError('paper_result_unknown',503,id);
  if(value.result.status==='rejected')throw new PaperCommandError(value.result.reasonCode??'paper_order_rejected',409,id,value);
  if(!['accepted','completed'].includes(value.result.status))throw new PaperCommandError('paper_result_unknown',503,id);
  const raw=value.result.order;
  if(!raw||typeof raw.id!=='string'||!['buy','sell'].includes(raw.side)||!['submitted','partially_filled','filled','cancelled','rejected'].includes(raw.status))throw new PaperCommandError('paper_result_unknown',503,id);
  const order={...raw};
  for(const field of ['quantity','remaining_quantity','limit_price','planned_price','max_buy_deviation_pct']){
    if(order[field]==null)continue;
    const numeric=Number(order[field]);if(!Number.isFinite(numeric))throw new PaperCommandError('paper_result_unknown',503,id);order[field]=numeric;
  }
  if(!Number.isSafeInteger(order.quantity)||order.quantity<=0||!Number.isSafeInteger(order.remaining_quantity)||order.remaining_quantity<0||order.remaining_quantity>order.quantity||!(order.limit_price>0))throw new PaperCommandError('paper_result_unknown',503,id);
  return {commandId:id,version:value.version,status:value.result.status,order:order as QuantPaperOrder};
}

export async function submitPaperOrder(input:QuantPaperOrderInput,context:PaperClientContext){
  const id=commandId(input.commandId),account=accountId(input.accountId);
  const body={commandId:id,expectedVersion:input.expectedVersion,code:input.code,side:input.side,quantity:input.quantity,
    limit_price:String(input.limit_price),planned_price:input.planned_price==null?undefined:String(input.planned_price),
    max_buy_deviation_pct:input.max_buy_deviation_pct==null?undefined:String(input.max_buy_deviation_pct),note:input.note,strategy:input.strategy,trade_thesis:input.tradeThesis};
  return orderResult(await request(context,`/paper/v2/accounts/${account}/orders`,body,id),id);
}
export async function cancelPaperOrder(order:string,command:{commandId:string;accountId?:string;expectedVersion?:number;reason?:string},context:PaperClientContext){
  const id=commandId(command.commandId),account=accountId(command.accountId);
  return orderResult(await request(context,`/paper/v2/accounts/${account}/orders/${encodeURIComponent(order)}/cancel`,{commandId:id,expectedVersion:command.expectedVersion,reason:command.reason},id),id);
}
export async function readPaperCommand(context:PaperClientContext,command:string,account?:string){
  return request(context,`/paper/v2/accounts/${accountId(account)}/commands/${encodeURIComponent(commandId(command))}`);
}
export async function readPaperAccount(ownerId:string){
  return request({ownerId,actorId:`user:${ownerId}`,role:'owner'},`/paper/v2/accounts/${accountId()}/view`);
}

export async function submitPaperTick(input:{commandId:string;accountId:string;signal?:AbortSignal},context:PaperClientContext){
  if(context.role!=='scheduler')throw new PaperCommandError('paper_actor_denied',403);
  const id=commandId(input.commandId),account=accountId(input.accountId);
  const value=await request(context,`/paper/v2/accounts/${account}/ticks`,{commandId:id},id,input.signal);
  if(value?.commandId!==id||!Number.isSafeInteger(value.version)||value.version<1||value.result?.status!=='completed'
    ||!Array.isArray(value.result.matched)||!value.result.matched.every((id:unknown)=>typeof id==='string')
    ||!value.result.waiting||typeof value.result.waiting!=='object'||Array.isArray(value.result.waiting))
    throw new PaperCommandError('paper_result_unknown',503,id);
  return value;
}
export async function readPaperImportReview(ownerId:string){
  return request({ownerId,actorId:`user:${ownerId}`,role:'owner'},'/paper/v2/migration/review');
}
export type PaperRecoveryDecision={commandId:string;reviewHash:string;decision:'approved'|'rejected';acknowledgements:Record<string,boolean>};
export async function preparePaperRecoveryReview(ownerId:string){
  return request({ownerId,actorId:`user:${ownerId}`,role:'owner'},'/paper/v2/migration/reviews',{});
}
export async function readPaperRecoveryReview(ownerId:string,reviewId:string){
  if(!uuid.test(reviewId))throw new PaperCommandError('invalid_review_id',400);
  return request({ownerId,actorId:`user:${ownerId}`,role:'owner'},`/paper/v2/migration/reviews/${reviewId}`);
}
export async function decidePaperRecoveryReview(ownerId:string,reviewId:string,decision:PaperRecoveryDecision){
  if(!uuid.test(reviewId))throw new PaperCommandError('invalid_review_id',400);
  const id=commandId(decision.commandId);
  return request({ownerId,actorId:`user:${ownerId}`,role:'owner'},`/paper/v2/migration/reviews/${reviewId}/decision`,decision,id);
}
export async function readPaperLedger(ownerId:string){
  const result=await request({ownerId,actorId:`user:${ownerId}`,role:'owner'},`/paper/v2/accounts/${accountId()}`);
  for(const collection of ['orders','fills','lots'])for(const row of result.state[collection]){
    for(const key of ['limit_price','planned_price','max_buy_deviation_pct','price','amount','cost_price','realized_pnl']){
      if(row[key]!=null){const value=Number(row[key]);if(!Number.isFinite(value))throw new PaperCommandError('paper_result_unknown',503);row[key]=value;}
    }
  }
  return result;
}
