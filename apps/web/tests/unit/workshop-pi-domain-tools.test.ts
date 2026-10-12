import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import { resolveWorkshopPiAllowedTools, restrictWorkshopPiRequestedTools } from '@/lib/workshops/tool-access';
vi.mock('@/lib/workshops/mcp-tools', () => ({createWorkshopToolDefinitions: vi.fn(() => [])}));
vi.mock('@/lib/workshops/service', () => ({getWorkshop:vi.fn(),appendWorkshopEvent:vi.fn(),listWorkshopSources:vi.fn(),listWorkshopEvents:vi.fn(async()=>[])}));
vi.mock('@/lib/brain/memory-update-document', () => ({applyDocumentMemoryUpdate:vi.fn()}));
vi.mock('@/lib/ai/skills/loader', () => ({loadSkills:vi.fn(() => []),getSkillContent:vi.fn()}));
import { adaptWorkshopDefinition, createWorkshopPiTools } from '@/lib/workshops/pi-domain-tools';
import { createWorkshopToolDefinitions } from '@/lib/workshops/mcp-tools';
import { getWorkshop, appendWorkshopEvent, listWorkshopSources, listWorkshopEvents } from '@/lib/workshops/service';
import { applyDocumentMemoryUpdate } from '@/lib/brain/memory-update-document';
import { loadSkills, getSkillContent } from '@/lib/ai/skills/loader';
import { MAX_SKILL_REFERENCE_BYTES } from '@/lib/ai/skills/resource-reader';
import { createConversationFileSources } from '@/lib/workshops/conversation-input';
import { stagePiWorkshopFileSources } from '@/lib/workshops/pi-local-tools';

const mockedCreateWorkshopToolDefinitions = vi.mocked(createWorkshopToolDefinitions);

async function removeDocumentFixture(root: string) {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhiyu-pi-document-')) {
    throw Error('Unexpected document cleanup path');
  }
  await rm(target, { recursive: true, force: true });
}

