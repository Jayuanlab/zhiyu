import {AsyncLocalStorage} from 'node:async_hooks';
import {describe,it,expect,vi} from 'vitest';
import {createPiProviderFetch} from '../../../../packages/ai/src/agent/runtime/pi-provider-fetch';
describe('Pi physical provider dispatch fence',()=>{
 it('checks each physical request and prevents retry after revocation',async()=>{
  let allowed=true;const controller=new AbortController(),before=vi.fn(()=>{if(!allowed)throw Error('revoked');}),forward=vi.fn(async()=>new Response('fixture'));
  const fetch=createPiProviderFetch({fetch:forward,signal:controller.signal,beforeRequest:before,onRejected:error=>controller.abort(error)});
  await fetch('https://fixture.invalid');allowed=false;await expect(fetch('https://fixture.invalid')).rejects.toThrow('revoked');await expect(fetch('https://fixture.invalid')).rejects.toThrow();
  expect(forward).toHaveBeenCalledOnce();expect(before).toHaveBeenCalledTimes(2);expect(controller.signal.aborted).toBe(true);
 });
 it('keeps the authenticated host async scope across admission',async()=>{const scope=new AsyncLocalStorage<string>(),seen:string[]=[];const fetch=createPiProviderFetch({fetch:async()=>new Response('fixture'),signal:new AbortController().signal,beforeRequest:async()=>{await Promise.resolve();seen.push(scope.getStore()!);},onRejected:()=>{}});await scope.run('owner',()=>fetch('https://fixture.invalid'));expect(seen).toEqual(['owner']);});
 it('blocks dispatch when cancelled during admission',async()=>{const controller=new AbortController(),forward=vi.fn();const fetch=createPiProviderFetch({fetch:forward,signal:controller.signal,beforeRequest:async()=>{controller.abort();},onRejected:()=>{}});await expect(fetch('https://fixture.invalid')).rejects.toThrow();expect(forward).not.toHaveBeenCalled();});
 it('forces redirects to fail and combines SDK and host cancellation',async()=>{const host=new AbortController(),sdk=new AbortController(),forward=vi.fn<typeof fetch>(async()=>new Response('fixture'));const fetcher=createPiProviderFetch({fetch:forward,signal:host.signal,onRejected:()=>{}});await fetcher('https://fixture.invalid',{redirect:'follow',signal:sdk.signal});const init=forward.mock.calls[0][1] as RequestInit;expect(init.redirect).toBe('error');sdk.abort();expect(init.signal?.aborted).toBe(true);});
});
