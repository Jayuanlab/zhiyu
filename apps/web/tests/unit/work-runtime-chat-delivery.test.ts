import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {DrizzleDB} from '@/lib/db/types';
import {buildChatRunDeliveryMessage,chatDeliveryPreview,chatRunDeliveryIds,consumeOwnedChatDeliveries} from '@/lib/work-runtime/chat-delivery';
import {chatDeliveryDependencies,deliverNextChatResultInTransaction,enqueueChatRunDeliveryInTransaction,verifiedLegacyChatOrigin} from '@/lib/work-runtime/chat-delivery-store';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

const mocks=vi.hoisted(()=>({transaction:vi.fn()}));
vi.mock('@/lib/db/client',()=>({db:{transaction:mocks.transaction}}));
const owner='11111111-1111-4111-8111-111111111111',work='22222222-2222-4222-8222-222222222222';
const runId='33333333-3333-4333-8333-333333333333',chat='44444444-4444-4444-8444-444444444444';
const source='55555555-5555-4555-8555-555555555555';
const ids=chatRunDeliveryIds(owner,work,runId,'completed');
const trigger={source:'web_chat',origin:'chat_command',chatId:chat,userMessageId:source,commandMeta:{commandId:'owner-command'}};
const run={id:runId,workshop_id:work,status:'completed',trigger_reason:trigger};
function command(){return {command_id:'owner-command',target_id:work,type:'startWorkRun',status:'succeeded',
  payload:{value:{source:'chat_agent',triggerReason:trigger}},result:{value:{run:{id:runId}}}};}
const dialect=new PgDialect();
type StoredMessage={chatId:string;role:string;parts:unknown;metadata:unknown};
function deliveryStore(options:{missing?:'chat'|'source'|'work';runStatus?:string;deliveryStatus?:'completed'|'failed';runtimeFailure?:unknown;failureEvents?:Record<string,unknown>[];needsInput?:boolean;insertFailures?:number;settlementFailures?:number;existing?:StoredMessage}={}){
  const jobIds=chatRunDeliveryIds(owner,work,runId,options.deliveryStatus??'completed');
  const row={id:jobIds.deliveryId,owner_id:owner,chat_id:chat,workshop_id:work,run_id:runId,source_message_id:source,
    message_id:jobIds.messageId,run_status:options.deliveryStatus??'completed',attempts:0,status:'pending'};
  const statements:{sql:string;params:unknown[]}[]=[];
  const messages=new Map<string,StoredMessage>();if(options.existing)messages.set(jobIds.messageId,options.existing);
  let snapshot=new Map(messages),insertFailures=options.insertFailures??0,settlementFailures=options.settlementFailures??0;
  const execute=vi.fn(async(value:Parameters<PgDialect['sqlToQuery']>[0])=>{
    const query=dialect.sqlToQuery(value),text=query.sql.replace(/\s+/g,' ').trim();statements.push(query);
    if(text.startsWith('SELECT * FROM workshop_chat_deliveries'))return ['pending','failed'].includes(row.status)?[{...row}]:[];
    if(text.startsWith('SELECT id FROM "Chat"'))return options.missing==='chat'?[]:[{id:chat}];
    if(text.startsWith('SELECT id FROM "Message_v2"'))return options.missing==='source'?[]:[{id:source}];
    if(text.startsWith('SELECT r.status,r.output_summary,w.name'))return options.missing==='work'?[]:[{status:options.runStatus??options.deliveryStatus??'completed',name:'研究车间',needs_input:options.needsInput??false,
      output_summary:'得到两份草稿',clarification:'请提供时间范围与要比较的对象。',error:'Final validation correction limit exhausted',
      started_at:'2026-10-08T21:16:03Z',completion_json:{request:{metadata:{runtimeFailure:options.runtimeFailure}}}}];
    if(text.startsWith('SELECT id,run_id AS "runId",seq,type,created_at AS "createdAt",metadata FROM workshop_events'))return options.failureEvents??[];
    if(text==='SAVEPOINT chat_delivery_message'){snapshot=new Map(messages);return [];}
    if(text==='ROLLBACK TO SAVEPOINT chat_delivery_message'){messages.clear();for(const [id,message] of snapshot)messages.set(id,message);return [];}
    if(text==='RELEASE SAVEPOINT chat_delivery_message')return [];
    if(text.startsWith('INSERT INTO "Message_v2"')){
      if(insertFailures-->0)throw Error('private database credentials');
      const [id,chatId,parts,metadata]=query.params as string[];
      if(messages.has(id))return [];
      messages.set(id,{chatId,role:'assistant',parts:JSON.parse(parts),metadata:JSON.parse(metadata)});return [{id}];
    }
    if(text.startsWith('SELECT "chatId",role,metadata,parts'))return messages.has(jobIds.messageId)?[messages.get(jobIds.messageId)]:[];
    if(text.startsWith('UPDATE workshop_chat_deliveries')){
      if(text.includes("status='delivered'")&&settlementFailures-->0)throw Error('settlement unavailable');
      row.status=text.includes("status='blocked'")?'blocked':text.includes("status='failed'")?'failed':'delivered';row.attempts++;return [];
    }
    throw Error(`Unexpected delivery query: ${text}`);
  });
  return {tx:{execute} as unknown as DrizzleDB,row,messages,statements,execute,ids:jobIds};
}
beforeEach(()=>vi.resetAllMocks());

