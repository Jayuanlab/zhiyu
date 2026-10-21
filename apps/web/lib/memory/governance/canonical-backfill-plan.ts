import {createHash} from 'node:crypto';
import { buildCanonicalGroupId, inferBrainCanonicalKind } from "@/lib/memory/kernel/memory-canonical";
import type { BrainCanonicalKind } from "@/lib/memory/kernel/memory-canonical";
import type { BrainMemoryType, BrainScope } from "@/lib/memory/kernel/memory-types";

export const CANONICAL_BACKFILL_VERSION='canonical-columns-v1';
const kinds=new Set(['boundary','preference','state','plan','commitment','lesson','profile','fact']);
const types=new Set(['fact','preference','plan','boundary','relationship','task','insight','system']);
function stable(value:unknown):unknown {
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]));
  return value;
}
export function canonicalBackfillHash(row:Record<string,unknown>) {
  return createHash('sha256').update(JSON.stringify(stable(row))).digest('hex');
}
function parsed(value:unknown) {return typeof value==='string'?JSON.parse(value):value;}
export function planCanonicalBackfillRow(row:Record<string,unknown>) {
  const base={id:String(row.id),mappingVersion:CANONICAL_BACKFILL_VERSION,beforeValueHash:canonicalBackfillHash(row)};
  try {
    const metadata=parsed(row.metadata??{});
    const evidence=parsed(row.evidenceRefs??[]),tags=parsed(row.tags??[]);
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('invalid_metadata');
    if(!Array.isArray(evidence)||evidence.some(value=>typeof value!=='string'||!value.trim()))throw Error('invalid_evidence_refs');
    if(!Array.isArray(tags)||tags.some(value=>typeof value!=='string'))throw Error('invalid_tags');
    if(!types.has(String(row.memoryType)))throw Error('unknown_memory_type');
    if(!['global','work','workshop','workspace'].includes(String(row.scopeType)) || (row.scopeType!=='global'&&(!row.scopeId||typeof row.scopeId!=='string')) || (row.scopeType==='global'&&row.scopeId!=null))throw Error('invalid_scope');
    if(!['chat','work','system'].includes(String(row.ownerType))||!row.ownerId)throw Error('invalid_owner');
    if(typeof row.subject!=='string'||typeof row.content!=='string')throw Error('invalid_content');
    const kindValues=[row.canonicalKind,metadata.canonicalKind].filter(value=>value!==null&&value!==undefined&&value!=='');
    const groupValues=[row.canonicalGroupId,metadata.canonicalGroupId].filter(value=>value!==null&&value!==undefined&&value!=='');
    if(kindValues.some(value=>!kinds.has(String(value)))||groupValues.some(value=>typeof value!=='string'||!value.trim()))throw Error('invalid_canonical_value');
    const missingEvidence=evidence.length===0;
    if(new Set(kindValues).size>1||new Set(groupValues).size>1)return {...base,status:'conflict' as const,reason:'column_metadata_disagree',missingEvidence,changes:null};
    const canonicalKind=(kindValues[0]??inferBrainCanonicalKind({memoryType:row.memoryType as BrainMemoryType,subject:row.subject,content:row.content,tags})) as BrainCanonicalKind;
    const scope=(row.scopeType==='global'?{type:'global'}:row.scopeType==='workspace'?{type:'workspace',workspaceId:row.scopeId}:row.scopeType==='workshop'?{type:'workshop',workshopId:row.scopeId}:{type:'work',workId:row.scopeId}) as BrainScope;
    const canonicalGroupId=(groupValues[0]??buildCanonicalGroupId({evidenceRefs:evidence,scope,canonicalKind,subject:row.subject,ownerType:row.ownerType as 'chat'|'work'|'system',ownerId:String(row.ownerId)})) as string;
    const changes={...(row.canonicalKind?{}:{canonicalKind}),...(row.canonicalGroupId?{}:{canonicalGroupId})};
    return {...base,status:Object.keys(changes).length?'mappable' as const:'unchanged' as const,missingEvidence,evidenceReachability:'not_checked' as const,changes};
  } catch(error) {return {...base,status:'invalid' as const,reason:error instanceof Error?error.message:String(error),missingEvidence:null,changes:null};}
}
