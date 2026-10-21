import {describe,it,expect,vi} from 'vitest';
import {createFauxCore} from '@earendil-works/pi-ai/providers/faux';
import type {Context} from '@earendil-works/pi-ai';
import {createHostReportReserve} from '@openzhiyu/ai/agent/runtime/host-report-reserve';

describe('research report context reserve',()=>{
 const context=(size:number):Context=>({systemPrompt:'Current owner denials remain authoritative.',messages:[{role:'user',content:'evidence '.repeat(size),timestamp:1}],
  tools:[{name:'Read',description:'observe',parameters:{type:'object',properties:{}}},{name:'workingMemory',description:'notes',parameters:{type:'object',properties:{}}}]});
 it('closes observation before starvation, keeps originals, allows two notebook forwards, then requires a report',async()=>{
  const faux=createFauxCore({}),stream=vi.fn(async(...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));
  const onReserve=vi.fn(),gate=createHostReportReserve({outputTokens:4096,observationHeadroomTokens:16384,onReserve},new AbortController().signal);
  const input=context(10000),before=structuredClone(input),model={...faux.getModel(),contextWindow:40000,maxTokens:4096};
  for(let i=0;i<3;i++)await gate.wrapStream(stream)(model,input,{maxTokens:4096});
  expect(onReserve).toHaveBeenCalledTimes(3);expect(stream.mock.calls[0][1].tools?.map(t=>t.name)).toEqual(['workingMemory']);
  expect(stream.mock.calls[2][1].tools).toEqual([]);expect(stream.mock.calls[2][2]?.toolChoice).toBe('none');expect(input).toEqual(before);
  expect(()=>gate.beforeTool('Read')).toThrow('budget closed');expect(()=>gate.beforeTool('workingMemory')).toThrow();
  expect(stream.mock.calls[0][1].systemPrompt).toContain(before.systemPrompt!);
 });
 it('admits one advertised bounded closing search and preserves the final answer fence',async()=>{
  const faux=createFauxCore({}),stream=vi.fn(async(...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));
  const gate=createHostReportReserve({outputTokens:4096,observationHeadroomTokens:16384,allowClosingSearch:true},new AbortController().signal);
  const input=context(10000);input.tools!.push({name:'webSearch',description:'search',parameters:{type:'object',properties:{}}});
  const model={...faux.getModel(),contextWindow:40000,maxTokens:4096};
  await gate.wrapStream(stream)(model,input,{maxTokens:4096});
  expect(stream.mock.calls[0][1].tools?.some(t=>t.name==='webSearch')).toBe(true);
  expect(()=>gate.beforeTool('Read',{})).toThrow('budget closed');
  expect(()=>gate.beforeTool('webSearch',{query:'site:example.org evidence',limit:5})).toThrow('limit=1');
  expect(()=>gate.beforeTool('webSearch',{query:'unscoped evidence',limit:1})).toThrow();
  expect(()=>gate.beforeTool('webSearch',{query:'site:example.org evidence',limit:1})).not.toThrow();
  expect(()=>gate.beforeTool('webSearch',{query:'site:example.org evidence',limit:1})).toThrow();
  await gate.wrapStream(stream)(model,input,{maxTokens:4096});
  expect(stream.mock.calls[1][1].tools?.some(t=>t.name==='webSearch')).toBe(false);
  await gate.wrapStream(stream)(model,input,{maxTokens:4096});
  expect(stream.mock.calls[2][2]?.toolChoice).toBe('none');
 });
 it('never dispatches a one-token report and never retries an oversized context',async()=>{
  const faux=createFauxCore({}),stream=vi.fn(async(...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));
  const gate=createHostReportReserve({outputTokens:4096,observationHeadroomTokens:16384},new AbortController().signal);
  await expect(gate.wrapStream(stream)({...faux.getModel(),contextWindow:30000},context(50000),{maxTokens:1})).rejects.toThrow('reserve exhausted');
  expect(stream).not.toHaveBeenCalled();
 });
 it('fails closed when the durable reserve receipt fails',async()=>{
  const faux=createFauxCore({}),stream=vi.fn(async(...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));
  const gate=createHostReportReserve({outputTokens:4096,observationHeadroomTokens:16384,onReserve:async()=>{throw Error('audit unavailable');}},new AbortController().signal);
  await expect(gate.wrapStream(stream)({...faux.getModel(),contextWindow:40000},context(10000))).rejects.toThrow('audit unavailable');expect(stream).not.toHaveBeenCalled();
 });
});