describe('ordinary assistant completion notifications',()=>{
  it('previews only a fixed known host process failure without old reading gaps or raw error text',()=>{
    const runtimeFailure={version:'workshop-runtime-failure/v1',receiptAuthority:'runtime',runId,
      code:'agent_runtime_failed',runtimeEventId:source,runtimeError:'Final validation correction forward limit exhausted',
      message:'private raw prompt',issues:['obsolete: DeepSeek-GRM still unread']};
    const base={...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,status:'failed' as const,needsInput:false};
    const text=buildChatRunDeliveryMessage({...base,runtimeFailure}).parts[0].text;
    expect(text).toContain('模型往返');expect(text).toContain('尚未形成通过核验的报告');
    expect(text).not.toMatch(/private raw prompt|still unread|forward limit exhausted/);
    for(const changed of [{...runtimeFailure,runId:work},{...runtimeFailure,receiptAuthority:'agent'},
      {...runtimeFailure,runtimeEventId:null},{...runtimeFailure,runtimeError:'Final validation correction forward limit exhausted password=private'},
      {...runtimeFailure,runtimeError:'arbitrary private provider prompt'}]){
      const unsupported=buildChatRunDeliveryMessage({...base,runtimeFailure:changed}).parts[0].text;
      expect(unsupported).not.toMatch(/模型往返|private|provider|still unread/);
    }
  });
  it('returns only bounded, redacted same-run host research issues as ordinary failure text',()=>{
    const runtimeFailure={version:'workshop-runtime-failure/v1',receiptAuthority:'runtime',runId,
      code:'research_final_validation_rejected',validationEventId:source,attempt:2,
      runtimeError:'private raw provider prompt',message:'private raw provider prompt',
      issues:['DeepSeekMath 短摘未完整出现在同版正文窗口中。','DeepSeek-R1 数字 79.8% 未在短摘中出现。password=secret-password']};
    const content=buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,
      status:'failed',needsInput:false,runtimeFailure});
    const text=content.parts[0].text;
    expect(text).toContain('研究报告未通过核验');expect(text).toContain('DeepSeekMath');expect(text).toContain('79.8%');
    expect(text).not.toMatch(/private raw provider prompt|secret-password|得到两份草稿/);
    expect(content.parts).toHaveLength(1);expect(content.parts[0].type).toBe('text');expect(content.attachments).toEqual([]);
    expect(content.metadata.workshopChatDelivery.status).toBe('failed');
    for(const changed of [{...runtimeFailure,runId:work},{...runtimeFailure,receiptAuthority:'agent'},
      {...runtimeFailure,code:'agent_runtime_failed'},{...runtimeFailure,version:'future-unverified'},
      {...runtimeFailure,issues:[{message:'forged'}]},{...runtimeFailure,validationEventId:'unknown'},
      {...runtimeFailure,issues:Array(21).fill('over limit')},{...runtimeFailure,attempt:3},
      {...runtimeFailure,issues:['DeepSeekMath '+ 'x'.repeat(1300)]}]){
      expect(buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,
        status:'failed',needsInput:false,runtimeFailure:changed}).parts[0].text).not.toContain('DeepSeekMath');
    }
    const long=buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,
      status:'failed',needsInput:false,runtimeFailure:{...runtimeFailure,issues:Array(20).fill('*'.repeat(1000))}});
    expect(long.parts[0].text.length).toBeLessThan(2500);
    const hostTruncatedIssue='DeepSeekMath '+ 'x'.repeat(988)+'（原因过长，已截断；详见原始校验记录）';
    const truncated=buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,
      status:'failed',needsInput:false,runtimeFailure:{...runtimeFailure,issues:[hostTruncatedIssue]}});
    expect(truncated.parts[0].text).toContain('DeepSeekMath');expect(truncated.parts[0].text.length).toBeLessThan(2500);
    const completed=buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究车间',sourceMessageId:source,
      status:'completed',needsInput:false,runtimeFailure});
    expect(completed.parts[0].text).not.toContain('DeepSeekMath');
  });
  it('uses stable identities per run state and valid workshop/result links',()=>{
    expect(chatRunDeliveryIds(owner.toUpperCase(),work.toUpperCase(),runId.toUpperCase(),'completed')).toEqual(ids);
    expect(chatRunDeliveryIds(owner,work,runId,'needs_review').messageId).not.toBe(ids.messageId);
    const content=buildChatRunDeliveryMessage({...ids,workshopId:work,runId,workshopName:'研究\n[车间]',sourceMessageId:source,status:'completed',needsInput:false});
    expect(content.parts).toHaveLength(1);expect(content.parts[0].type).toBe('text');
    expect(content.parts[0].text).toContain(`/workshop?workId=${work}&tab=run&runId=${runId}`);
    expect(content.parts[0].text).not.toContain('已验收');expect(content.attachments).toEqual([]);
    expect(content.metadata.workshopChatDelivery.sourceMessageId).toBe(source);
  });
  it('reports clarification as unfinished and never claims cancellation rolled back effects',()=>{
    const input={...ids,workshopId:work,runId,workshopName:'车间',sourceMessageId:source,status:'completed' as const,needsInput:true};
    expect(buildChatRunDeliveryMessage(input).parts[0].text).toContain('需要你补充信息，本事项尚未完成');
    expect(buildChatRunDeliveryMessage({...input,needsInput:false,status:'cancelled'}).parts[0].text).toContain('取消不代表已发生的效果被撤销');
    expect(buildChatRunDeliveryMessage({...input,status:'cancelled'}).parts[0].text).not.toContain('需要你补充信息');
  });
  it('includes actionable clarification and a bounded literal result preview with observation provenance',()=>{
    const input={...ids,workshopId:work,runId,workshopName:'`[车间](https://evil.test)\\',sourceMessageId:source,status:'completed' as const,needsInput:true,
      clarification:'请提供时间范围。password=private-password [另一个入口](https://evil.test)'};
    const message=buildChatRunDeliveryMessage(input);
    expect(message.parts[0].text).toContain('请提供时间范围');expect(message.parts[0].text).not.toContain('private-password');
    expect(message.parts[0].text).toContain('\\`\\[车间\\]\\(https://evil.test\\)\\\\');
    expect(message.metadata.source).toBe('workshop_result');
    const result=buildChatRunDeliveryMessage({...input,needsInput:false,summary:'已完成分析。'.repeat(1000)});
    expect(result.parts[0].text).toContain('结果摘要');expect(result.parts[0].text.length).toBeLessThan(1300);
    expect(()=>buildChatRunDeliveryMessage({...input,workshopId:'x)[bad](https://evil.test)'})).toThrow('invalid_chat_delivery');
    expect(chatDeliveryPreview('Bearer secret-token\napi_key="other-secret"\n-----BEGIN PRIVATE KEY-----\nprivate-material',600)).not.toMatch(/secret-token|other-secret|private-material/);
  });
  it('bounds one owner scan and stops before touching storage when aborted',async()=>{
    const dependencies={seed:vi.fn().mockResolvedValue(2),next:vi.fn().mockResolvedValueOnce({state:'delivered',deliveryId:ids.deliveryId}).mockResolvedValueOnce({state:'failed',deliveryId:'other'}).mockResolvedValue(null)};
    expect(await consumeOwnedChatDeliveries({userId:owner,limit:2},dependencies)).toEqual({seeded:2,delivered:1,replayed:0,blocked:0,failed:1});
    expect(dependencies.next).toHaveBeenCalledTimes(2);
    dependencies.seed.mockClear();dependencies.next.mockClear();
    await consumeOwnedChatDeliveries({userId:owner,signal:AbortSignal.abort()},dependencies);
    expect(dependencies.seed).not.toHaveBeenCalled();expect(dependencies.next).not.toHaveBeenCalled();
  });
  it('does not permit a Work producer to consume notifications even through injected storage',async()=>{
    const dependencies={seed:vi.fn(),next:vi.fn()};
    await expect(withExecutionContext({userId:owner,workshopId:work,runId,workerId:'worker',token:1},()=>consumeOwnedChatDeliveries({userId:owner},dependencies))).rejects.toThrow('producer');
    expect(dependencies.seed).not.toHaveBeenCalled();
  });
});

