import {describe,it,expect,vi} from 'vitest';
import {executionHooks} from '@/lib/ai/extensions/agent/claude/execution-hooks';
const input={hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'tool-1',tool_input:{command:'fixture'}} as const;
function hook(guard:()=>Promise<void>,controller=new AbortController()){
  return {controller,invoke:(signal=new AbortController().signal)=>executionHooks(guard,controller).hooks!.PreToolUse![0].hooks[0](input as any,'tool-1',{signal})};
}
describe('SDK execution hook independent of permission mode',()=>{
  it('preserves legacy options when no execution fence is supplied',()=>{
    expect(executionHooks(undefined,new AbortController())).toEqual({});
  });
  it('passes complete tool identity but does not grant permissions',async()=>{
    const guard=vi.fn().mockResolvedValue(undefined),test=hook(guard);
    expect(await test.invoke()).toEqual({});
    expect(guard).toHaveBeenCalledWith({toolUseId:'tool-1',toolName:'Bash',input:input.tool_input});
    expect(test.controller.signal.aborted).toBe(false);
  });
  it('explicitly denies and stops after a failed database fence',async()=>{
    const failure=Error('lease_lost'),test=hook(async()=>{throw failure;});
    expect(await test.invoke()).toMatchObject({continue:false,hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'}});
    expect(test.controller.signal.aborted).toBe(true);expect(test.controller.signal.reason).toBe(failure);
  });
  it('does not dispatch after host cancellation',async()=>{
    const guard=vi.fn(),controller=new AbortController();controller.abort();
    expect(await hook(guard,controller).invoke()).toMatchObject({continue:false});expect(guard).not.toHaveBeenCalled();
  });
  it('denies if cancelled while awaiting the fence',async()=>{
    const controller=new AbortController(),test=hook(async()=>{await Promise.resolve();controller.abort();},controller);
    expect(await test.invoke()).toMatchObject({continue:false});
  });
  it('honors SDK hook cancellation without treating it as authorization',async()=>{
    const signal=new AbortController(),guard=vi.fn();signal.abort();
    expect(await hook(guard).invoke(signal.signal)).toMatchObject({continue:false});expect(guard).not.toHaveBeenCalled();
  });
});
