import {ModuleSupervisor,type RuntimeModule} from './module-supervisor';
import type {HostLease,RuntimeHostStore} from './host-store';

type Store=Pick<RuntimeHostStore,'acquire'|'heartbeat'|'release'>;
export class RuntimeHostController {
  private readonly supervisor:ModuleSupervisor;
  private lease:HostLease|null=null;
  private busy=false;
  private paused=false;
  private stopping=false;
  private phase:'idle'|'running'|'paused'|'stopping'|'stopped'|'lost'='idle';
  private error:string|null=null;
  private expiryTimer:ReturnType<typeof setTimeout>|undefined;
  constructor(private readonly options:{store:Store;ownerId:string;instanceId:string;mode:'worker'|'embedded';
    ttlMs:number;modules:RuntimeModule[];enabled:()=>boolean}){
    if(!Number.isSafeInteger(options.ttlMs)||options.ttlMs<1000||options.ttlMs>300000)throw Error('invalid_host_lease_duration');
    this.supervisor=new ModuleSupervisor(options.modules);
  }
  snapshot(){return {phase:this.phase,error:this.error,lease:this.lease,...this.supervisor.snapshot()};}
  pause(){this.paused=true;this.supervisor.pause();}
  resume(){if(!this.stopping&&this.phase!=='lost')this.paused=false;}
  private unavailable(){return this.stopping||this.phase==='lost'||this.phase==='stopped';}
  private lose(reason:string){
    if(this.expiryTimer!==undefined)clearTimeout(this.expiryTimer);
    this.phase='lost';this.error=reason;this.supervisor.pause();
    void this.supervisor.stop(0);
  }
  /** Called periodically by the process host; never overlaps a pending database operation. */
  async step(){
    if(this.busy||this.unavailable())return;
    if(!this.options.enabled()){await this.stop(0);return;}
    this.busy=true;
    const started=performance.now();
    // A hung database call cannot leave task dispatch enabled past this local deadline.
    const deadline=setTimeout(()=>this.lose('host_lease_confirmation_timeout'),this.options.ttlMs);
    try{
      if(!this.lease){
        const lease=await this.options.store.acquire(this.options.ownerId,this.options.instanceId,this.options.mode,this.options.ttlMs);
        if(!lease){this.lose('host_lease_held_elsewhere');return;}
        this.lease=lease;
      }
      if(this.unavailable()){
        if(!this.supervisor.snapshot().modules.some(module=>module.inFlight))await this.options.store.release(this.lease,this.supervisor.snapshot().modules);
        return;
      }
      const confirmed=await this.options.store.heartbeat(this.lease,this.options.ttlMs,this.supervisor.snapshot().modules,this.paused?'paused':'running');
      if(!confirmed){this.lose('host_lease_lost');return;}
      if(this.unavailable())return;
      if(!this.options.enabled()){await this.stop(0);return;}
      if(this.expiryTimer!==undefined)clearTimeout(this.expiryTimer);
      const remaining=this.options.ttlMs-(performance.now()-started);
      if(remaining<=0){this.lose('host_lease_confirmation_timeout');return;}
      this.expiryTimer=setTimeout(()=>this.lose('host_lease_confirmation_timeout'),remaining);
      if(this.paused){this.phase='paused';this.supervisor.pause();}
      else{this.phase='running';this.supervisor.start();this.supervisor.tick();}
    }catch{
      this.lose('host_storage_unavailable');
    }finally{clearTimeout(deadline);this.busy=false;}
  }
  async stop(graceMs:number){
    if(this.expiryTimer!==undefined)clearTimeout(this.expiryTimer);
    this.stopping=true;this.phase='stopping';
    const result=await this.supervisor.stop(graceMs);
    if(this.lease){
      try{
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const persisted=await Promise.race([
            result.settled?this.options.store.release(this.lease,this.supervisor.snapshot().modules):
              this.options.store.heartbeat(this.lease,this.options.ttlMs,this.supervisor.snapshot().modules,'stopped'),
            new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),this.options.ttlMs);})]);
          if(persisted!==true){this.lose(persisted===null?'host_stop_confirmation_timeout':'host_lease_lost');return result;}
        }finally{if(timer!==undefined)clearTimeout(timer);}
      }catch{this.lose('host_storage_unavailable');return result;}
    }
    this.phase=result.settled?'stopped':'stopping';
    return result;
  }
}
