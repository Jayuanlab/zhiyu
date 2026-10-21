import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {loadWebEvidence,readDirectDefuddlePage} from '@/lib/ai/jina-page-reader';
const scope='workshop:redirect-test',start='https://example.com/original',final='https://arxiv.org/html/2609.12345v1';
function response(body:string,status:number,url:string,headers:Record<string,string>={}){const r=new Response(body,{status,headers});Object.defineProperty(r,'url',{value:url});return r;}
describe('independently verified source redirects',()=>{
 it('checks each public hop and saves the actual final source with a reusable body identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zhiyu-source-redirect-'));try{
   const fetcher=vi.fn().mockResolvedValueOnce(response('',302,start,{location:final})).mockResolvedValueOnce(response('Actual primary source body. '.repeat(100),200,final,{'content-type':'text/plain'}));
   const first=await readDirectDefuddlePage({url:start,scope,maxChars:1000},{root,fetcher});
   expect(first).toMatchObject({finalUrl:final,finalUrlVerified:true});
   const saved=await loadWebEvidence(scope,first.evidenceId,start,root);expect(saved.snapshot.finalUrl).toBe(final);
   expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls.every(c=>c[1].redirect==='manual')).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each(['http://127.0.0.1/private','http://example.com/downgrade'])('refuses unsafe redirect %s before dispatching it',async(location)=>{
  const root=await mkdtemp(join(tmpdir(),'zhiyu-source-redirect-'));try{
   const fetcher=vi.fn(async()=>response('',302,start,{location}));
   await expect(readDirectDefuddlePage({url:start,scope},{root,fetcher})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
