import {renewExecutionLease,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';

/** Serial renewal with joined shutdown. A failed renewal aborts the executor;
 * transaction fences remain the authority for every durable write. */
export async function startExecutionHeartbeat(lease:ExecutionLease,controller:AbortController,leaseMs=60000){
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000)throw new ExecutionLeaseError('invalid_lease');
  const capability=Object.freeze({...lease});
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let pending:Promise<void>|undefined;
  const cancel=()=>{stopped=true;if(timer)clearTimeout(timer);timer=undefined;};
  const renew=async()=>{
    if(controller.signal.aborted)throw new ExecutionLeaseError('lease_lost');
    await renewExecutionLease(capability,leaseMs);
  };
  const schedule=()=>{
    if(stopped||controller.signal.aborted)return;
    timer=setTimeout(()=>{
      timer=undefined;
      pending=renew().catch(error=>{cancel();controller.abort(error);}).finally(()=>{pending=undefined;schedule();});
    },Math.floor(leaseMs/3));
    timer.unref();
  };
  try{await renew();}catch(error){controller.abort(error);throw error;}
  controller.signal.addEventListener('abort',cancel,{once:true});
  schedule();
  return {
    async stop(){cancel();controller.signal.removeEventListener('abort',cancel);await pending;},
  };
}
