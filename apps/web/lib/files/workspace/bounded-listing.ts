import {randomUUID} from 'node:crypto';
import {opendir,stat} from 'node:fs/promises';
import type {Dir} from 'node:fs';
import {join,relative,extname} from 'node:path';
import {resolveSessionListingPath} from './listing-boundary';

type FileItem={taskId:string;name:string;path:string;type?:string;size:number;isDirectory:false;modifiedTime:string};
type Page={files:FileItem[];scope:'workspace';hasMore:boolean;nextCursor:string|null;total:null;scannedEntries:number;skippedLinks:number;sortOrder:'directory_traversal';};
type Root={taskId:string;path:string;basePath?:string};
export type ListingScope={taskId:string;path?:string};
type Frame={path:string;dir:Dir};
type Scan={id:string;owner:string;scopeKey:string;after:string|null;root:Root|null;frames:Frame[];step:number;busy:boolean;timer:ReturnType<typeof setTimeout>;last?:{step:number;page:Page;paths:Array<{root:string;path:string}>};};
export class ListingCursorError extends Error {
  constructor(public status:number,public code:string){super(code);}
}
export type ListingAccess={
  nextRoot:(owner:string,after:string|null,scope?:ListingScope)=>Promise<Root|null>;
  allowed:(owner:string,taskId:string)=>Promise<boolean>;
};
const excludedDirs=new Set(['node_modules','.git','venv','.venv','__pycache__','dist','build']);
const excludedExtensions=new Set(['.js','.jsx','.ts','.tsx','.css','.scss','.json','.py','.java','.c','.cpp','.go','.rs','.php','.rb','.sql','.map','.lock','.tmpl','.pdl','.bare','.cjs','.mjs']);

/** Local-process scan cursors: bounded reads, bounded open handles and idle expiry.
 * Directory order is live, not a globally sorted or immutable snapshot. */
export class BoundedWorkspaceListing {
  private scans=new Map<string,Scan>();
  constructor(private access:ListingAccess,private options={budget:500,ttlMs:120000,maxScans:32,maxDepth:32}){}
  private arm(scan:Scan){
    clearTimeout(scan.timer);
    scan.timer=setTimeout(()=>{if(scan.busy)this.arm(scan);else void this.dispose(scan);},this.options.ttlMs);
    scan.timer.unref?.();
  }
  private async dispose(scan:Scan){
    this.scans.delete(scan.id);clearTimeout(scan.timer);
    await Promise.all(scan.frames.splice(0).map(frame=>frame.dir.close().catch(()=>{})));
  }
  async close(){await Promise.all([...this.scans.values()].map(scan=>this.dispose(scan)));}
  async page(owner:string,cursor:string|null,limit=50,scope?:ListingScope):Promise<Page>{
    const scopeKey=JSON.stringify(scope?{taskId:scope.taskId,path:scope.path??''}:null);
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new ListingCursorError(400,'invalid_page_size');
    let scan:Scan;let requested=0;
    if(cursor){
      const match=/^([0-9a-f-]{36}):(\d{1,9})$/.exec(cursor);
      if(!match)throw new ListingCursorError(400,'invalid_cursor');
      const found=this.scans.get(match[1]);
      if(!found||found.owner!==owner)throw new ListingCursorError(410,'cursor_expired');
      if(found.scopeKey!==scopeKey)throw new ListingCursorError(409,'cursor_scope_mismatch');
      scan=found;requested=Number(match[2]);
    }else{
      if(this.scans.size>=this.options.maxScans)throw new ListingCursorError(429,'too_many_scans');
      scan={id:randomUUID(),owner,scopeKey,after:null,root:null,frames:[],step:0,busy:false,timer:undefined as never};
      this.scans.set(scan.id,scan);
    }
    if(scan.busy)throw new ListingCursorError(409,'scan_busy');
    scan.busy=true;this.arm(scan);
    try{
      if(scan.last?.step===requested){
        for(const taskId of new Set(scan.last.page.files.map(file=>file.taskId)))
          if(!await this.access.allowed(owner,taskId))throw new ListingCursorError(403,'access_revoked');
        for(const item of scan.last.paths)resolveSessionListingPath(item.root,item.path);
        return scan.last.page;
      }
      if(requested!==scan.step)throw new ListingCursorError(410,'cursor_expired');
      if(scan.root&&!await this.access.allowed(owner,scan.root.taskId))throw new ListingCursorError(403,'access_revoked');
      const files:FileItem[]=[];const paths:Array<{root:string;path:string}>=[];let scannedEntries=0,skippedLinks=0,complete=false;
      while(scannedEntries<this.options.budget&&files.length<limit){
        if(!scan.frames.length){
          const root=await this.access.nextRoot(owner,scan.after,scope);scannedEntries++;
          if(!root){complete=true;break;}
          scan.after=root.taskId;scan.root=root;
          try{scan.frames.push({path:root.path,dir:await opendir(resolveSessionListingPath(root.basePath??root.path,root.path),{bufferSize:32})});}
          catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
          continue;
        }
        const root=scan.root!;const frame=scan.frames[scan.frames.length-1];
        resolveSessionListingPath(root.basePath??root.path,frame.path);
        const entry=await frame.dir.read();scannedEntries++;
        if(!entry){await frame.dir.close();scan.frames.pop();continue;}
        if(entry.isSymbolicLink()){skippedLinks++;continue;}
        if(entry.name.startsWith('.')||entry.isDirectory()&&excludedDirs.has(entry.name))continue;
        const target=resolveSessionListingPath(root.basePath??root.path,join(frame.path,entry.name));
        if(entry.isDirectory()){
          if(scan.frames.length>=this.options.maxDepth)throw new ListingCursorError(422,'directory_depth_exceeded');
          scan.frames.push({path:target,dir:await opendir(target,{bufferSize:32})});continue;
        }
        if(!entry.isFile()||excludedExtensions.has(extname(entry.name).toLowerCase()))continue;
        const info=await stat(target);
        paths.push({root:root.basePath??root.path,path:target});
        files.push({taskId:root.taskId,name:entry.name,path:relative(root.basePath??root.path,target),type:extname(entry.name).slice(1)||undefined,size:info.size,isDirectory:false,modifiedTime:info.mtime.toISOString()});
      }
      const page:Page={files,scope:'workspace',hasMore:!complete,nextCursor:complete?null:`${scan.id}:${scan.step+1}`,total:null,scannedEntries,skippedLinks,sortOrder:'directory_traversal'};
      scan.last={step:scan.step,page,paths};scan.step++;return page;
    }catch(error){await this.dispose(scan);throw error;}
    finally{scan.busy=false;}
  }
}
