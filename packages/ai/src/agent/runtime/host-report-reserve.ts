import type {Context} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import {estimateContextTokens} from '@earendil-works/pi-ai/utils/estimate';
import {clampMaxTokensToContext} from '@earendil-works/pi-ai/api/simple-options';
import type {AgentOptions} from '../types';

/** Stop collecting before the next large read consumes the report window.
 * Raw observations stay intact; this never compacts or invents a LOG. */
export function createHostReportReserve(options:AgentOptions['hostReportReserve'],signal:AbortSignal){
 let active=false,forwards=0,closingSearches=0;
 let admitted=new Set<string>();
 return {
  beforeTool(name:string,params?:unknown){
   if(!options||!active)return;
   if(!admitted.has(name))throw Error('Research observation budget closed; only admitted closing tools remain before the final report.');
   if(name==='webSearch'){
    const p=params as {query?:unknown;limit?:unknown}|null;
    if(closingSearches>=1||!p||p.limit!==1||typeof p.query!=='string'||p.query.length>512||!/(?:^|\s)site:[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\s|$)/i.test(p.query))throw Error('Closing search requires limit=1 and a site:domain query; only one search remains.');
    closingSearches++;
   }
  },
  wrapStream(stream:StreamFn):StreamFn{return async(model,context,settings)=>{
   if(!options)return stream(model,context,settings);
   signal.throwIfAborted();
   if(!Number.isSafeInteger(options.outputTokens)||!Number.isSafeInteger(options.observationHeadroomTokens)||options.outputTokens<4096||options.outputTokens>16384||options.observationHeadroomTokens<16384||options.observationHeadroomTokens>65536)throw Error('Invalid report reserve');
   const estimate=estimateContextTokens(context).tokens;
   if(!active&&estimate<model.contextWindow-options.outputTokens-options.observationHeadroomTokens)return stream(model,context,settings);
   active=true;forwards++;
   const tools=forwards<=2?(context.tools??[]).filter(t=>['workingMemory','workshopLogEvent'].includes(t.name)
    ||options.allowClosingSearch&&closingSearches===0&&t.name==='webSearch'):[];
   admitted=new Set(tools.map(t=>t.name));
   const prepared:Context={...context,tools,systemPrompt:(context.systemPrompt??'')+'\nHost delivery budget: observation headroom is reserved for delivery. Finish from the observations already read; preserve useful task progress through the remaining admitted notebook tools if needed, then return one complete report JSON. If webSearch remains advertised, only one closing search with limit=1 and a site:domain query is admitted. No further page reading is admitted. Do not repeat the full article outside reportMarkdown, invent missing evidence or claim an unaccepted save.'};
   const cap=clampMaxTokensToContext(model,prepared,options.outputTokens);
   const effectiveCap=Math.min(cap,settings?.maxTokens??cap);
   if(effectiveCap<4096)throw Error('Report context reserve exhausted; partial output is not a completed report');
   await options.onReserve?.({forward:forwards,inputTokens:estimate,outputTokens:cap,remainingTools:tools.map(t=>t.name)});
   signal.throwIfAborted();
   return stream(model,prepared,{...settings,maxTokens:effectiveCap,...(!tools.length?{toolChoice:'none' as const}:{})});
  };},
 };
}
