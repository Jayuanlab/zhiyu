import type {Options} from '@anthropic-ai/claude-agent-sdk';
import type {AgentOptions} from '@openzhiyu/ai/agent/types';

/** Independent of interactive permissions. Success leaves the SDK's policy
 * unchanged; failure explicitly denies and stops, rather than throwing from a
 * hook that the SDK might treat as an optional hook failure. */
export function executionHooks(guard:AgentOptions['onBeforeToolUse'],controller:AbortController):Pick<Options,'hooks'> {
  if(!guard)return {};
  return {hooks:{PreToolUse:[{hooks:[async(input,_toolUseId,{signal})=>{
    try{
      if(controller.signal.aborted || signal.aborted)throw Error('Execution stopped');
      if(input.hook_event_name!=='PreToolUse')throw Error('Unexpected execution hook');
      await guard({toolUseId:input.tool_use_id,toolName:input.tool_name,input:input.tool_input});
      if(controller.signal.aborted || signal.aborted)throw Error('Execution stopped');
      return {};
    }catch(error){
      controller.abort(error);
      return {continue:false,stopReason:'Execution guard rejected tool',hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Execution is no longer authorized'}};
    }
  }]}]}};
}
