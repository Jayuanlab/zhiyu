import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createPiLocalTools} from '@/lib/workshops/pi-local-tools';
const roots:string[]=[];
async function fixture(){const root=await mkdtemp(join(tmpdir(),'zhiyu-code-read-'));roots.push(root);await mkdir(join(root,'src'));await writeFile(join(root,'src','first.ts'),'applyRecordedStep()\nsecond()\n','utf8');await writeFile(join(root,'src','second.ts'),'applyRecordedStep()\n','utf8');return root;}
afterEach(async()=>{for(const root of roots.splice(0)){const target=resolve(root);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('zhiyu-code-read-'))throw Error('Unsafe test cleanup');await rm(target,{recursive:true,force:true});}});
function data(result:any){return JSON.parse(result.content[0].text);}
it('requires a distinct codebase grant and never expands write access',async()=>{
 const root=await fixture(),tools=createPiLocalTools(root);
 expect(tools.some(tool=>tool.name==='Grep'||tool.name==='Glob')).toBe(false);
 await expect(tools.find(tool=>tool.name==='Read')!.execute('r',{path:'repo/src/first.ts'})).rejects.toThrow('not granted');
 const run=await fixture(),granted=createPiLocalTools(run,root);
 await expect(granted.find(tool=>tool.name==='Write')!.execute('w',{path:join(root,'src','first.ts'),content:'bad'})).rejects.toThrow('outside');
});
it('finds previously unregistered nested code and paginates literal matches with provenance',async()=>{
 const root=await fixture(),tools=createPiLocalTools(root,root),grep=tools.find(tool=>tool.name==='Grep')!;
 const files=data(await tools.find(tool=>tool.name==='Glob')!.execute('g',{pattern:'**/*.ts'}));
 expect(files.paths).toEqual(['repo/src/first.ts','repo/src/second.ts']);
 const first=data(await grep.execute('s',{query:'applyRecordedStep',limit:1}));expect(first.nextOffset).toBe(2);expect(first.matches[0]).toMatchObject({path:'repo/src/first.ts',line:1,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
 const second=data(await grep.execute('s2',{query:'applyRecordedStep',limit:1,offset:2}));expect(second.matches[0].path).toBe('repo/src/second.ts');expect(second.nextOffset).toBeNull();
 const read=data(await tools.find(tool=>tool.name==='Read')!.execute('r',{path:first.matches[0].path,offset:2,limit:1}));expect(read.content).toBe('2: second()');expect(read.sha256).toBe(first.matches[0].sha256);expect(read).toMatchObject({startLine:2,endLine:2});
});
it('denies traversal, secrets, generated directories, binary files and escaped junctions',async()=>{
 const root=await fixture(),outside=await fixture();await writeFile(join(root,'.env'),'private');await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','private.ts'),'applyRecordedStep()');await writeFile(join(root,'binary.ts'),Buffer.from([0,1,2]));
 await symlink(outside,join(root,'escaped'),process.platform==='win32'?'junction':'dir');
 const tools=createPiLocalTools(root,root),read=tools.find(tool=>tool.name==='Read')!;
 for(const path of ['repo/../escape.ts','repo/.env','repo/node_modules/private.ts','repo/escaped/src/first.ts','repo/binary.ts'])await expect(read.execute('r',{path})).rejects.toThrow();
 const search=data(await tools.find(tool=>tool.name==='Grep')!.execute('g',{query:'applyRecordedStep'}));expect(search.matches).toHaveLength(2);expect(search.skippedFiles).toBe(1);
});
it('observes current bytes after source changes and honors cancellation',async()=>{
 const root=await fixture(),tools=createPiLocalTools(root,root),read=tools.find(tool=>tool.name==='Read')!;
 const before=data(await read.execute('r',{path:'repo/src/first.ts'}));await writeFile(join(root,'src','first.ts'),'changed');
 const after=data(await read.execute('r2',{path:'repo/src/first.ts'}));expect(after.sha256).not.toBe(before.sha256);
 const controller=new AbortController();controller.abort();await expect(tools.find(tool=>tool.name==='Grep')!.execute('s',{query:'changed'},controller.signal)).rejects.toThrow();
});
it('counts physical source lines and returns exact citation and non-overlapping continuation boundaries',async()=>{
 const root=await fixture(),read=createPiLocalTools(root,root).find(t=>t.name==='Read')!;
 const first=data(await read.execute('first',{path:'repo/src/first.ts',limit:1}));
 expect(first).toMatchObject({totalLines:2,startLine:1,endLine:1,truncated:true,nextOffset:2,
  citation:{path:'repo/src/first.ts',sha256:first.sha256,startLine:1,endLine:1},nextRead:{path:'repo/src/first.ts',offset:2,limit:1}});
 const tail=data(await read.execute('tail',first.nextRead));
 expect(tail).toMatchObject({totalLines:2,startLine:2,endLine:2,truncated:false,nextOffset:null,nextRead:null});
 expect(tail.sha256).toBe(first.sha256);expect(tail.content).toBe('2: second()');
});
it.each([['',0],['one',1],['one\n',1],['one\r\n',1],['one\n\n',2]])('does not invent a terminal source line for %j',async(text,expectedLines)=>{
 const root=await fixture();await writeFile(join(root,'src','lines.ts'),text,'utf8');
 const read=createPiLocalTools(root,root).find(t=>t.name==='Read')!,value=data(await read.execute('r',{path:'repo/src/lines.ts'}));
 expect(value.totalLines).toBe(expectedLines);expect(value.endLine).toBe(expectedLines||null);
 expect(value.truncated).toBe(false);expect(value.nextRead).toBeNull();
});
it('does not offer an infinite continuation when a single line exceeds the byte budget',async()=>{
 const root=await fixture();await writeFile(join(root,'src','huge.ts'),'x'.repeat(40001),'utf8');
 const value=data(await createPiLocalTools(root,root).find(t=>t.name==='Read')!.execute('r',{path:'repo/src/huge.ts'}));
 expect(value).toMatchObject({truncated:true,startLine:null,endLine:null,citation:null,nextRead:null,warning:'single_line_exceeds_read_budget'});
});
