import {withExecutionBusinessWrite,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';

/** This check stops dispatch. Durable writes still need their transaction fence. */
export function createExecutionGuard(lease:ExecutionLease,controller:AbortController){
  const capability=Object.freeze({...lease});
  return async()=>{
    try{
      if(controller.signal.aborted)throw new ExecutionLeaseError('lease_lost');
      await withExecutionBusinessWrite(capability,async()=>undefined);
      if(controller.signal.aborted)throw new ExecutionLeaseError('lease_lost');
    }catch(error){controller.abort(error);throw error;}
  };
}
