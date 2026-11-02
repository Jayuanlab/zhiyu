import {describe,it,expect} from 'vitest';
import {createFauxCore,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {createAgentRuntime,resolveAgentRuntimeEngine,AgentRuntimeUnavailableError} from '@/lib/ai/runtime/agent-factory';
import {createPiRuntimeOptionsFromModelConfig} from '@openzhiyu/ai/agent/runtime';
async function collect(source:AsyncGenerator<any>){const messages=[];for await(const message of source)messages.push(message);return messages;}
describe('Pi-only runtime factory',()=>{
 it('uses Pi by default and rejects retired or unknown execution engines',()=>{
  expect(resolveAgentRuntimeEngine()).toBe('pi');expect(resolveAgentRuntimeEngine('pi')).toBe('pi');
  for(const engine of ['claude','typo'])expect(()=>resolveAgentRuntimeEngine(engine)).toThrow(AgentRuntimeUnavailableError);
 });
 it('does not synthesize a model or fall back when Pi is unconfigured',()=>{expect(()=>createAgentRuntime({})).toThrow(AgentRuntimeUnavailableError);});
 it('runs the actual Pi Harness when options are supplied',async()=>{
  const faux=createFauxCore({});faux.setResponses([fauxAssistantMessage('pi-only')]);
  const runtime=createAgentRuntime({pi:{model:faux.getModel(),streamFn:faux.streamSimple}});
  expect(runtime.metadata).toMatchObject({engine:'pi',adapter:'pi-agent-harness'});
  const messages=await collect(runtime.run({operation:'run',prompt:'test'}));
  expect(messages).toContainEqual(expect.objectContaining({type:'result',content:'pi-only'}));
  expect(messages).toContainEqual(expect.objectContaining({type:'runtime_terminal',runtimeTerminal:expect.objectContaining({status:'completed',cleanupStatus:'completed'})}));
 });
 it.each(['openai-completions','openai-responses','anthropic-messages'] as const)('constructs Pi using %s without a second execution engine',protocol=>{
  const runtime=createAgentRuntime({pi:createPiRuntimeOptionsFromModelConfig({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',protocol})});
  expect(runtime.metadata.engine).toBe('pi');
 });
});
