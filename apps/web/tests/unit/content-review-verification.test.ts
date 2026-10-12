import {describe,expect,it} from 'vitest';
import {verifyLoopRun} from '@/lib/loops/verifier';

const fields=['contentMarkdown','readerReview','revisionSummary','contentDecision','blockers'];
const report={contentMarkdown:'# Example\nA concrete explanation.',readerReview:{checkedDimensions:['clarity','evidence'],findings:[]},revisionSummary:'Reviewed; no material changes required.',contentDecision:'ready_for_owner_review',blockers:[]};
function verify(value:unknown,requiredFields=fields){return verifyLoopRun({verificationConfig:{type:'structured_check',requiredFields,requiredSources:[]},result:{status:'success',output:'Content delivered.',duration:1,result:{structuredReport:value}}});}
describe('content delivery verification',()=>{
 it('rejects prose field markers posing as a completed review',()=>{
  const value=verify({...report,readerReview:'Looks good'});expect(value.passed).toBe(false);expect(value.issues.some(i=>i.code==='invalid_content_review')).toBe(true);
 });
 it('rejects missing concrete rewrite details',()=>{
  expect(verify({...report,readerReview:{checkedDimensions:['clarity'],findings:[{reason:'Unclear'}]}}).passed).toBe(false);
 });
 it('rejects ready status when a serious finding remains unresolved',()=>{
  expect(verify({...report,readerReview:{checkedDimensions:['accuracy'],findings:[{location:'Opening',excerpt:'Everyone can automate production',readerQuestion:'Under what conditions?',reason:'Evidence too narrow',severity:'high',suggestedRewrite:'Limit the claim to the cited example',resolution:'unresolved'}]}}).passed).toBe(false);
 });
 it('accepts an honest blocked delivery and allows no invented findings',()=>{
  expect(verify(report).passed).toBe(true);
  expect(verify({...report,contentMarkdown:'',contentDecision:'blocked',blockers:['Original source unavailable']}).passed).toBe(true);
 });
 it('rejects empty ready content and unexplained blocked status',()=>{
  expect(verify({...report,contentMarkdown:' '}).passed).toBe(false);
  expect(verify({...report,contentDecision:'blocked'}).passed).toBe(false);
 });
 it('does not activate for other workshop delivery contracts',()=>{
  expect(verify({summary:'Other work'},['summary']).passed).toBe(true);
 });
 it('rejects cross-reference placeholders even when they are non-empty',()=>{
  for(const contentMarkdown of ['（见上方完整文章）','同上','See above'])expect(verify({...report,contentMarkdown}).passed).toBe(false);
  expect(verify({...report,contentMarkdown:'# Example\nThe procedure below uses the results above.'}).passed).toBe(true);
 });
 it('rejects a repost classified twice as primary and secondary',()=>{
  const source={source:'Official announcement through repost',url:'https://example.com/story',authority:'primary',contentLevel:'full text',supportedClaims:['Release date']};
  expect(verify({...report,sourceEvidence:[source,{...source,source:'Repost',url:source.url+'#summary',authority:'secondary'}]},[...fields,'sourceEvidence']).passed).toBe(false);
  expect(verify({...report,sourceEvidence:[{...source,source:'Original release'}]},[...fields,'sourceEvidence']).passed).toBe(true);
 });
 it('rejects description strings pretending to be coverage URLs',()=>{
  const discoveryCoverage={window:'Current run',checkedAreas:[{area:'Community',queries:['AI tools'],sourceUrls:['Multiple blog articles'],status:'checked',reason:'Searched'}],gaps:[]};
  expect(verify({...report,discoveryCoverage},[...fields,'discoveryCoverage']).passed).toBe(false);
  expect(verify({...report,discoveryCoverage:{...discoveryCoverage,checkedAreas:[{...discoveryCoverage.checkedAreas[0],sourceUrls:['https://example.com/project']}]}},[...fields,'discoveryCoverage']).passed).toBe(true);
 });
});
