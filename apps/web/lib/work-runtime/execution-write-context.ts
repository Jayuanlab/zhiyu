import {AsyncLocalStorage} from 'node:async_hooks';
import type {ExecutionLease} from './execution-lease';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {ExecutionLeaseError} from './execution-errors';
import {withExecutionContext} from './execution-context';
type Scope={lease:ExecutionLease;context:WorkshopWriteContext;active:boolean};
const storage=new AsyncLocalStorage<Scope>();
const identity=['userId','workshopId','runId','workerId','token'] as const;
export function currentExecutionWriteContext(lease:ExecutionLease){
  const scope=storage.getStore();
  if(!scope)return undefined;
  if(!scope.active||identity.some(key=>scope.lease[key]!==lease[key]))throw new ExecutionLeaseError('invalid_lease');
  return scope.context;
}
/** Only database operations awaited by this callback may join the transaction.
 * Escaped async descendants retain a closed scope and cannot reuse it. */
export async function withExecutionWriteContext<T>(lease:ExecutionLease,context:WorkshopWriteContext,work:()=>Promise<T>){
  const parent=currentExecutionWriteContext(lease);
  if(parent&&parent.db!==context.db)throw new ExecutionLeaseError('invalid_lease');
  const scope={lease:Object.freeze({...lease}),context,active:true};
  try{return await storage.run(scope,()=>withExecutionContext(lease,work));}finally{scope.active=false;}
}
