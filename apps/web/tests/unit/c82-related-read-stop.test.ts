import {describe,it,expect,vi} from 'vitest';
import {Type} from '@earendil-works/pi-ai';
import {readPlatformRelatedChatTitle,platformPublishedRecordHash} from '@/lib/ai/platform-field-reader';
import {PlatformReadHandleRegistry} from '@/lib/ai/platform-read-handle-registry';
import {createMemoryReadBudget} from '@/lib/ai/memory-read-budget';
const id='71000000-0000-4000-8000-000000000001',chatId='71000000-0000-4000-8000-000000000002',owner='71000000-0000-4000-8000-000000000003';
function setup(){
 const identity={ownerId:owner,requester:{kind:'chat' as const,id:'synthetic'},turnId:'synthetic-stop'},registry=new PlatformReadHandleRegistry(identity),budget=createMemoryReadBudget();
 const parent={source:'message',id,fields:{id,chatId,role:'assistant',parts:[{type:'text',text:'Historical observation, no new instruction.'}]}};
 const child={source:'chat',id:chatId,fields:{id:chatId,title:'Synthetic linked title'}};
 const read=vi.fn(async(s:{source:string;id:string})=>s.source==='chat'?child:parent);
 const input={userId:owner,parent,parentContentHash:platformPublishedRecordHash(parent),context:{originalQuestion:`消息记录 ${id} 的角色和所属聊天标题是什么？`,registry,identity,budget}};
 return {input,registry,budget,read};
}
describe('controlled related reads distinguish suppression from exhaustion and query failure',()=>{
 it('suppresses an already consumed child without reporting budget exhaustion or issuing another query',async()=>{
  const s=setup(),first=await readPlatformRelatedChatTitle(s.input,s.read),before=s.budget.snapshot(),again=await readPlatformRelatedChatTitle(s.input,s.read);
  expect(first?.status).toBe('read');expect(again).toMatchObject({status:'not_repeated',reads:[{stage:'chat_title',status:'not_repeated',attemptCharged:false,queryAttempted:false}],fieldRead:{status:'query_error',fieldAvailability:{title:'related_read_not_repeated'}}});
  expect(s.read).toHaveBeenCalledTimes(2);expect(s.budget.snapshot().attempts).toBe(before.attempts);expect(s.budget.snapshot().committedCharacters).toBe(before.committedCharacters);expect(again?.fieldRead?.fields).toEqual([]);
 });
 it('retains actual exhausted budget as a separate unread gap with zero query',async()=>{
  const s=setup(),definition=s.budget.wrap([{name:'platformRecall',description:'Synthetic',parameters:Type.Object({}),execute:()=>'',formatResult:r=>String(r)}])[0];
  for(let n=0;n<10;n++)await definition.execute({n},{toolCallId:'drain-'+n});
  const result=await readPlatformRelatedChatTitle(s.input,s.read);expect(result).toMatchObject({status:'budget_unavailable',reads:[{attemptCharged:false,queryAttempted:false}]});expect(s.read).not.toHaveBeenCalled();
 });
 it('keeps a real source exception as query_error with its attempted query accounted',async()=>{
  const s=setup(),read=vi.fn(async()=>{throw Error('synthetic source exception')});
  const result=await readPlatformRelatedChatTitle(s.input,read);expect(result).toMatchObject({status:'query_error',reads:[{status:'query_error',attemptCharged:true,queryAttempted:true}]});expect(read).toHaveBeenCalledTimes(1);
 });
});