describe('Pi domain bridge', () => {
  it('preserves screenshot image blocks instead of converting them into JSON text', async () => {
    const image = {type:'image' as const, data:'cG5n', mimeType:'image/png'};
    const tool = adaptWorkshopDefinition({name:'webReadPage', description:'figure', inputSchema:{}, handler:async () => ({content:[{type:'text' as const,text:'source'},image]})});
    const result = await tool.execute('figure', {});
    expect(result.content).toEqual([{type:'text',text:'source'},image]);
  });
  it('delivers figure pixels to the next model turn through the real Harness', async () => {
    const image = {type:'image' as const, data:'cG5n', mimeType:'image/png'};
    const tool = adaptWorkshopDefinition({name:'webReadPage', description:'figure', inputSchema:{}, handler:async () => ({content:[{type:'text' as const,text:'untrusted figure'},image]})});
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxToolCall('webReadPage',{}),{stopReason:'toolUse'}),fauxAssistantMessage('image received')]);
    const contexts: unknown[] = [];
    const stream: typeof faux.streamSimple = (model, context, options) => { contexts.push(JSON.parse(JSON.stringify(context))); return faux.streamSimple(model, context, options); };
    const runtime = createPiAgentRuntime({adapter:'harness',model:{...faux.getModel(),input:['text','image']},streamFn:stream,tools:[tool]});
    for await (const _ of runtime.run({operation:'run',prompt:'read figure'})) { /* Drain complete run. */ }
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(contexts.at(-1))).toContain('"type":"image"');
    expect(JSON.stringify(contexts.at(-1))).toContain('cG5n');
  });
  it('memory access uses the final Work tool set without owner-level escape', async () => {
    const work:any={id:'w',userId:'u',mission:'bounded mission',modelConfig:{allowedTools:['askMemory','time']},boundaryPolicy:{}};
    const tools=createWorkshopPiTools({workshop:work,workshopId:'w'});
    const result=await tools.find(tool=>tool.name==='askMemory')!.execute('inspect',{question:'what can I read',domains:['self','platform','memory']});
    const output=JSON.parse((result.content[0] as {text:string}).text);
    expect(output.observations[0].availableTools.map((tool:any)=>tool.name)).toEqual(['time','askMemory']);
    expect(output.observations.slice(1).map((row:any)=>row.status)).toEqual(['unavailable','unavailable']);
    expect(output.observations[0].identity).toMatchObject({kind:'workshop',id:'w',mission:'bounded mission'});
  });
  it('does not let nested memory access bypass approval-only source tools', async () => {
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['askMemory','webSearch'],requiresApprovalTools:['webSearch']},boundaryPolicy:{}};
    const tools=createWorkshopPiTools({workshop:work,workshopId:'w'});
    const result=await tools.find(tool=>tool.name==='askMemory')!.execute('nested',{question:'public',domains:['external'],publicQuery:'public'});
    expect(JSON.parse((result.content[0] as {text:string}).text).observations[0]).toMatchObject({status:'unavailable'});
  });
  beforeEach(() => {
    mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
  });

  it('preserves schema coercion/defaults and returns handler content', async () => {
    const handler=vi.fn(async args => ({content:[{type:'text' as const,text:JSON.stringify(args)}]}));
    const tool=adaptWorkshopDefinition({name:'read',description:'read',inputSchema:{limit:z.coerce.number().default(5)},handler});
    const result=await tool.execute('call',{});
    expect(handler).toHaveBeenCalledWith({limit:5},expect.objectContaining({toolCallId:'call'}));
    expect(result.content).toEqual([{type:'text',text:'{"limit":5}'}]);
    expect(tool.replay).toBe('never');
  });
  it('validates input and propagates domain errors instead of false success', async () => {
    const handler=vi.fn(async () => ({isError:true,content:[{type:'text' as const,text:'approval required'}]}));
    const tool=adaptWorkshopDefinition({name:'write',description:'write',inputSchema:{id:z.string()},handler});
    await expect(tool.execute('a',{})).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await expect(tool.execute('b',{id:'1'})).rejects.toThrow('approval required');
  });
  it('checks cancellation before dispatch', async () => {
    const handler=vi.fn();
    const tool=adaptWorkshopDefinition({name:'write',description:'write',inputSchema:{},handler});
    const c=new AbortController();c.abort();
    await expect(tool.execute('a',{},c.signal)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
  it('uses real Harness and calls the Loop permission gate before a write', async () => {
    const handler=vi.fn(async () => ({content:[{type:'text' as const,text:'written'}]}));
    const tool=adaptWorkshopDefinition({name:'write',description:'write',inputSchema:{},handler});
    const faux=createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write',{}),{stopReason:'toolUse'}),fauxAssistantMessage('blocked')]);
    const runtime=createPiAgentRuntime({adapter:'harness',model:faux.getModel(),streamFn:faux.streamSimple,tools:[tool]});
    const gate=vi.fn(async () => ({behavior:'deny' as const,message:'owner approval required'}));
    const messages=[];
    for await(const message of runtime.run({operation:'run',prompt:'write',options:{onPermissionRequest:gate}}))messages.push(message);
    expect(gate).toHaveBeenCalledOnce();expect(handler).not.toHaveBeenCalled();
    expect(messages).toContainEqual(expect.objectContaining({type:'tool_result',isError:true,output:expect.stringContaining('owner approval')}));
  });
  it('enforces configured capabilities and denied precedence across aliases', () => {
    const work:any={modelConfig:{allowedTools:['webReadPage','quantPaperPlaceOrder'],disallowedTools:[]},boundaryPolicy:{hardDeniedActions:['mcp__workshop-tools__quantPaperPlaceOrder']}};
    expect(resolveWorkshopPiAllowedTools(work,['webReadPage','quantPaperPlaceOrder','Bash'],['mcp__workshop-tools__webReadPage','quantPaperPlaceOrder','Bash'])).toEqual(['webReadPage']);
  });
  it('exposes full CUA delegation only with an explicit Work grant and execution lease', () => {
    const lease: any = { userId: 'u', workshopId: 'w', runId: 'r', workerId: 'worker', token: 1 };
    const work: any = { id: 'w', userId: 'u', modelConfig: { allowedTools: ['workshopRunComputerUse'] }, boundaryPolicy: {} };
    const input: any = { workshop: work, workshopId: 'w', runId: 'r', workDir: 'C:\\temp\\cua-test', executionLease: lease };
    expect(createWorkshopPiTools(input).map(tool => tool.name)).toContain('workshopRunComputerUse');
    expect(() => createWorkshopPiTools({ ...input, executionLease: undefined })).toThrow('not implemented');
    expect(createWorkshopPiTools({ ...input, workshop: { ...work, boundaryPolicy: { hardDeniedActions: ['workshopRunComputerUse'] } } }).map(tool => tool.name)).not.toContain('workshopRunComputerUse');
  });
  it('does not silently discard an unimplemented configured capability', () => {
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['workshopCustomRequiredTool']},boundaryPolicy:{}};
    expect(()=>createWorkshopPiTools({workshop:work,workshopId:'w'})).toThrow('not implemented');
  });

  it('includes Loop-requested tools even when Work model config only lists a smaller default set', () => {
    const handler = vi.fn(async () => ({content:[{type:'text' as const,text:'ok'}]}));
    mockedCreateWorkshopToolDefinitions.mockReturnValue([
      {name:'workshopLogEvent',description:'log',inputSchema:{},handler},
      {name:'watchlistFollowupTaskList',description:'tasks',inputSchema:{},handler},
      {name:'quantPaperGetWatchlist',description:'watchlist',inputSchema:{},handler},
    ]);
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['workshopLogEvent']},boundaryPolicy:{}};

    const tools = createWorkshopPiTools({
      workshop: work,
      workshopId: 'w',
      allowedTools: ['workshopLogEvent', 'watchlistFollowupTaskList'],
    });

    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['workshopLogEvent', 'watchlistFollowupTaskList']),
    );
  });

  it('keeps the executor base profile inside an explicit Work allowlist', () => {
    const handler=vi.fn(async () => ({content:[{type:'text' as const,text:'ok'}]}));
    mockedCreateWorkshopToolDefinitions.mockReturnValue([
      {name:'quantPaperGetWatchlist',description:'watchlist',inputSchema:{},handler},
      {name:'quantPaperGetAccount',description:'account',inputSchema:{},handler},
      {name:'workshopWriteMemory',description:'memory',inputSchema:{},handler},
    ]);
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['quantPaperGetWatchlist']},boundaryPolicy:{}};
    const requested=restrictWorkshopPiRequestedTools(work,
      ['quantPaperGetWatchlist','quantPaperGetAccount','workshopWriteMemory']);
    const tools=createWorkshopPiTools({workshop:work,workshopId:'w',allowedTools:requested});
    expect(tools.map(tool=>tool.name)).toEqual(['quantPaperGetWatchlist']);
  });

  it('does not require Claude built-ins or MCP aliases to exist as Pi domain tools', () => {
    const handler = vi.fn(async () => ({content:[{type:'text' as const,text:'ok'}]}));
    mockedCreateWorkshopToolDefinitions.mockReturnValue([
      {name:'workshopLogEvent',description:'log',inputSchema:{},handler},
      {name:'watchlistFollowupTaskList',description:'tasks',inputSchema:{},handler},
    ]);
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['workshopLogEvent']},boundaryPolicy:{}};

    const tools = createWorkshopPiTools({
      workshop: work,
      workshopId: 'w',
      allowedTools: [
        'Read',
        'Glob',
        'mcp__workshop-tools__workshopLogEvent',
        'mcp__workshop-tools__watchlistFollowupTaskList',
        'time',
      ],
    });

    expect(tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['workshopLogEvent', 'watchlistFollowupTaskList']),
    );
  });

  it('does not require configured Claude built-ins to exist as Pi domain tools', () => {
    const handler = vi.fn(async () => ({content:[{type:'text' as const,text:'ok'}]}));
    mockedCreateWorkshopToolDefinitions.mockReturnValue([
      {name:'workshopLogEvent',description:'log',inputSchema:{},handler},
    ]);
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['workshopLogEvent','Bash','Read','Edit','Write']},boundaryPolicy:{}};

    const tools = createWorkshopPiTools({workshop: work, workshopId: 'w'});

    expect(tools.map(tool => tool.name)).toEqual(['workshopLogEvent']);
  });

  it('registers codebase search only with an explicit grant, audits evidence and rejects revocation or hard denial',async()=>{
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['Read','Glob','Grep'],codebaseRead:{enabled:true}},boundaryPolicy:{}};
    vi.mocked(getWorkshop).mockResolvedValue(work);
    const tools=createWorkshopPiTools({workshop:work,workshopId:'w',workDir:process.cwd(),allowedTools:['Read','Glob','Grep']});
    expect(tools.map(tool=>tool.name)).toEqual(['Read','Glob','Grep']);
    await tools.find(tool=>tool.name==='Read')!.execute('code-read',{path:'repo/apps/web/lib/work-runtime/recorded-step.ts',limit:5});
    expect(vi.mocked(appendWorkshopEvent)).toHaveBeenCalledWith(expect.objectContaining({type:'tool_result',metadata:expect.objectContaining({codebaseObservation:expect.objectContaining({path:'repo/apps/web/lib/work-runtime/recorded-step.ts',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})})}));
    vi.mocked(getWorkshop).mockResolvedValue({...work,modelConfig:{...work.modelConfig,codebaseRead:{enabled:false}}});
    await expect(tools.find(tool=>tool.name==='Grep')!.execute('revoked',{query:'applyRecordedStep'})).rejects.toThrow('revoked');
    await expect(tools.find(tool=>tool.name==='Read')!.execute('revoked-read',{path:'repo/AGENTS.md'})).rejects.toThrow('revoked');
    vi.mocked(getWorkshop).mockResolvedValue({...work,boundaryPolicy:{hardDeniedActions:['Grep']}});
    await expect(tools.find(tool=>tool.name==='Grep')!.execute('denied',{query:'applyRecordedStep'})).rejects.toThrow('denied');
  });
  it('requires explicit Work permission for local Pi tools and rechecks it on every call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyu-pi-domain-local-'));
    try {
      const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['Read','Write','PowerShell']},boundaryPolicy:{}};
      vi.mocked(getWorkshop).mockResolvedValue(work);
      const tools = createWorkshopPiTools({workshop:work,workshopId:'w',workDir:root,allowedTools:['Read','Write','PowerShell']});
      expect(tools.map(tool => tool.name)).toEqual(['Read','Write','PowerShell']);
      const path = join(root, 'result.txt');
      await tools.find(tool => tool.name === 'Write')!.execute('write', {path,content:'ok'});
      expect(await readFile(path,'utf8')).toBe('ok');
      const outputDir = join(root, 'outputs');
      await mkdir(outputDir);
      const publishedPath = join(outputDir, 'brief.txt');
      await tools.find(tool => tool.name === 'Write')!.execute('publish', {path:publishedPath,content:'owner report'});
      expect(vi.mocked(appendWorkshopEvent)).toHaveBeenCalledWith(expect.objectContaining({
        type:'tool_result', metadata:expect.objectContaining({artifacts:[expect.objectContaining({
          fileName:'brief.txt',path:publishedPath,
        })]}),
      }));
      vi.mocked(getWorkshop).mockResolvedValue({...work,modelConfig:{allowedTools:['Read']}});
      await expect(tools.find(tool => tool.name === 'Write')!.execute('revoked',{path,content:'bad'})).rejects.toThrow('denied');
      expect(await readFile(path,'utf8')).toBe('ok');
      const denied={...work,boundaryPolicy:{hardDeniedActions:['Write']}};
      vi.mocked(getWorkshop).mockResolvedValue(denied);
      await expect(tools.find(tool => tool.name === 'Write')!.execute('hard-denied',{path,content:'bad'})).rejects.toThrow('denied');
      expect(await readFile(path,'utf8')).toBe('ok');
    } finally {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhiyu-pi-domain-local-')) throw Error('Unexpected Pi local cleanup path');
      await rm(target,{recursive:true,force:true});
    }
  });

  it('converts only an enabled staged source for the document cleaner Work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyu-pi-document-'));
    try {
      const inputDir = join(root, 'inputs');
      await mkdir(inputDir);
      const path = join(inputDir, 'source-1-notes.md');
      const content = '# Heading\n\nA useful paragraph for retrieval.\n';
      const sha256 = createHash('sha256').update(content).digest('hex');
      await writeFile(path, content, 'utf8');
      await writeFile(join(inputDir, 'index.json'), JSON.stringify({staged:[{sourceId:'source-1',runPath:path,sha256}]}));
      const work:any = {id:'w',userId:'u',modelConfig:{role:'document_markdown_cleaner',allowedTools:['workshopConvertDocument']},boundaryPolicy:{}};
      vi.mocked(getWorkshop).mockResolvedValue(work);
      vi.mocked(listWorkshopSources).mockResolvedValue([{id:'source-1',type:'file',enabled:true,name:'notes.md'}] as any);
      const tool = createWorkshopPiTools({workshop:work,workshopId:'w',workDir:root})
        .find(item => item.name === 'workshopConvertDocument');
      expect(tool).toBeDefined();
      vi.mocked(appendWorkshopEvent).mockClear();
      const result = await tool!.execute('convert',{sourceId:'source-1'});
      const output = JSON.parse((result.content[0] as {text:string}).text);
      expect(output).toMatchObject({sourceId:'source-1',sourceSha256:sha256,chunkCount:1});
      expect(await readFile(output.chunks[0].path,'utf8')).toContain('A useful paragraph');
      expect(vi.mocked(appendWorkshopEvent)).toHaveBeenCalledWith(expect.objectContaining({type:'document_converted'}));
      const repeated = await tool!.execute('convert-again',{sourceId:'source-1'});
      expect(JSON.parse((repeated.content[0] as {text:string}).text)).toMatchObject(output);
      expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([event]) => event.type === 'document_converted')).toHaveLength(1);
      vi.mocked(getWorkshop).mockResolvedValue({...work,modelConfig:{...work.modelConfig,allowedTools:[]}});
      await expect(tool!.execute('revoked',{sourceId:'source-1'})).rejects.toThrow('not granted');
      vi.mocked(getWorkshop).mockResolvedValue(work);
      vi.mocked(listWorkshopSources).mockResolvedValue([{id:'source-1',type:'file',enabled:false,name:'notes.md'}] as any);
      await expect(tool!.execute('disabled',{sourceId:'source-1'})).rejects.toThrow('unavailable');
    } finally {
      await removeDocumentFixture(root);
    }
  });

  it('converts a temporary input without a permanent source and rejects descriptors from another run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyu-pi-document-'));
    try {
      const path = join(root, '临时 数据.md');
      await writeFile(path, '# 临时任务\n\n这份内容仅用于本次对话。\n', 'utf8');
      const sources = createConversationFileSources({ workshopId: 'w', runId: 'run', inputFiles: [path] });
      await stagePiWorkshopFileSources(root, sources);
      const work: any = { id: 'w', userId: 'u', modelConfig: { role: 'document_markdown_cleaner', allowedTools: ['workshopConvertDocument'] }, boundaryPolicy: {} };
      vi.mocked(getWorkshop).mockResolvedValue(work);
      vi.mocked(listWorkshopSources).mockClear();
      vi.mocked(appendWorkshopEvent).mockClear();
      const tool = createWorkshopPiTools({ workshop: work, workshopId: 'w', runId: 'run', workDir: root, conversationSources: sources })
        .find(item => item.name === 'workshopConvertDocument')!;
      await tool.execute('convert', { sourceId: sources[0].id });
      expect(listWorkshopSources).not.toHaveBeenCalled();
      expect(appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'document_converted',
        metadata: expect.objectContaining({ inputReceipts: [expect.objectContaining({ path, status: 'used' })] }) }));
      const other = createWorkshopPiTools({ workshop: work, workshopId: 'w', runId: 'other', workDir: root, conversationSources: sources })
        .find(item => item.name === 'workshopConvertDocument')!;
      await expect(other.execute('escape', { sourceId: sources[0].id })).rejects.toThrow('outside this conversation run');
    } finally { await removeDocumentFixture(root); }
  });

  it('deduplicates native Pi tools already provided by workshop domain handlers', () => {
    const handler = vi.fn(async () => ({content:[{type:'text' as const,text:'ok'}]}));
    mockedCreateWorkshopToolDefinitions.mockReturnValue([
      {name:'webSearch',description:'search',inputSchema:{query:z.string()},handler},
      {name:'workshopLogEvent',description:'log',inputSchema:{},handler},
    ]);
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:['webSearch','workshopLogEvent']},boundaryPolicy:{}};

    const tools = createWorkshopPiTools({workshop: work, workshopId: 'w'});

    expect(tools.filter(tool => tool.name === 'webSearch')).toHaveLength(1);
    expect(tools.map(tool => tool.name)).toEqual(['webSearch', 'workshopLogEvent']);
  });

  it('does not silently discard an unimplemented Loop-requested capability', () => {
    const work:any={id:'w',userId:'u',modelConfig:{allowedTools:[]},boundaryPolicy:{}};
    expect(() =>
      createWorkshopPiTools({
        workshop: work,
        workshopId: 'w',
        allowedTools: ['watchlistFollowupTaskList'],
      }),
    ).toThrow('not implemented');
  });
});

