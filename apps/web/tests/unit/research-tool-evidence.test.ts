import {expect,it} from 'vitest';
import {researchToolInput,researchToolResult} from '@/lib/loops/research-tool-evidence';
import {verifyLoopRun} from '@/lib/loops/verifier';
it('records bounded observations from actual JSON output without copying source or page bodies',()=>{
 const input=researchToolInput('Read',{path:'repo/a.ts',offset:2,limit:20,content:'secret'});
 expect(input).toEqual({path:'repo/a.ts',offset:2,limit:20});
 const result=researchToolResult('Read',JSON.stringify({path:'repo/a.ts',sha256:'a'.repeat(64),startLine:2,endLine:21,content:'private code'}));
 expect(result?.codebaseObservation).toMatchObject({startLine:2,endLine:21});
 expect(JSON.stringify(result)).not.toContain('private code');
 expect(researchToolResult('webReadPage',JSON.stringify({url:'https://arxiv.org/abs/1',content:'body',success:false,finalUrlVerified:false}))).toMatchObject({contentLength:4,success:false,finalUrlVerified:false});
 expect(researchToolResult('webReadPage','not JSON')).toMatchObject({contentLength:0});
 expect(researchToolResult('workshopWriteMemory',{content:'private memory'})).toBeUndefined();
});
it('integrates the scoped process verification without changing other delivery contracts',()=>{
 const run=(requiredFields:string[])=>verifyLoopRun({verificationConfig:{type:'structured_check',requiredFields},result:{status:'success',output:'done',duration:1,result:{structuredReport:{summary:'done',researchProcess:{status:'sufficient'}}}}});
 expect(run(['summary']).passed).toBe(true);
 const failed=run(['researchProcess']);expect(failed.passed).toBe(false);
 expect(failed.issues.some(issue=>issue.code==='invalid_research_process')).toBe(true);
});
