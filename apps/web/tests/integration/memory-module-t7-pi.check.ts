import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServer} from 'node:http';
import {createPiAgentRuntime,createPiRuntimeOptionsFromModelConfig} from '@openzhiyu/ai/agent/runtime';
import {createPiProviderFetch} from '../../../../packages/ai/src/agent/runtime/pi-provider-fetch';
import {startModelProviderFixture} from '../../scripts/model-provider-fixture.mjs';

export async function checkMemoryModuleT7PiDispatch(){
  const scope=new AsyncLocalStorage<string>();let admitted=true,checks=0,requests=0;
  const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'text/plain'});response.end('fixture');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const controller=new AbortController(),guarded=createPiProviderFetch({fetch,signal:controller.signal,beforeRequest:()=>{assert.equal(scope.getStore(),'owner');checks++;if(!admitted)throw Error('fixture_revoked');},onRejected:error=>controller.abort(error)});
  try{
    await scope.run('owner',async()=>{await guarded(`http://127.0.0.1:${address.port}`);admitted=false;await assert.rejects(guarded(`http://127.0.0.1:${address.port}`));await assert.rejects(guarded(`http://127.0.0.1:${address.port}`));});
    assert.equal(requests,1);assert.equal(checks,2);assert.equal(controller.signal.aborted,true);
    return {provider:'pi',physicalRequests:requests,denialPreventsRetry:true,ownerScopePreserved:true};
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

export async function checkMemoryModuleT7PiProtocols(){
  const fixture=await startModelProviderFixture();
  try{
    const protocols=['openai-completions','openai-responses','anthropic-messages'] as const;
    for(const protocol of protocols){
      const config={apiKey:'loopback-fixture',baseUrl:protocol==='anthropic-messages'?fixture.baseUrl.replace(/\/v1$/,''):fixture.baseUrl,model:'text',protocol};
      const runtime=createPiAgentRuntime(createPiRuntimeOptionsFromModelConfig(config));let completed=false,text='';
      for await(const message of runtime.run({operation:'run',prompt:'fixture',options:{onBeforeProviderRequest:async()=>{}}})){if(message.type==='result')text=message.content??'';if(message.type==='runtime_terminal')completed=message.runtimeTerminal?.status==='completed';}
      assert.equal(text,'fixture-ok');assert.equal(completed,true);
      const before=fixture.observed.length;
      for await(const _message of runtime.run({operation:'run',prompt:'denied',options:{onBeforeProviderRequest:async()=>{throw Error('source_revoked');}}})){}
      assert.equal(fixture.observed.length,before);
    }
    return {protocols:[...protocols],realProviderCalled:false,sourceDenialBeforeTransport:true};
  }finally{await fixture.close();}
}