describe('Pi document conversion memory synchronization', () => {
  let fixtureRoot: string;
  let work: any;
  let event: any;
  let sourcePath: string;

  const readOutput = (result: any) => JSON.parse(result.content[0].text);
  const tool = () => createWorkshopPiTools({workshop:work,workshopId:work.id,runId:'run-fixture',workDir:fixtureRoot})
    .find(item => item.name === 'workshopConvertDocument')!;

  beforeEach(async () => {
    vi.mocked(getWorkshop).mockReset();
    vi.mocked(appendWorkshopEvent).mockReset();
    vi.mocked(listWorkshopSources).mockReset();
    vi.mocked(listWorkshopEvents).mockReset().mockResolvedValue([]);
    vi.mocked(applyDocumentMemoryUpdate).mockReset().mockResolvedValue({status:'created_active'} as any);
    mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
    fixtureRoot = await mkdtemp(join(tmpdir(),'zhiyu-pi-document-'));
    await mkdir(join(fixtureRoot,'inputs'));
    sourcePath = join(fixtureRoot,'inputs','source-notes.md');
    const content = '# 独立文档\n\n本测试仅核验转换产物事实。\n';
    await writeFile(sourcePath,content,'utf8');
    await writeFile(join(fixtureRoot,'inputs','index.json'),JSON.stringify({staged:[{
      sourceId:'source-fixture',runPath:sourcePath,sha256:createHash('sha256').update(content).digest('hex'),
    }]}));
    work={id:'work-fixture',userId:'owner-fixture',modelConfig:{role:'document_markdown_cleaner',allowedTools:['workshopConvertDocument']},boundaryPolicy:{}};
    vi.mocked(getWorkshop).mockResolvedValue(work);
    vi.mocked(listWorkshopSources).mockResolvedValue([{id:'source-fixture',workshopId:work.id,type:'file',enabled:true,name:'独立文档.md'}] as any);
    vi.mocked(appendWorkshopEvent).mockImplementation(async (input: any) => {
      const written={...input,id:'runtime-event-fixture',seq:17,createdAt:new Date('2026-10-02T08:00:00.000Z')};
      if(input.type==='document_converted')event=written;
      return written as any;
    });
  });
  afterEach(async () => { await removeDocumentFixture(fixtureRoot); });

  it('passes verified generated hashes and the persisted runtime event to the internal adapter', async () => {
    const output=readOutput(await tool().execute('initial',{sourceId:'source-fixture'}));
    expect(output.memoryUpdate).toEqual({status:'created_active',result:{status:'created_active'}});
    expect(applyDocumentMemoryUpdate).toHaveBeenCalledTimes(1);
    const request=vi.mocked(applyDocumentMemoryUpdate).mock.calls[0][0];
    expect(request).toMatchObject({userId:work.userId,workId:work.id,sourceId:'source-fixture',sourceEventId:event.id,sourceEventSeq:17,observedAt:'2026-10-02T08:00:00.000Z',chunkCount:output.chunkCount,warnings:[]});
    expect(request.documentSha256).toBe(createHash('sha256').update(await readFile(output.documentPath)).digest('hex'));
    expect(request.manifestSha256).toBe(createHash('sha256').update(await readFile(output.manifestPath)).digest('hex'));
    expect(event.metadata).toMatchObject({receiptAuthority:'runtime',documentSha256:request.documentSha256,manifestSha256:request.manifestSha256});
  });

  it('keeps conversion success visible when Brain fails and retries the same event without reconverting', async () => {
    vi.mocked(applyDocumentMemoryUpdate).mockRejectedValueOnce(Object.assign(new Error('fixture database failure'),{code:'fixture_failure'}));
    const converter=tool();
    const failed=readOutput(await converter.execute('initial',{sourceId:'source-fixture'}));
    expect(failed.memoryUpdate).toMatchObject({status:'failed',code:'fixture_failure'});
    expect(await readFile(failed.documentPath,'utf8')).toContain('本测试仅核验');
    expect(appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({type:'memory_update_failed',metadata:expect.objectContaining({sourceEventId:event.id})}));
    expect(vi.mocked(appendWorkshopEvent).mock.calls.some(([input]) => input.type==='document_conversion_failed')).toBe(false);
    const recovered=readOutput(await converter.execute('retry',{sourceId:'source-fixture'}));
    expect(recovered.memoryUpdate.status).toBe('created_active');
    expect(vi.mocked(applyDocumentMemoryUpdate).mock.calls[1][0]).toEqual(vi.mocked(applyDocumentMemoryUpdate).mock.calls[0][0]);
    expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([input]) => input.type==='document_converted')).toHaveLength(1);
    vi.mocked(listWorkshopEvents).mockResolvedValue([event]);
    const reloaded=readOutput(await tool().execute('persisted-retry',{sourceId:'source-fixture'}));
    expect(reloaded.memoryUpdate.status).toBe('created_active');
    expect(vi.mocked(applyDocumentMemoryUpdate).mock.calls[2][0]).toEqual(vi.mocked(applyDocumentMemoryUpdate).mock.calls[0][0]);
    expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([input]) => input.type==='document_converted')).toHaveLength(1);
  });

  it('does not invoke the adapter without a persisted runtime conversion receipt', async () => {
    vi.mocked(appendWorkshopEvent).mockResolvedValue(undefined as any);
    const output=readOutput(await tool().execute('no-event',{sourceId:'source-fixture'}));
    expect(output.memoryUpdate).toMatchObject({status:'failed',code:'memory_update_failed'});
    expect(output.chunkCount).toBe(1);
    expect(applyDocumentMemoryUpdate).not.toHaveBeenCalled();
  });

  it('ignores an agent-authored conversion-shaped log and performs a real runtime conversion', async () => {
    vi.mocked(listWorkshopEvents).mockResolvedValue([{id:'agent-event',workshopId:work.id,runId:'run-fixture',seq:999,type:'document_converted',metadata:{receiptAuthority:'agent',sourceId:'source-fixture',sourceSha256:'spoofed'},createdAt:new Date()}] as any);
    const output=readOutput(await tool().execute('ignore-agent',{sourceId:'source-fixture'}));
    expect(output.memoryUpdate.status).toBe('created_active');expect(applyDocumentMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyDocumentMemoryUpdate).mock.calls[0][0].sourceEventId).toBe('runtime-event-fixture');
    expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([input])=>input.type==='document_converted')).toHaveLength(1);
  });

  it('replays the highest runtime sequence regardless of descending event order and ignores a higher agent log', async () => {
    await tool().execute('initial',{sourceId:'source-fixture'});
    const latest={...event,id:'latest-runtime-event',seq:18,createdAt:new Date('2026-10-02T08:00:01Z')};
    const older={...event,id:'older-runtime-event',seq:16,metadata:{...event.metadata,sourceSha256:'obsolete hash'}};
    const agent={...event,id:'agent-log-event',seq:100,metadata:{...event.metadata,receiptAuthority:'agent',sourceSha256:'spoofed hash'}};
    vi.mocked(listWorkshopEvents).mockResolvedValue([agent,latest,event,older]);
    const output=readOutput(await tool().execute('latest-replay',{sourceId:'source-fixture'}));
    expect(output.memoryUpdate.status).toBe('created_active');
    expect(vi.mocked(applyDocumentMemoryUpdate).mock.calls[1][0]).toMatchObject({sourceEventId:latest.id,sourceEventSeq:18,observedAt:'2026-10-02T08:00:01.000Z'});
    expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([input])=>input.type==='document_converted')).toHaveLength(1);
  });

  it('refuses changed output chunks on recovery while preserving the original conversion receipt', async () => {
    const converter=tool();
    const output=readOutput(await converter.execute('initial',{sourceId:'source-fixture'}));
    await writeFile(output.chunks[0].path,'changed chunk','utf8');
    const repeated=readOutput(await converter.execute('changed',{sourceId:'source-fixture'}));
    expect(repeated.memoryUpdate.status).toBe('failed');
    expect(applyDocumentMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendWorkshopEvent).mock.calls.filter(([input]) => input.type==='document_converted')).toHaveLength(1);
  });

  it('propagates a skipped adapter result without claiming that a memory was recorded', async () => {
    vi.mocked(applyDocumentMemoryUpdate).mockResolvedValue({status:'skipped',memory:null,reason:'non_monotonic_source'} as any);
    const output=readOutput(await tool().execute('ignored-source',{sourceId:'source-fixture'}));
    expect(output.memoryUpdate).toMatchObject({status:'skipped',result:{status:'skipped',memory:null,reason:'non_monotonic_source'}});
    expect(output.chunkCount).toBe(1);expect(vi.mocked(appendWorkshopEvent).mock.calls.some(([input])=>input.type==='memory_update_failed')).toBe(false);
  });

  it('skips long-term synchronization of temporary conversation sources', async () => {
    const sources=createConversationFileSources({workshopId:work.id,runId:'run-fixture',inputFiles:[sourcePath]});
    await stagePiWorkshopFileSources(fixtureRoot,sources);
    const converter=createWorkshopPiTools({workshop:work,workshopId:work.id,runId:'run-fixture',workDir:fixtureRoot,conversationSources:sources})
      .find(item => item.name==='workshopConvertDocument')!;
    const output=readOutput(await converter.execute('temporary',{sourceId:sources[0].id}));
    expect(output.memoryUpdate).toMatchObject({status:'skipped'});
    expect(output.memoryUpdate.reason).toContain('临时对话');
    expect(applyDocumentMemoryUpdate).not.toHaveBeenCalled();
  });
});

