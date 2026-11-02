import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({run:vi.fn(),create:vi.fn(),guard:vi.fn()}));
vi.mock('@/lib/db/user-queries',()=>({getUserTypeForService:async()=> 'internal'}));
vi.mock('@/lib/db/insight-queries',()=>({getUserInsightSettings:async()=> ({})}));
vi.mock('@/lib/ai/model-configuration',()=>({requireModelConfiguration:async()=> ({apiKey:'fixture',model:'same-model',protocol:'openai_responses'})}));
vi.mock('@/lib/ai/runtime/register-plugins',()=>({registerPlugins:()=>{}}));
vi.mock('@/lib/ai/tools/platform-tools',()=>({createPlatformPiTools:()=>[]}));
vi.mock('@/lib/loops',()=>({resolveChatLoopGuardContext:state.guard,evaluateChatToolActionGuard:()=>({decisions:[]})}));
vi.mock('@/lib/ai',()=>({prepareConversationWindows:()=>({immediate:[],candidatesForCompaction:[]}),triggerCompactionAsync:vi.fn()}));
vi.mock('@openzhiyu/ai/store',()=>({saveCompactionSummary:vi.fn()}));
vi.mock('@openzhiyu/ai/agent/registry',()=>({getAgentRegistry:()=>({create:state.create})}));
import {handleAgentRuntime} from '@/lib/ai/runtime/shared';
beforeEach(()=>{vi.clearAllMocks();state.guard.mockResolvedValue(null);state.create.mockReturnValue({run:state.run});});
describe('Pi connector delivery boundary',()=>{
 it('delivers only a final candidate after a confirmed terminal, preserving the full reply',async()=>{const reply=vi.fn();state.run.mockImplementation(async function*(){yield {type:'text',content:'draft not for delivery'};yield {type:'result',content:'intermediate',answerPhase:'intermediate'};yield {type:'result',content:'x'.repeat(8500),answerPhase:'candidate_final'};expect(reply).not.toHaveBeenCalled();yield {type:'runtime_terminal',runtimeTerminal:{status:'completed',cleanupStatus:'completed'}};yield {type:'done'};});await handleAgentRuntime('fixture',{userId:'owner'},reply,'telegram');expect(state.create).toHaveBeenCalledWith(expect.objectContaining({provider:'pi',providerConfig:{protocol:'openai-responses'}}));expect(reply.mock.calls.map(([text])=>text).join('')).toBe('x'.repeat(8500));});
 it.each(['failed','missing'])('does not deliver a draft for a %s cleanup/terminal',async mode=>{const reply=vi.fn();state.run.mockImplementation(async function*(){yield {type:'result',content:'secret draft'};if(mode==='failed')yield {type:'runtime_terminal',runtimeTerminal:{status:'completed',cleanupStatus:'failed'}};yield {type:'done'};});await handleAgentRuntime('fixture',{userId:'owner'},reply,'telegram');expect(reply).toHaveBeenCalledOnce();expect(reply.mock.calls[0][0]).not.toContain('secret draft');});
 it('does not continue after permission context lookup fails',async()=>{state.guard.mockRejectedValue(Error('guard unavailable'));await handleAgentRuntime('fixture',{userId:'owner'},vi.fn(),'telegram');expect(state.create).not.toHaveBeenCalled();expect(state.run).not.toHaveBeenCalled();});
});
