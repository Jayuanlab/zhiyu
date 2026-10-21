import {parseStructuredOutput} from '@/lib/types/execution-result';
import {verifyResearchProcess} from './research-process-verification';

/** The same business rules as Loop completion, evaluated before delivery. No
 * fixture answers, new memory requirement or permission grant is introduced. */
export function validateResearchOutput(text:string,requiredFields:string[],trace:unknown){
  const {data}=parseStructuredOutput(text),issues:string[]=[];
  for(const field of ['projectAssessment','checkpoint'])if(requiredFields.includes(field)){
    const value=data[field];if(!value||typeof value!=='object'||Array.isArray(value))issues.push(`${field} must be a structured JSON object`);
  }
  if(requiredFields.includes('warnings')&&!Array.isArray(data.warnings))issues.push('warnings must be a JSON array');
  if(requiredFields.includes('reportMarkdown')&&(typeof data.reportMarkdown!=='string'||!data.reportMarkdown.trim()))issues.push('reportMarkdown must contain the report text');
  issues.push(...verifyResearchProcess(requiredFields,data,trace));
  return issues.length?{ok:false as const,feedback:`The existing business output checks found: ${issues.join('; ')}. Correct the actual structured fields and evidence assertions within the existing tools and remaining budget. Do not invent observations or mark uncertain provenance verified. If required evidence is unavailable, report evidence_insufficient or degraded with the real gaps and the existing notification rules.`}:{ok:true as const};
}