describe('Pi assigned Skill references', () => {
  let fixtureRoot: string;
  let skillPath: string;
  const work: any = {
    id: 'w', userId: 'u',
    modelConfig: { allowedTools: ['Skill'], primarySkills: ['assigned-skill'] },
    boundaryPolicy: {},
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
    fixtureRoot = await mkdtemp(join(tmpdir(), 'zhiyu-skill-resource-'));
    skillPath = join(fixtureRoot, 'assigned-skill');
    await mkdir(join(skillPath, 'references'), { recursive: true });
    vi.mocked(getWorkshop).mockResolvedValue(work);
    vi.mocked(loadSkills).mockReturnValue([
      { name: 'assigned-skill', description: 'fixture', path: skillPath },
    ]);
    vi.mocked(getSkillContent).mockReturnValue('Core skill instructions.');
  });

  afterEach(async () => {
    const target = resolve(fixtureRoot);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('zhiyu-skill-resource-')) {
      throw new Error('Unexpected Skill fixture cleanup path');
    }
    await rm(target, { recursive: true, force: true });
  });

  function skillTool() {
    const tool = createWorkshopPiTools({ workshop: work, workshopId: work.id })
      .find(item => item.name === 'Skill');
    if (!tool) throw new Error('Skill fixture tool missing');
    return tool;
  }

  it('reads an assigned reference and records the exact source and content hash', async () => {
    const resource = 'references/proposal-contract.md';
    const content = '# Proposal contract\nInclude verified evidence.\n';
    const referencePath = join(skillPath, resource);
    await writeFile(referencePath, content, 'utf8');

    const result = await skillTool().execute('reference', { skill: 'assigned-skill', resource });

    expect(result.content).toEqual([{ type: 'text', text: content }]);
    expect(result.details).toEqual({
      skill: 'assigned-skill', resource,
      sourcePath: await realpath(referencePath),
      byteLength: Buffer.byteLength(content, 'utf8'),
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
    expect(appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result', metadata: expect.objectContaining({ skillResource: result.details }),
    }));
    expect(getSkillContent).not.toHaveBeenCalled();
  });

  it('preserves Skill without resource and adds source metadata', async () => {
    const result = await skillTool().execute('core', { skill: 'assigned-skill' });
    expect(result.content).toEqual([{ type: 'text', text: 'Core skill instructions.' }]);
    expect(result.details).toMatchObject({
      skill: 'assigned-skill', resource: 'SKILL.md', sourcePath: join(skillPath, 'SKILL.md'),
      contentHash: createHash('sha256').update('Core skill instructions.').digest('hex'),
    });
    expect(getSkillContent).toHaveBeenCalledWith(skillPath);
  });

  it.each([
    '../outside.md',
    'references/../outside.md',
    'references/nested/../../outside.md',
    '/references/outside.md',
    'C:/references/outside.md',
    'C:\\references\\outside.md',
    '\\\\server\\share\\outside.md',
    'references\\outside.md',
    'references/contract.md:secret',
    'references/contract.md::$DATA',
    'references/contract.md.',
    'references/contract.md ',
    'references/contract.txt',
    'SKILL.md',
  ])('rejects path escape or non-reference input %s', async (resource) => {
    await expect(skillTool().execute('invalid', { skill: 'assigned-skill', resource }))
      .rejects.toThrow('relative .md file inside references/');
  });

  it('rejects a reference symlink that resolves outside references', async () => {
    const outside = join(fixtureRoot, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'outside content', 'utf8');
    await symlink(outside, join(skillPath, 'references', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(skillTool().execute('escape', {
      skill: 'assigned-skill', resource: 'references/escape/secret.md',
    })).rejects.toThrow('escapes the assigned references directory');
  });

  it('rejects a references directory symlink outside the assigned skill', async () => {
    const linkedSkill = join(fixtureRoot, 'linked-skill');
    const outside = join(fixtureRoot, 'outside');
    await mkdir(linkedSkill);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'outside content', 'utf8');
    await symlink(outside, join(linkedSkill, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    vi.mocked(loadSkills).mockReturnValue([
      { name: 'assigned-skill', description: 'fixture', path: linkedSkill },
    ]);

    await expect(skillTool().execute('escape-root', {
      skill: 'assigned-skill', resource: 'references/secret.md',
    })).rejects.toThrow('references directory escapes the assigned skill');
  });

  it('bounds UTF-8 bytes and rejects oversized content instead of truncating', async () => {
    await writeFile(join(skillPath, 'references', 'large.md'), '\u4e2d'.repeat(Math.ceil(MAX_SKILL_REFERENCE_BYTES / 3)), 'utf8');
    await expect(skillTool().execute('large', {
      skill: 'assigned-skill', resource: 'references/large.md',
    })).rejects.toThrow(`exceeds ${MAX_SKILL_REFERENCE_BYTES} bytes; no content was loaded`);
    expect(appendWorkshopEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result' }));
  });

  it('rejects a directory with a Markdown extension', async () => {
    await mkdir(join(skillPath, 'references', 'directory.md'));
    await expect(skillTool().execute('directory', {
      skill: 'assigned-skill', resource: 'references/directory.md',
    })).rejects.toThrow();
  });

  it('checks assignment before resolving any resource path', async () => {
    await expect(skillTool().execute('unassigned', {
      skill: 'unassigned-skill', resource: 'references/proposal-contract.md',
    })).rejects.toThrow('not assigned to this Work');
    expect(loadSkills).not.toHaveBeenCalled();
  });

  it('applies the latest Skill denial after tool registration', async () => {
    const tool = skillTool();
    vi.mocked(getWorkshop).mockResolvedValue({
      ...work, boundaryPolicy: { hardDeniedActions: ['Skill'] },
    });
    await expect(tool.execute('revoked', {
      skill: 'assigned-skill', resource: 'references/proposal-contract.md',
    })).rejects.toThrow('Skill access denied');
    expect(loadSkills).not.toHaveBeenCalled();
  });

  it('applies the latest assignment removal after tool registration', async () => {
    const tool = skillTool();
    vi.mocked(getWorkshop).mockResolvedValue({
      ...work, modelConfig: { ...work.modelConfig, primarySkills: ['different-skill'] },
    });
    await expect(tool.execute('unassigned-now', {
      skill: 'assigned-skill', resource: 'references/proposal-contract.md',
    })).rejects.toThrow('not assigned to this Work');
    expect(loadSkills).not.toHaveBeenCalled();
  });
});
