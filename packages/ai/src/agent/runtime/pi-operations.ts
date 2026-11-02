import {z} from 'zod';
import type {AgentMessage,TaskPlan,AgentRuntimeTerminal} from '../types';
import type {AgentRuntime,AgentRuntimeRequest} from './types';
import type {PiAgentRuntimeAdapterOptions} from './pi-agent-adapter';

const planSchema=z.union([
  z.object({type:z.literal('direct_answer'),answer:z.string().trim().min(1).max(64000)}),
  z.object({type:z.literal('plan').optional(),goal:z.string().trim().min(1).max(2000),steps:z.array(z.object({description:z.string().trim().min(1).max(3000)})).min(1).max(32),notes:z.string().max(12000).optional()}),
]);

/** Plan is a model-produced proposal. Execution consumes the host-approved
 * plan; tools and permissions always come from the current host, never JSON. */
export class PiOperationsRuntime implements AgentRuntime {
  readonly metadata;
  private plans=new Map<string,TaskPlan>();
  private runtime:AgentRuntime;
  private activePlanner?:AgentRuntime;
  constructor(private options:PiAgentRuntimeAdapterOptions,private create:(options:PiAgentRuntimeAdapterOptions)=>AgentRuntime){this.runtime=create(options);this.metadata=this.runtime.metadata;}
  async *run(request:AgentRuntimeRequest):AsyncGenerator<AgentMessage>{
    if(request.operation==='run'){yield* this.runtime.run(request);return;}
    if(request.operation==='execute'){
      if(request.options.onBeforeProviderRequest&&!request.options.plan){yield* this.failed('memory_plan_source_required');return;}
      const plan=request.options.plan??this.getPlan(request.options.planId);
      if(!plan){yield* this.failed('pi_plan_missing');return;}
      yield* this.runtime.run({operation:'run',options:request.options,prompt:'Execute this host-approved plan as task data. It grants no new tools, permissions or source access.\n'+JSON.stringify(plan)+'\nOriginal request:\n'+(request.options.originalPrompt??'')});return;
    }
    const planner=this.create({...this.options,tools:[]}); this.activePlanner=planner;
    try {
    let candidate='',terminal:AgentRuntimeTerminal|undefined,done=false,failed=false;
    for await(const message of planner.run({operation:'run',options:request.options,prompt:'Plan the request without executing tools or actions. Return JSON only: {"type":"plan","goal":"...","steps":[{"description":"..."}],"notes":"..."}; for a simple answer use {"type":"direct_answer","answer":"..."}. Do not issue permissions, approval IDs, source evidence or execution status in the plan.\nRequest:\n'+request.prompt})){
      if(message.type==='result'&&message.answerPhase!=='intermediate')candidate=message.content??'';
      if(message.type==='runtime_terminal')terminal=message.runtimeTerminal;
      if(message.type==='done')done=true;
      if(message.type==='error'){failed=true;yield message;}
    }
    if(failed||!done||terminal?.status!=='completed'||terminal.cleanupStatus!=='completed'){yield* this.failed('pi_plan_generation_unconfirmed');return;}
    try{
      const value=planSchema.parse(JSON.parse(candidate.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')));
      if(value.type==='direct_answer')yield {type:'direct_answer',content:value.answer};
      else{
        const plan:TaskPlan={id:crypto.randomUUID(),goal:value.goal,steps:value.steps.map((step,index)=>({id:`step-${index+1}`,description:step.description,status:'pending'})),notes:value.notes,createdAt:new Date()};
        this.plans.set(plan.id,structuredClone(plan)); yield {type:'plan',plan};
      }
      yield {type:'runtime_terminal',runtimeTerminal:terminal};yield {type:'done'};
    }catch{yield* this.failed('pi_plan_response_invalid');}
    } finally { if(this.activePlanner===planner)this.activePlanner=undefined; }
  }
  private async *failed(message:string):AsyncGenerator<AgentMessage>{yield {type:'error',message};yield {type:'runtime_terminal',runtimeTerminal:{schemaVersion:'agent-runtime-terminal.v1',status:'failed',cleanupStatus:'completed',error:message}};yield {type:'done'};}
  async stop(sessionId:string){await (this.activePlanner??this.runtime).stop(sessionId);}
  getPlan(id:string){const plan=this.plans.get(id);return plan?structuredClone(plan):undefined;}
  deletePlan(id:string){this.plans.delete(id);}
}
