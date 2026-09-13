import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({record:vi.fn(),policies:vi.fn(),events:vi.fn()}));
vi.mock('@/lib/interactions/service',()=>({recordWechatNewMessages:mocks.record,listInteractionEvents:mocks.events,markInteractionEventsProcessed:vi.fn()}));
vi.mock('@/lib/interactions/processing-jobs',()=>({createInteractionProcessingJob:vi.fn()}));
vi.mock('@/lib/knowledge-pipeline/source-policies',()=>({listInteractionSourcePolicies:mocks.policies}));
import {runInteractionIngestion} from '@/lib/knowledge-pipeline/ingestion-runtime';
beforeEach(()=>{
  vi.resetAllMocks();vi.stubEnv('KNOWLEDGE_PIPELINE_INGESTION_DISABLED','false');
  mocks.policies.mockResolvedValue([{enabled:true,policy:'sync',sourceId:'source-1'}]);mocks.events.mockResolvedValue([]);
});
afterEach(()=>vi.unstubAllEnvs());
it('preserves per-source warnings and exposes partial failure without losing counters',async()=>{
  mocks.record.mockResolvedValue({insertedCount:0,duplicateCount:0,eventCount:0,insertedEvents:[],sourceResults:[{sourceId:'source-1',warning:'wechat_history_unavailable'}]});
  const signal=new AbortController().signal;
  const result=await runInteractionIngestion({userId:'degraded-owner',reason:'scheduled',force:true,signal});
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({userId:'degraded-owner',signal}));
  expect(result).toMatchObject({isRunning:false,lastStatus:'error',lastError:'wechat_sources_partially_unavailable',lastResult:{insertedCount:0,sourceResults:[{warning:'wechat_history_unavailable'}]}});
});
it('does not read sources for an already cancelled scan',async()=>{
  await expect(runInteractionIngestion({userId:'cancelled-owner',reason:'scheduled',signal:AbortSignal.abort(new Error('stopped'))})).rejects.toThrow('stopped');
  expect(mocks.record).not.toHaveBeenCalled();expect(mocks.policies).not.toHaveBeenCalled();
});
