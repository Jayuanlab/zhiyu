import type {HostProviderRecoveryOptions} from '@openzhiyu/ai/agent/runtime';

/** A notebook grant must not impose the short exercise deadline on an ordinary
 * freeform report. Both profiles keep exact-body opaque recovery bounded to one;
 * incomplete streams and timeouts are still never automatically replayed. */
export function researchProviderRecoveryPolicy(input:{freeformReport:boolean;protectedDelivery:boolean}):HostProviderRecoveryOptions['policy']{
  const report=input.freeformReport&&!input.protectedDelivery;
  return {version:report?'official-go-qwen-report.v1':'official-go-qwen-opaque.v1',maxRecoveries:1,
    sharedTimeoutMs:report?300000:120000,maxBufferedBytes:4194304,maxFrames:20000};
}
