import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/lib/env/constants',()=>({isTauriMode:()=>true}));
afterEach(()=>vi.unstubAllEnvs());
it('explicit disable takes precedence over development and desktop defaults',async()=>{
  vi.stubEnv('NODE_ENV','development');
  vi.stubEnv('ENABLE_LOCAL_SCHEDULER','false');
  const {isLocalSchedulerAllowedLight}=await import('@/lib/cron/scheduler-state');
  expect(isLocalSchedulerAllowedLight()).toBe(false);
  vi.stubEnv('ENABLE_LOCAL_SCHEDULER','true');
  expect(isLocalSchedulerAllowedLight()).toBe(true);
});
