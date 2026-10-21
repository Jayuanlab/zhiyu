import {createHash} from 'node:crypto';
import {open,readdir,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';

const excludedDirectories=new Set(['.git','node_modules','.next','.runtime','.tmp','.data','.openzhiyu','.codex','.ssh','dist','build','coverage','secrets','credentials']);
const maxBytes=4*1024*1024;
export function hostCodebaseRoot(){
 let candidate=resolve(process.cwd());
 while(true){
  if(existsSync(resolve(candidate,'pnpm-workspace.yaml'))&&existsSync(resolve(candidate,'apps/web')))return candidate;
  const parent=dirname(candidate);if(parent===candidate)throw Error('Project codebase root is unavailable');candidate=parent;
 }
}
function within(root:string,path:string){const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\');}
function permitted(path:string){
 const parts=path.replaceAll('\\','/').split('/');
 return !parts.some(part=>excludedDirectories.has(part.toLowerCase())) &&
  !/^(\.env(?:\..*)?|credentials(?:\..*)?|secrets(?:\..*)?|id_rsa|id_ed25519)$/i.test(parts.at(-1)??'') &&
  !/\.(pem|key|p12|pfx|db|sqlite|sqlite3|log)$/i.test(path);
}
async function checked(root:string,path:string){
 const canonicalRoot=await realpath(root),candidate=resolve(canonicalRoot,path);
 if(!within(canonicalRoot,candidate)||!permitted(relative(canonicalRoot,candidate)))throw Error('Codebase path is outside the grant or excluded');
 const canonical=await realpath(candidate);
 if(!within(canonicalRoot,canonical)||!permitted(relative(canonicalRoot,canonical)))throw Error('Codebase path resolves outside the grant or is excluded');
 return {root:canonicalRoot,path:canonical};
}
async function bytes(root:string,path:string){
 const target=await checked(root,path);
 const handle=await open(target.path,'r');
 try{
  const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)throw Error('Codebase file is not text-sized (maximum 4 MiB)');
  const buffer=Buffer.alloc(maxBytes+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>maxBytes)throw Error('Codebase file exceeds 4 MiB');
  const value=buffer.subarray(0,bytesRead);if(value.includes(0))throw Error('Binary files are excluded');
  return {path:relative(target.root,target.path).replaceAll('\\','/'),text:value.toString('utf8'),sha256:createHash('sha256').update(value).digest('hex')};
 }finally{await handle.close();}
}
async function inventory(root:string,signal?:AbortSignal,pattern='**/*'){
 const canonical=await realpath(root),paths:string[]=[],warnings:string[]=[];let visited=0,truncated=false;
 const start=Date.now();
 async function walk(directory:string){
  signal?.throwIfAborted();
  if(visited>=100000||Date.now()-start>15000){truncated=true;return;}
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{warnings.push(relative(canonical,directory).replaceAll('\\','/')+': unreadable directory');return;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   signal?.throwIfAborted();if(++visited>100000||Date.now()-start>15000){truncated=true;break;}
   const candidate=resolve(directory,entry.name),rel=relative(canonical,candidate).replaceAll('\\','/');
   if(!permitted(rel)||entry.isSymbolicLink())continue;
   if(entry.isDirectory()){
    try{await checked(canonical,rel);}catch{warnings.push(rel+': inaccessible or escaped path');continue;}
    await walk(candidate);
   }else if(entry.isFile())paths.push(rel);
  }
 }
 const fixed=pattern.split(/[?*]/)[0],directory=fixed.slice(0,fixed.lastIndexOf('/'));
 if(directory){const start=await checked(canonical,directory);await walk(start.path);}else await walk(canonical);
 return {paths,warnings,truncated};
}
function patternRegex(pattern:string){
 if(pattern.length>500||isAbsolute(pattern)||pattern.split(/[\\/]/).includes('..'))throw Error('Glob requires a relative codebase pattern');
 let source='';for(let i=0;i<pattern.length;i++){
  const char=pattern[i];if(char==='*'&&pattern[i+1]==='*'){i++;if(pattern[i+1]==='/'){i++;source+='(?:.*/)?';}else source+='.*';}
  else if(char==='*')source+='[^/]*';else if(char==='?')source+='[^/]';else source+=char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }return new RegExp('^'+source+'$','i');
}
function positive(value:unknown,fallback:number,maximum:number){return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?Math.min(value,maximum):fallback;}
function result(value:unknown){return {content:[{type:'text' as const,text:JSON.stringify(value)}],details:{codebaseObservation:value}};}
/** A final line separator terminates the last physical line; it does not add
 * another source line. Keep deliberate blank lines and hash the original bytes. */
function sourceLines(text:string){
 if(!text)return [];
 const lines=text.split(/\r?\n/);if(lines.at(-1)==='')lines.pop();return lines;
}
export async function readCodebaseFile(root:string,params:{path:string;offset?:number;limit?:number},signal?:AbortSignal){
 signal?.throwIfAborted();const file=await bytes(root,params.path.replace(/^repo[\\/]/,''));signal?.throwIfAborted();
 const lines=sourceLines(file.text),offset=positive(params.offset,1,Number.MAX_SAFE_INTEGER),limit=positive(params.limit,200,500);
 const selected=lines.slice(offset-1,offset-1+limit);const returned:string[]=[];let size=0;
 for(const [index,line] of selected.entries()){const numbered=`${offset+index}: ${line}`,length=Buffer.byteLength(numbered)+(returned.length?1:0);if(size+length>40000)break;returned.push(numbered);size+=length;}
 const content=returned.join('\n'),byteLimited=returned.length<selected.length;
 const path='repo/'+file.path,startLine=returned.length?offset:null,endLine=returned.length?offset+returned.length-1:null;
 const nextOffset=endLine!==null&&endLine<lines.length?endLine+1:null;
 return result({path,sha256:file.sha256,observedAt:new Date().toISOString(),totalLines:lines.length,offset,startLine,endLine,content,
  truncated:byteLimited||nextOffset!==null,nextOffset,nextRead:nextOffset===null?null:{path,offset:nextOffset,limit},
  citation:startLine===null?null:{path,sha256:file.sha256,startLine,endLine},
  ...(byteLimited&&!returned.length?{warning:'single_line_exceeds_read_budget'}:{})});
}
export function createCodebaseSearchTools(root:string):AgentTool<any>[] {
 return [
  {name:'Glob',label:'Find codebase files',description:'Find files anywhere in the authorized project codebase. Paths returned use repo/. Excludes secrets, generated dependencies and runtime data. Supports **, *, ?. No shell commands.',parameters:Type.Object({pattern:Type.String(),offset:Type.Optional(Type.Number()),limit:Type.Optional(Type.Number())}),replay:'never',executionMode:'sequential',execute:async(_id,rawParams,signal)=>{
   const params=rawParams as {pattern:string;offset?:number;limit?:number};
   if(typeof params.pattern!=='string')throw Error('A relative glob pattern is required');
   const matcher=patternRegex(params.pattern),files=await inventory(root,signal,params.pattern),matches=files.paths.filter(path=>matcher.test(path));
   const offset=positive(params.offset,1,Number.MAX_SAFE_INTEGER)-1,limit=positive(params.limit,100,500);
   return result({root:'repo/',paths:matches.slice(offset,offset+limit).map(path=>'repo/'+path),totalMatches:matches.length,nextOffset:offset+limit<matches.length?offset+limit+1:null,truncated:files.truncated,warnings:files.warnings.slice(0,50)});
  }},
  {name:'Grep',label:'Search codebase text',description:'Search a literal string in project files, with optional relative glob pattern. Returns path, line and SHA256. Paginate with offset. No regex or shell commands. Secrets and runtime data excluded.',parameters:Type.Object({query:Type.String(),pattern:Type.Optional(Type.String()),offset:Type.Optional(Type.Number()),limit:Type.Optional(Type.Number())}),replay:'never',executionMode:'sequential',execute:async(_id,rawParams,signal)=>{
   const params=rawParams as {query:string;pattern?:string;offset?:number;limit?:number};
   if(params.pattern!==undefined&&typeof params.pattern!=='string')throw Error('A relative glob pattern is required');
   if(typeof params.query!=='string'||!params.query||params.query.length>500)throw Error('A literal search query (1–500 characters) is required');
   const matcher=patternRegex(params.pattern??'**/*'),files=await inventory(root,signal,params.pattern??'**/*'),matches:Array<{path:string;line:number;text:string;sha256:string}>=[];
   const offset=positive(params.offset,1,Number.MAX_SAFE_INTEGER)-1,limit=positive(params.limit,50,200);let seen=0,skipped=0,hasMore=false;const start=Date.now();
   for(const path of files.paths){
    signal?.throwIfAborted();if(Date.now()-start>15000){files.truncated=true;break;}if(!matcher.test(path))continue;
    let file;try{file=await bytes(root,path);}catch{skipped++;continue;}
    const lines=sourceLines(file.text);
    for(let index=0;index<lines.length;index++)if(lines[index].includes(params.query)){
     if(seen++<offset)continue;if(matches.length===limit){hasMore=true;break;}
     matches.push({path:'repo/'+path,line:index+1,text:lines[index].slice(0,800),sha256:file.sha256});
    }if(hasMore)break;
   }
   return result({query:params.query,matches,nextOffset:hasMore?offset+matches.length+1:null,truncated:files.truncated,skippedFiles:skipped,warnings:files.warnings.slice(0,50),observedAt:new Date().toISOString()});
  }},
 ];
}
