import { readCanonicalBackfillSourceRows } from "../adapters/postgres/canonical-backfill";
import {db} from '@/lib/db/client';
import { CANONICAL_BACKFILL_VERSION, planCanonicalBackfillRow } from "@/lib/memory/governance/canonical-backfill-plan";

/** No upsert, observation creation, or review synchronization is permitted here. */
export async function previewCanonicalBackfill(input:{userId:string;cursor?:string;limit?:number}) {
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(!uuid.test(input.userId)||(input.cursor&&!uuid.test(input.cursor)))throw Error('Invalid owner or cursor');
  const limit=input.limit??100;
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Page limit must be 1..500');
  const rows=await readCanonicalBackfillSourceRows(db,{userId:input.userId,cursor:input.cursor,limit:limit+1});
  const page=rows.slice(0,limit),items=page.map(row=>planCanonicalBackfillRow(row));
  return {mappingVersion:CANONICAL_BACKFILL_VERSION,dryRun:true,userId:input.userId,
    nextCursor:rows.length>limit?page.at(-1)!.id:null,
    counts:{scanned:items.length,mappable:items.filter(item=>item.status==='mappable').length,unchanged:items.filter(item=>item.status==='unchanged').length,conflicts:items.filter(item=>item.status==='conflict').length,invalid:items.filter(item=>item.status==='invalid').length,missingEvidence:items.filter(item=>item.missingEvidence===true).length},items};
}
