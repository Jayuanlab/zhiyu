import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { auth } from '@/app/(auth)/auth';
import { getAppDir } from '@/lib/env/config/constants';
import { assertWorkAccess } from '@/lib/work-runtime';
import { getWorkshopEvent } from '@/lib/workshops/service';

export const dynamic='force-dynamic';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const inside=(root:string,path:string)=>{const result=relative(root,path);return result!=='' && !result.startsWith('..') && !isAbsolute(result);};
const object=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
/** Human download of an owner's recorded run output, never an arbitrary file read. */
export async function GET(_request:Request,context:{params:Promise<{id:string;eventId:string;fileName:string}>}){
  const session=await auth();
  if(!session?.user?.id)return Response.json({error:'unauthorized'},{status:401});
  const {id,eventId,fileName}=await context.params;
  if(!uuid.test(id)||!uuid.test(eventId)||!fileName||fileName!==basename(fileName)||/[\\/\x00-\x1f]/.test(fileName)||['.','..'].includes(fileName))return Response.json({error:'invalid_artifact_name'},{status:400});
  let event;
  try{await assertWorkAccess({userId:session.user.id,workId:id});event=await getWorkshopEvent(id,eventId);}catch{return Response.json({error:'not_found'},{status:404});}
  if(!event || event.workshopId!==id || !event.runId || !uuid.test(event.runId))return Response.json({error:'not_found'},{status:404});
  try{
    const metadata=object(event.metadata),records:Array<{path:unknown;sha256:unknown}>=[];
    if(event.type==='document_converted'){
      records.push({path:metadata.documentPath,sha256:metadata.documentSha256},{path:metadata.manifestPath,sha256:metadata.manifestSha256});
      if(Array.isArray(metadata.chunks))records.push(...metadata.chunks.map(chunk=>({path:object(chunk).path,sha256:object(chunk).sha256})));
    }
    if(Array.isArray(metadata.artifacts))records.push(...metadata.artifacts.map(artifact=>({path:object(artifact).path,sha256:object(artifact).sha256})));
    const recorded=records.filter(item=>typeof item.path==='string' && basename(item.path)===fileName);
    if(recorded.length!==1)throw Error('artifact_not_uniquely_recorded');
    const item=recorded[0];
    if(typeof item.path!=='string'||!isAbsolute(item.path)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(item.sha256))throw Error('invalid_artifact_receipt');
    const expected=resolve(getAppDir(),'sessions','workshops',id,event.runId),runRoot=await realpath(expected),file=await realpath(item.path);
    if(runRoot!==expected || !inside(runRoot,file))throw Error('artifact_outside_run');
    const details=await stat(file);if(!details.isFile())throw Error('artifact_is_not_file');
    if(details.size>64*1024*1024)return Response.json({error:'artifact_too_large'},{status:413});
    const data=await readFile(file);
    if(data.byteLength>64*1024*1024 || createHash('sha256').update(data).digest('hex')!==item.sha256.toLowerCase())throw Error('artifact_integrity_changed');
    const contentType=fileName.endsWith('.md') ? 'text/markdown; charset=utf-8' : fileName.endsWith('.json') ? 'application/json; charset=utf-8' : fileName.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return new Response(new Uint8Array(data),{headers:{'Content-Type':contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`}});
  }catch{return Response.json({error:'artifact_receipt_or_integrity_invalid'},{status:409});}
}
