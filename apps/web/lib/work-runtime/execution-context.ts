import {AsyncLocalStorage} from 'node:async_hooks';
import type {ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';

const execution = new AsyncLocalStorage<Readonly<ExecutionLease>>();
const keys = ['userId','workshopId','runId','workerId','token'] as const;

/** A server-owned capability, never accepted from model arguments or HTTP JSON.
 * Snapshot it so a delayed callback cannot inherit a mutated capability. */
export function resolveExecutionLease(explicit?:ExecutionLease):Readonly<ExecutionLease>|undefined {
  const current=execution.getStore();
  if(current && explicit && keys.some(key=>current[key]!==explicit[key])) throw new ExecutionLeaseError('invalid_lease');
  return current ?? (explicit ? Object.freeze({...explicit}) : undefined);
}

/** Scope follows async descendants, not unrelated requests or other workers.
 * This propagates identity only; database adapters must still check the lease
 * inside their transaction. It does not authorize unfenced external effects. */
export function withExecutionContext<T>(lease:ExecutionLease|undefined,work:()=>T):T {
  const resolved=resolveExecutionLease(lease);
  return resolved ? execution.run(resolved,work) : work();
}