describe('durable owner origin proof',()=>{
  it('uses the winning command receipt, not model-provided chat/run bindings',()=>{
    expect(verifiedLegacyChatOrigin(run,command())).toEqual({chatId:chat,sourceMessageId:source});
    for(const altered of [{...command(),status:'queued'},{...command(),target_id:chat},{...command(),type:'updateWork'},
      {...command(),result:{value:{run:{id:work}}}},{...command(),payload:{value:{source:'workshop',triggerReason:trigger}}}])
      expect(verifiedLegacyChatOrigin(run,altered)).toBeNull();
    expect(verifiedLegacyChatOrigin({...run,trigger_reason:{...trigger,chatId:work}},command())).toBeNull();
    expect(verifiedLegacyChatOrigin({...run,trigger_reason:{...trigger,userMessageId:null}},command())).toBeNull();
  });
  it('allows a source-less owner button only when its exact durable origin matches',()=>{
    const button={...trigger,origin:'owner_button',userMessageId:null};
    const receipt={...command(),payload:{value:{source:'chat_agent',triggerReason:button}}};
    expect(verifiedLegacyChatOrigin({...run,trigger_reason:button},receipt)).toEqual({chatId:chat,sourceMessageId:null});
    expect(verifiedLegacyChatOrigin({...run,trigger_reason:{...button,origin:'chat_command'}},receipt)).toBeNull();
  });
  it('enqueues a persisted work item origin once without changing focus or executing business',async()=>{
    const statements:{sql:string;params:unknown[]}[]=[];let queued=false;
    const tx={execute:vi.fn(async(value:Parameters<PgDialect['sqlToQuery']>[0])=>{
      const query=dialect.sqlToQuery(value);statements.push(query);
      if(query.sql.includes('SELECT r.id,r.workshop_id'))return [run];
      if(query.sql.includes('SELECT chat_id,source_message_id'))return [{chat_id:chat,source_message_id:source}];
      if(query.sql.includes('INSERT INTO workshop_chat_deliveries')){if(queued)return [];queued=true;return [{id:ids.deliveryId}];}
      throw Error('unexpected enqueue query');
    })} as unknown as DrizzleDB;
    const input={userId:owner,workshopId:work,runId,status:'completed'};
    expect(await enqueueChatRunDeliveryInTransaction(tx,input)).toBe(true);
    expect(await enqueueChatRunDeliveryInTransaction(tx,input)).toBe(false);
    const insert=statements.find(value=>value.sql.includes('INSERT INTO'))!;
    expect(insert.params).toEqual([ids.deliveryId,owner,chat,work,runId,source,ids.messageId,'completed']);
    expect(insert.sql).toContain('ON CONFLICT (run_id,run_status) DO NOTHING');
    expect(statements.some(value=>/UPDATE|startWork|workshop_chat_contexts/.test(value.sql))).toBe(false);
  });
  it('filters unsupported legacy origins before LIMIT so they cannot starve current deliveries',async()=>{
    const execute=vi.fn(async(_value:Parameters<PgDialect['sqlToQuery']>[0])=>[]);mocks.transaction.mockImplementation(async callback=>callback({execute}));
    await chatDeliveryDependencies.seed(owner,20);
    const query=dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("c.status='succeeded'");expect(query.sql).toContain("c.result->'value'->'run'->>'id'=r.id::text");
    expect(query.sql).toContain('c.target_id=w.id');expect(query.params.at(-1)).toBe(20);
  });
});

