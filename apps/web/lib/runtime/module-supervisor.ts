export type ModulePhase='idle'|'running'|'stopping'|'success'|'error'|'settled_after_abort';
export type RuntimeModule={name:string;intervalMs:number;timeoutMs:number;run:(signal:AbortSignal)=>Promise<unknown>};
export type RuntimeModuleState={name:string;phase:ModulePhase;inFlight:boolean;lastStartedAt:number|null;
  lastCompletedAt:number|null;lastSuccessAt:number|null;nextRunAt:number;lastError:string|null;
  durationMs:number|null;skipReason:string|null;skipped:number};
type Slot={definition:RuntimeModule;state:RuntimeModuleState;controller?:AbortController;settled?:Promise<void>};

/** Process-local occupancy only. The host must acquire its durable lease before ticking. */
export class ModuleSupervisor {
  private accepting=false;
  private readonly slots:Slot[];
  constructor(definitions:RuntimeModule[],private readonly now:()=>number=Date.now){
    const names=new Set<string>();
    this.slots=definitions.map(definition=>{
      if(!definition.name.trim()||names.has(definition.name)||!Number.isSafeInteger(definition.intervalMs)||definition.intervalMs<1
        ||definition.intervalMs>2147483647||!Number.isSafeInteger(definition.timeoutMs)||definition.timeoutMs<1||definition.timeoutMs>2147483647)throw new Error('invalid_runtime_module');
      names.add(definition.name);
      return {definition,state:{name:definition.name,phase:'idle',inFlight:false,lastStartedAt:null,lastCompletedAt:null,
        lastSuccessAt:null,nextRunAt:0,lastError:null,durationMs:null,skipReason:null,skipped:0}};
    });
  }
  start(){this.accepting=true;}
  /** Pause future starts without pretending to cancel an existing action. */
  pause(){this.accepting=false;}
  snapshot(){return {accepting:this.accepting,modules:this.slots.map(slot=>({...slot.state}))};}
  tick(){
    if(!this.accepting)return;
    for(const slot of this.slots){
      if(slot.state.inFlight){slot.state.skipReason='previous_run_unsettled';slot.state.skipped++;continue;}
      if(this.now()<slot.state.nextRunAt)continue;
      this.launch(slot);
    }
  }
  private launch(slot:Slot){
    const state=slot.state,controller=new AbortController(),started=this.now();
    slot.controller=controller;
    Object.assign(state,{phase:'running',inFlight:true,lastStartedAt:started,lastError:null,durationMs:null,skipReason:null});
    const deadline=setTimeout(()=>{
      if(!state.inFlight)return;
      state.phase='stopping';state.lastError='deadline_exceeded';controller.abort('deadline_exceeded');
    },slot.definition.timeoutMs);
    slot.settled=Promise.resolve().then(()=>controller.signal.aborted?undefined:slot.definition.run(controller.signal)).then(()=>{
      if(controller.signal.aborted)state.phase='settled_after_abort';
      else {state.phase='success';state.lastSuccessAt=this.now();}
    },error=>{
      state.phase=controller.signal.aborted?'settled_after_abort':'error';
      if(!controller.signal.aborted)state.lastError=error instanceof Error?error.message:String(error);
    }).finally(()=>{
      clearTimeout(deadline);
      state.inFlight=false;state.lastCompletedAt=this.now();state.durationMs=Math.max(0,this.now()-started);
      state.nextRunAt=this.now()+slot.definition.intervalMs;state.skipReason=null;slot.controller=undefined;
    });
  }
  /** Abort is a request, not evidence that an external effect was cancelled. */
  async stop(graceMs:number){
    if(!Number.isSafeInteger(graceMs)||graceMs<0||graceMs>2147483647)throw new Error('invalid_stop_grace');
    this.pause();
    const active=this.slots.filter(slot=>slot.state.inFlight);
    for(const slot of active){
      slot.state.phase='stopping';slot.state.lastError??='stop_requested';slot.controller?.abort('stop_requested');
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([Promise.all(active.map(slot=>slot.settled)),new Promise(resolve=>{timer=setTimeout(resolve,graceMs);})]);
    }finally{if(timer!==undefined)clearTimeout(timer);}
    return {settled:active.every(slot=>!slot.state.inFlight),unsettled:active.filter(slot=>slot.state.inFlight).map(slot=>slot.definition.name)};
  }
}
