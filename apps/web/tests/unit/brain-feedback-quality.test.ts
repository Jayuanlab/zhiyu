import { describe, expect, it } from 'vitest';
import { buildBrainRecallQualityReport, type BrainRecallQualityFeedback } from '@/lib/brain/recall-quality';
const base = { workshopId: 'platform', outcome: 'missing' as const, createdAt: '2026-09-08T00:00:00Z' };
describe('feedback quality sample boundaries', () => {
  it('separates verified, unlinked, legacy and inconsistent associations', () => {
    const feedback: BrainRecallQualityFeedback[] = [
      { ...base, contextLogId: 'verified', associationStatus: 'verified_context' },
      { ...base, contextLogId: null, associationStatus: 'unlinked' },
      { ...base, contextLogId: 'legacy' },
      { ...base, contextLogId: null, associationStatus: 'verified_context' },
      { ...base, contextLogId: 'contradiction', associationStatus: 'unlinked' },
    ];
    const report = buildBrainRecallQualityReport({logs:[],feedback});
    expect(report.feedbackQuality).toMatchObject({sampledFeedbackCount:5,verifiedContextCount:1,unlinkedCount:1,legacyUnverifiedCount:1,invalidAssociationCount:2,verifiedContextOutsideLogSampleCount:1,verifiedAssociationRate:0.2});
    expect(report.feedbackOutcomes.missing).toBe(5);
    expect(report.verifiedFeedbackOutcomes.missing).toBe(1);
    expect(report.assessments.observability.canAssessMissingRecall).toBe(true);
    expect(report.feedbackTraceDiagnosticsByLoop).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('contradiction');
  });
  it('does not interpret unverified opinions as traceable ranking or freshness evidence', () => {
    const report = buildBrainRecallQualityReport({logs:[],feedback:[
      {...base,contextLogId:'legacy',outcome:'used'},
      {...base,contextLogId:null,associationStatus:'unlinked',outcome:'stale'},
    ]});
    expect(report.assessments.observability).toMatchObject({feedbackStatus:'observed',canAssessMissingRecall:false,canAssessRanking:false,canAssessFreshness:false});
    expect(report.feedbackQuality.verifiedAssociationRate).toBe(0);
  });
  it('returns a null rate for no sampled feedback', () => {
    expect(buildBrainRecallQualityReport({logs:[],feedback:[]}).feedbackQuality.verifiedAssociationRate).toBeNull();
  });
});
