export type RuntimeMode='embedded'|'worker'|'disabled';
export function runtimeMode(env:Record<string,string|undefined>=process.env):RuntimeMode{
  if(env.ENABLE_LOCAL_SCHEDULER==='false')return 'disabled';
  const mode=env.ZHIYU_RUNTIME_MODE??'embedded';
  return mode==='embedded'||mode==='worker'?mode:'disabled';
}
export function workerConfiguration(env:Record<string,string|undefined>=process.env){
  const mode=runtimeMode(env);
  if(mode!=='worker')return {enabled:false as const,mode};
  const ownerId=env.ZHIYU_RUNTIME_OWNER_ID?.trim();
  if(!ownerId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId))throw Error('runtime_owner_required');
  return {enabled:true as const,mode,ownerId:ownerId.toLowerCase(),leaseMs:15000,heartbeatMs:1000,stopGraceMs:10000};
}
