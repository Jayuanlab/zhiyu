/** Repeat host admission for every physical HTTP dispatch, including a
 * provider SDK's internal requests. Logical stream admission alone is not a
 * sufficient boundary when sources or execution leases can be revoked. */
export function createPiProviderFetch(input:{fetch:typeof fetch;signal:AbortSignal;beforeRequest?:()=>Promise<void>|void;onRejected:(error:unknown)=>void}):typeof fetch{
  return async(request,init)=>{
    try{input.signal.throwIfAborted();await input.beforeRequest?.();input.signal.throwIfAborted();}
    catch(error){input.onRejected(error);throw error;}
    return input.fetch(request,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([input.signal,init.signal]):input.signal});
  };
}
