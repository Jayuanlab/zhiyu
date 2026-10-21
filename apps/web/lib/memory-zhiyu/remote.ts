import fs from 'node:fs';
import {createRemoteMemoryClient} from '../../../../packages/memory/src/http';
import {MemoryModuleError} from '@/lib/memory/kernel/errors';
import {createOwnerContext,authorizeZhiyuOwnerContext} from './identity';
import type {BrainRequester} from '@/lib/memory/kernel/memory-types';
export type MemoryConnection={mode:'local'|'remote';ownerId:string;origin:string;token:string};
export function memoryConnection(ownerId:string):MemoryConnection|null{
 const file=process.env.ZHIYU_MEMORY_CONNECTION_FILE;
 if(!file)return null;
 try{
  const config=JSON.parse(fs.readFileSync(file,'utf8')) as MemoryConnection;
  if(!['local','remote'].includes(config.mode)||config.ownerId!==ownerId||!/^Bearer [A-Za-z0-9_-]{43}$/.test('Bearer '+config.token))throw Error('invalid');
  createRemoteMemoryClient(config.origin,config.token);
  return config;
 }catch{throw new MemoryModuleError('memory_remote_configuration_invalid',503,'Memory connection configuration is invalid');}
}
export async function callRemoteMemory(ownerId:string,operation:string,input:unknown):Promise<any>{
 const config=memoryConnection(ownerId);
 if(!config||config.mode!=='remote')throw new MemoryModuleError('memory_remote_not_enabled',503,'Remote memory is not enabled');
 try{return await createRemoteMemoryClient(config.origin,config.token).request('/v1/project/call',{operation,input});}
 catch(error){
  const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'memory_remote_outcome_unknown';
  const status=error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'?error.status:503;
  throw new MemoryModuleError(code,status,'Remote memory request failed; do not replay a write with a new command ID');
 }
}
export async function routeOwnerMemory<T>(ownerId:string,operation:string,input:unknown,local:()=>Promise<T>):Promise<T>{
 const config=memoryConnection(ownerId);
 return config?.mode==='remote'?callRemoteMemory(ownerId,operation,input):local();
}
export function remoteOwnerOperation(requester:BrainRequester,operation:string,input:unknown):Promise<any>|null{
 if(requester.type!=='chat'||!memoryConnection(requester.userId)||memoryConnection(requester.userId)?.mode!=='remote')return null;
 authorizeZhiyuOwnerContext(createOwnerContext(requester.userId));
 return callRemoteMemory(requester.userId,operation,input);
}
export async function memoryConnectionStatus(ownerId:string){
 const config=memoryConnection(ownerId);
 if(!config||config.mode==='local')return{mode:'local',status:'ready',provider:'postgres',detail:'local_project_adapter',automaticFallback:false};
 try{
  const remote=await callRemoteMemory(ownerId,'status',{});
  return{mode:'remote',status:'ready',provider:'memory-service',detail:'zhiyu_project_adapter',remote,automaticFallback:false,localFallbackAvailable:true};
 }catch(error){return{mode:'remote',status:'unavailable',provider:'memory-service',detail:'remote_request_blocked',code:error instanceof MemoryModuleError?error.code:'memory_remote_unavailable',automaticFallback:false,localFallbackAvailable:true};}
}
