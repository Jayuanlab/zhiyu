import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({generate:vi.fn(),events:vi.fn(),mark:vi.fn(),claim:vi.fn(),fail:vi.fn(),complete:vi.fn(),summary:vi.fn(),provider:vi.fn(),begin:vi.fn(),note:vi.fn()}));
vi.mock('ai',async original=>({...await original<typeof import('ai')>(),generateText:mocks.generate}));
vi.mock('@/lib/ai',()=>({getModelProvider:mocks.provider}));
vi.mock('@/lib/ai/user-llm-api-settings',()=>({getUserLlmProviderConfig:async()=>({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'fixture'})}));
vi.mock('@/lib/interactions/service',()=>({getInteractionEventsByIds:mocks.events,markInteractionEventsProcessed:mocks.mark,
  createInteractionSummaryNoteFromEvents:mocks.summary,createInteractionNote:mocks.note}));
vi.mock('@/lib/interactions/processing-jobs',()=>({claimInteractionProcessingJob:mocks.claim,failInteractionProcessingJob:mocks.fail,completeInteractionProcessingJob:mocks.complete,beginInteractionProcessingWrites:mocks.begin,assertInteractionProcessingWrites:async()=>{},applyInteractionProcessingWrites:async(_attempt:unknown,work:()=>Promise<unknown>)=>work()}));
vi.mock('@/lib/interactions/graph',()=>({}));
vi.mock('@/lib/interactions/scenarios',()=>({}));
vi.mock('@/lib/knowledge-pipeline/source-policies',()=>({listInteractionSourcePolicies:async()=>[]}));
vi.mock('@/lib/interactions/processing-plans',()=>({readInteractionProcessingPlan:async()=>null,saveInteractionProcessingPlan:async()=> 'hash',interactionPlanContext:async()=> 'context'}));
import {processInteractionEvents} from '@/lib/interactions/processor';
beforeEach(()=>{
  vi.resetAllMocks();
  for(const key of ['INTERACTION_PROCESSOR_LLM_API_KEY','INTERACTION_PROCESSOR_LLM_BASE_URL'])vi.stubEnv(key,'');
  mocks.events.mockResolvedValue([{id:'event-1',content:'fixture',messageTime:new Date()}]);mocks.claim.mockResolvedValue({id:'job-1',attempts:1,eventIds:['event-1'],processingMode:'full'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected external fetch');}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('does not append a fallback summary after a derived write fails',async()=>{
  mocks.generate.mockResolvedValueOnce({text:JSON.stringify({summary:'analysis'})}).mockResolvedValueOnce({text:JSON.stringify({notes:[{title:'result',body:'derived',sourceEventIds:['event-1']}],tasks:[],memories:[]})});
  mocks.note.mockRejectedValue(Error('write failed after boundary'));
  await expect(processInteractionEvents({userId:'owner',eventIds:['event-1'],processingJobId:'job-1'})).rejects.toThrow('write failed after boundary');
  expect(mocks.begin).toHaveBeenCalledWith({userId:'owner',jobId:'job-1',attempt:1});
  expect(mocks.note).toHaveBeenCalledTimes(1);expect(mocks.summary).not.toHaveBeenCalled();
  expect(mocks.note).toHaveBeenCalledWith(expect.objectContaining({metadata:expect.objectContaining({processingJobId:'job-1',processingAttempt:1})}));
  expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({attempt:1}));
  expect(mocks.complete).not.toHaveBeenCalled();
});
it('cancelled model request fails the claimed job without another provider, summary or completion',async()=>{
  const controller=new AbortController();
  mocks.generate.mockImplementation(({abortSignal})=>new Promise((_,reject)=>{
    expect(abortSignal).toBe(controller.signal);
    abortSignal.addEventListener('abort',()=>reject(new Error('cancelled model')),{once:true});
  }));
  const request=processInteractionEvents({userId:'owner',eventIds:['event-1'],processingJobId:'job-1',signal:controller.signal});
  const rejected=expect(request).rejects.toThrow('host stop');
  await vi.waitFor(()=>expect(mocks.generate).toHaveBeenCalledTimes(1));
  controller.abort(new Error('host stop'));await rejected;
  expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({jobId:'job-1',retryAt:expect.any(Date)}));
  expect(mocks.mark).not.toHaveBeenCalled();
  expect(mocks.summary).not.toHaveBeenCalled();expect(mocks.complete).not.toHaveBeenCalled();expect(mocks.provider).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('an already cancelled request does not read events or claim a job',async()=>{
  await expect(processInteractionEvents({userId:'owner',eventIds:['event-1'],signal:AbortSignal.abort(new Error('stopped'))})).rejects.toThrow('stopped');
  expect(mocks.events).not.toHaveBeenCalled();expect(mocks.claim).not.toHaveBeenCalled();
});