describe('delivery transaction and recovery',()=>{
  it('rebinds a known process limit to its own terminal receipt without importing old validation issues',async()=>{
    const execution={runId,token:7,workerId:'real-worker'};
    const runtimeFailure={version:'workshop-runtime-failure/v1',receiptAuthority:'runtime',runId,
      code:'agent_runtime_failed',runtimeEventId:source,runtimeError:'Final validation correction forward limit exhausted',
      message:'private raw prompt',issues:['old incomplete reading result']};
    const failureEvents=[
      {id:owner,runId,seq:1,type:'research_final_validation_rejected',createdAt:'2026-10-08T21:24:41Z',
        metadata:{receiptAuthority:'runtime',execution,attempt:0,maxCorrections:2,status:'correction_required',issues:['old incomplete reading result']}},
      {id:source,runId,seq:2,type:'agent_final_output_rejected',createdAt:'2026-10-08T21:24:42Z',
        metadata:{receiptAuthority:'runtime',execution,terminalStatus:'failed',error:'Final validation correction forward limit exhausted'}},
    ];
    const store=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.state).toBe('delivered');
    const text=JSON.stringify(store.messages.get(store.ids.messageId)?.parts);
    expect(text).toContain('模型往返');expect(text).toContain('尚未形成通过核验的报告');
    expect(text).not.toMatch(/private raw prompt|old incomplete|forward limit exhausted/);
    const agentReceipt=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents:failureEvents.map(event=>
      ({...event,metadata:{...event.metadata,receiptAuthority:'agent'}}))});
    await deliverNextChatResultInTransaction(agentReceipt.tx,owner);
    expect(JSON.stringify(agentReceipt.messages.get(agentReceipt.ids.messageId)?.parts)).not.toContain('模型往返');
  });
  it('rechecks persisted host receipts before returning a new failed research run to the original chat',async()=>{
    const execution={runId,token:7,workerId:'real-worker'};
    const runtimeFailure={version:'workshop-runtime-failure/v1',receiptAuthority:'runtime',runId,
      code:'research_final_validation_rejected',validationEventId:source,attempt:2,
      runtimeError:'Final validation correction limit exhausted',message:'stored description',
      issues:['do not trust saved mutable issue prose']};
    const failureEvents=[
      {id:source,runId,seq:1,type:'research_final_validation_rejected',createdAt:'2026-10-08T21:24:41Z',
        metadata:{receiptAuthority:'runtime',execution,attempt:2,maxCorrections:2,status:'correction_required',
          issues:['DeepSeekMath 的短摘没有完整出现在所引用窗口中。','DeepSeek-R1 数字 79.8% 未在短摘中出现。']}},
      {id:owner,runId,seq:2,type:'agent_final_output_rejected',createdAt:'2026-10-08T21:24:42Z',
        metadata:{receiptAuthority:'runtime',execution,terminalStatus:'failed',error:'Final validation correction limit exhausted'}},
    ];
    const store=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.state).toBe('delivered');
    const text=JSON.stringify(store.messages.get(store.ids.messageId)?.parts);
    expect(text).toContain('研究报告未通过核验');expect(text).toContain('DeepSeekMath');expect(text).toContain('79.8%');
    expect(text).not.toMatch(/saved mutable|得到两份草稿|correction limit exhausted/);
    const query=store.statements.find(query=>query.sql.startsWith('SELECT id,run_id'))!;
    expect(query.params).toContain(work);expect(query.params).toContain(runId);
    expect(store.statements.some(query=>/UPDATE workshop_runs|workshop_outbox|startWorkRun/.test(query.sql))).toBe(false);
    const untrusted=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents:failureEvents.map(event=>
      ({...event,metadata:{...event.metadata,receiptAuthority:'agent'}}))});
    await deliverNextChatResultInTransaction(untrusted.tx,owner);
    expect(JSON.stringify(untrusted.messages.get(untrusted.ids.messageId)?.parts)).not.toContain('DeepSeekMath');
    const foreignExecution=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents:failureEvents.map((event,index)=>
      index===0?({...event,metadata:{...event.metadata,execution:{...execution,token:6}}}):event)});
    await deliverNextChatResultInTransaction(foreignExecution.tx,owner);
    expect(JSON.stringify(foreignExecution.messages.get(foreignExecution.ids.messageId)?.parts)).not.toContain('DeepSeekMath');
    const overflow=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents:Array(21).fill(failureEvents[0])});
    await deliverNextChatResultInTransaction(overflow.tx,owner);
    expect(JSON.stringify(overflow.messages.get(overflow.ids.messageId)?.parts)).not.toContain('DeepSeekMath');
    expect(overflow.statements.find(query=>query.sql.startsWith('SELECT id,run_id'))?.sql).toContain('LIMIT 21');
    const failureIds=chatRunDeliveryIds(owner,work,runId,'failed');
    const existing={chatId:chat,role:'assistant',parts:[{type:'text',text:'existing immutable failed notification'}],
      metadata:{workshopChatDelivery:{deliveryId:failureIds.deliveryId}}};
    const replay=deliveryStore({deliveryStatus:'failed',runtimeFailure,failureEvents,existing});
    expect((await deliverNextChatResultInTransaction(replay.tx,owner))?.state).toBe('replayed');
    expect(replay.messages.get(replay.ids.messageId)).toEqual(existing);
    expect(replay.statements.some(query=>query.sql.startsWith('UPDATE "Message_v2"'))).toBe(false);
  });
  it('writes an immutable ordinary assistant message and settles it exactly once',async()=>{
    const store=deliveryStore();
    expect(await deliverNextChatResultInTransaction(store.tx,owner)).toEqual({state:'delivered',deliveryId:ids.deliveryId});
    expect(await deliverNextChatResultInTransaction(store.tx,owner)).toBeNull();expect(store.messages.size).toBe(1);
    const message=store.messages.get(ids.messageId)!;expect(message.role).toBe('assistant');expect(message.chatId).toBe(chat);
    expect(JSON.stringify(message.parts)).toContain('得到两份草稿');
    expect(store.statements[0].sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(store.statements[1].params).toEqual([chat,owner]);
    expect(store.statements.some(value=>/workshop_chat_contexts|UPDATE workshop_runs|workshop_outbox|startWorkRun/.test(value.sql))).toBe(false);
  });
  it('reads the persisted clarification event body into the original conversation',async()=>{
    const store=deliveryStore({needsInput:true});await deliverNextChatResultInTransaction(store.tx,owner);
    const text=JSON.stringify(store.messages.get(ids.messageId)?.parts);
    expect(text).toContain('请提供时间范围与要比较的对象');expect(text).not.toContain('得到两份草稿');
  });
  it.each(['chat','source','work'] as const)('blocks a removed or no longer owned %s without recreating it',async missing=>{
    const store=deliveryStore({missing});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.state).toBe('blocked');
    expect(store.row.status).toBe('blocked');expect(store.messages.size).toBe(0);
    expect(store.statements.some(value=>value.sql.includes('INSERT INTO "Chat"'))).toBe(false);
  });
  it('does not publish a stale terminal state after review advances the run',async()=>{
    const store=deliveryStore({runStatus:'needs_review'});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.errorCode).toBe('run_status_changed');
    expect(store.messages.size).toBe(0);
  });
  it('converges a previous committed notification to the same message without overwriting it',async()=>{
    const existing={chatId:chat,role:'assistant',parts:[{type:'text',text:'original immutable text'}],metadata:{workshopChatDelivery:{deliveryId:ids.deliveryId}}};
    const store=deliveryStore({existing});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.state).toBe('replayed');
    expect(store.messages.get(ids.messageId)).toEqual(existing);expect(store.messages.size).toBe(1);
  });
  it('blocks a conflicting pre-existing message identity instead of overwriting another chat',async()=>{
    const existing={chatId:work,role:'assistant',parts:[],metadata:{}};
    const store=deliveryStore({existing});
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.errorCode).toBe('message_identity_conflict');
    expect(store.messages.get(ids.messageId)).toEqual(existing);
  });
  it.each([{insertFailures:1},{settlementFailures:1}])('retries failed notification persistence without rerunning the business (%o)',async failure=>{
    const store=deliveryStore(failure);
    expect(await deliverNextChatResultInTransaction(store.tx,owner)).toEqual({state:'failed',deliveryId:ids.deliveryId,errorCode:'message_persistence_failed'});
    expect(store.messages.size).toBe(0);expect(store.row.status).toBe('failed');
    expect(store.statements.some(value=>value.sql.includes('next_attempt_at=clock_timestamp()+'))).toBe(true);
    expect((await deliverNextChatResultInTransaction(store.tx,owner))?.state).toBe('delivered');
    expect(store.messages.size).toBe(1);expect(store.row.attempts).toBe(2);
    expect(JSON.stringify(store.messages.get(ids.messageId))).not.toContain('private database credentials');
  });
});
