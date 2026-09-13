import type {ExecuteJobOptions,JobExecutionContext,JobExecutionResult} from './types';
import {LoopMigrationRequiredError} from '@/lib/loops/execution-boundary';

// Compatibility exports fail explicitly: execution belongs to Work commands.
export const REASON_USER_STOPPED='user_stopped';
export const customJobHandlers:Readonly<Record<string,(context:JobExecutionContext)=>Promise<JobExecutionResult>>>=Object.freeze({});
export function registerCustomHandler(_name:string,_handler:(context:JobExecutionContext)=>Promise<JobExecutionResult>):never{
  throw new LoopMigrationRequiredError();
}
export async function executeJob(_context:JobExecutionContext,_configuration:string,_description?:string,_options?:ExecuteJobOptions):Promise<JobExecutionResult>{
  throw new LoopMigrationRequiredError();
}
