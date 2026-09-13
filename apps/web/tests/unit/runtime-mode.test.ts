import {expect,it,vi,afterEach} from 'vitest';
import {runtimeMode,workerConfiguration} from '@/lib/runtime/mode';
import {isLocalSchedulerAllowedLight} from '@/lib/cron/scheduler-state';
afterEach(()=>vi.unstubAllEnvs());
it('explicit disabled wins across development and production, including forced enable contexts',()=>{
  for(const NODE_ENV of ['development','production']){
    expect(runtimeMode({NODE_ENV,ZHIYU_RUNTIME_MODE:'worker',ENABLE_LOCAL_SCHEDULER:'false'})).toBe('disabled');
    expect(runtimeMode({NODE_ENV,ZHIYU_RUNTIME_MODE:'disabled',ENABLE_LOCAL_SCHEDULER:'true'})).toBe('disabled');
    expect(workerConfiguration({NODE_ENV,ZHIYU_RUNTIME_MODE:'disabled'}).enabled).toBe(false);
  }
});
it('worker mode prevents the embedded page scheduler even with the enable flag set',()=>{
  vi.stubEnv('ZHIYU_RUNTIME_MODE','worker');vi.stubEnv('ENABLE_LOCAL_SCHEDULER','true');
  expect(isLocalSchedulerAllowedLight()).toBe(false);
  vi.stubEnv('ZHIYU_RUNTIME_MODE','embedded');expect(isLocalSchedulerAllowedLight()).toBe(true);
});
it('worker requires an explicit owner and invalid modes fail closed',()=>{
  expect(runtimeMode({})).toBe('embedded');
  expect(runtimeMode({ZHIYU_RUNTIME_MODE:'typo'})).toBe('disabled');
  expect(()=>workerConfiguration({ZHIYU_RUNTIME_MODE:'worker'})).toThrow('runtime_owner_required');
  expect(workerConfiguration({ZHIYU_RUNTIME_MODE:'worker',ZHIYU_RUNTIME_OWNER_ID:'AAAAAAAA-0000-4000-8000-000000000001'}))
    .toMatchObject({enabled:true,ownerId:'aaaaaaaa-0000-4000-8000-000000000001'});
});
