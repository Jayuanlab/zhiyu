import type {RuntimeModule} from './module-supervisor';
import type {PaperTickStore} from './paper-tick-store';
import {submitPaperTick} from '../quant/paper-client';
export function createPaperMatchingModule(ownerId:string,store:Pick<PaperTickStore,'prepare'|'complete'>,submit=submitPaperTick):RuntimeModule{
  return {name:'paper-matching',intervalMs:10000,timeoutMs:30000,run:async signal=>{
    signal.throwIfAborted();
    const accountId=process.env.QUANT_PAPER_ACCOUNT_ID?.trim().toLowerCase();
    if(!accountId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId))throw Error('paper_migration_required');
    if(process.env.QUANT_PAPER_OWNER_ID?.toLowerCase()!==ownerId.toLowerCase())throw Error('paper_owner_denied');
    const commandId=await store.prepare(ownerId,accountId);
    if(!commandId)return;
    signal.throwIfAborted();
    const receipt=await submit({commandId,accountId,signal},{ownerId,actorId:`scheduler:${ownerId.toLowerCase()}`,role:'scheduler'});
    // Persist a confirmed result even if stop arrived after the HTTP response.
    // Unknown/failed transport leaves the same durable command pending.
    await store.complete(ownerId,accountId,commandId,receipt);
    return receipt;
  }};
}
