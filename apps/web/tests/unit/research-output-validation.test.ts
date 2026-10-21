import {describe,expect,it} from 'vitest';
import {validateResearchOutput} from '@/lib/loops/research-output-validation';
const fields=['reportMarkdown','researchProcess','projectAssessment','checkpoint','warnings'];
const report=()=>({reportMarkdown:'A provisional report',researchProcess:{status:'evidence_insufficient',question:'Which current source establishes the claim?',sourceEvidence:[],externalEvidence:[],gaps:['The primary source could not be independently retrieved'],nextStep:'Read a current authorized primary source'},
 projectAssessment:{materialChange:false,notificationIntent:'quiet'},checkpoint:{nextQuestions:['Read the primary source']},warnings:['Source unavailable']});
const fenced=(r:unknown)=>'```json\n'+JSON.stringify(r)+'\n```';
describe('ordinary research delivery checks',()=>{
 it('accepts an honest incomplete study without manufacturing success or new memory requirements',()=>{
  expect(validateResearchOutput(fenced(report()),fields,{events:[]})).toEqual({ok:true});
 });
 it('does not mistake code fences inside a report string for the structured object boundary',()=>{
  expect(validateResearchOutput(fenced({...report(),reportMarkdown:'Observed code:\n```ts\nconst x = {};\n```\nStill provisional.'}),fields,{events:[]})).toEqual({ok:true});
 });
 it('rejects missing typed records and unobserved sufficient claims',()=>{
  expect(validateResearchOutput(fenced({...report(),checkpoint:'saved'}),fields,{events:[]}).ok).toBe(false);
  const r=report();r.researchProcess.status='sufficient';expect(validateResearchOutput(fenced(r),fields,{events:[]}).ok).toBe(false);
 });
});
