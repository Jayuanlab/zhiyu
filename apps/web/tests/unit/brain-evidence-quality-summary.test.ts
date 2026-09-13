import {describe,it,expect} from 'vitest';
import {summarizeEvidenceQuality} from '@/lib/brain/evidence-quality-summary';
const quality=(requested:number,resolved:number,unresolved:number,notChecked:number)=>({requested,resolved,unresolved,notChecked,memoriesWithoutRefs:0,checkedAt:'2026-09-08T12:00:00.000Z'});
describe('evidence quality denominators',()=>{
  it('separates old/invalid audits from actual sampled observations',()=>{
    const report=summarizeEvidenceQuality([
      {},{evidenceReadAudit:{status:'executed',quality:quality(1,0,1,0)}},
      {evidenceReadAudit:{status:'degraded',quality:quality(4,2,1,1)}},
      {evidenceReadAudit:{status:'failed',quality:quality(6,0,0,6)}},
    ]);
    expect(report).toMatchObject({sampledRecallCount:4,auditedRecallCount:2,missingAuditCount:1,invalidAuditCount:1,requestedReferences:10,resolvedReferences:2,unresolvedReferences:1,notCheckedReferences:7,auditCoverage:0.5,resolvedReferenceRate:0.2,resolutionDenominator:10});
  });
  it('does not invent a zero or perfect rate for absent reference observations',()=>{
    expect(summarizeEvidenceQuality([])).toMatchObject({auditCoverage:null,resolvedReferenceRate:null,resolutionDenominator:0});
    expect(summarizeEvidenceQuality([{},{}])).toMatchObject({auditCoverage:0,resolvedReferenceRate:null,missingAuditCount:2});
    expect(summarizeEvidenceQuality([{evidenceReadAudit:{status:'skipped',quality:quality(0,0,0,0)}}])).toMatchObject({auditedRecallCount:1,resolvedReferenceRate:null});
  });
  it('excludes malformed counts and timestamps',()=>{
    const bad=[quality(2,1,0,0),quality(-1,-1,0,0),{...quality(1,1,0,0),checkedAt:'unknown'}];
    expect(summarizeEvidenceQuality(bad.map(q=>({evidenceReadAudit:{status:'degraded',quality:q}})))).toMatchObject({invalidAuditCount:3,auditedRecallCount:0,resolvedReferenceRate:null});
  });
});
