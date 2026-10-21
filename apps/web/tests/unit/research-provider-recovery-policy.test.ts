import {describe,it,expect} from 'vitest';
import {researchProviderRecoveryPolicy} from '@/lib/ai/research-provider-recovery-policy';
describe('research provider deadline selection',()=>{
 it('gives ordinary freeform reports a distinct bounded deadline without adding retries',()=>{
  expect(researchProviderRecoveryPolicy({freeformReport:true,protectedDelivery:false})).toEqual({version:'official-go-qwen-report.v1',sharedTimeoutMs:300000,maxRecoveries:1,maxBufferedBytes:4194304,maxFrames:20000});
 });
 it('keeps short protected delivery and other tasks on their original deadline',()=>{
  for(const input of [{freeformReport:false,protectedDelivery:false},{freeformReport:true,protectedDelivery:true}])
   expect(researchProviderRecoveryPolicy(input)).toMatchObject({version:'official-go-qwen-opaque.v1',sharedTimeoutMs:120000,maxRecoveries:1});
 });
});
