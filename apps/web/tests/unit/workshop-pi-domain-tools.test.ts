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
vi.mock('@/lib/memory/revision/document-update', () => ({applyDocumentMemoryUpdate:vi.fn()}));
vi.mock('@/lib/ai/skills/loader', () => ({loadSkills:vi.fn(() => []),getSkillContent:vi.fn()}));
import { adaptWorkshopDefinition, createWorkshopPiTools } from '@/lib/workshops/pi-domain-tools';
import { createWorkshopToolDefinitions } from '@/lib/workshops/mcp-tools';
import { getWorkshop, appendWorkshopEvent, listWorkshopSources, listWorkshopEvents } from '@/lib/workshops/service';
import { applyDocumentMemoryUpdate } from '@/lib/memory/revision/document-update';
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

  it('refuses a forged staged index without reading source bytes and still rechecks Work permission', async () => {
    mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
    const work:any = {id:'w',userId:'u',modelConfig:{role:'document_markdown_cleaner',allowedTools:['workshopConvertDocument']},boundaryPolicy:{}};
    vi.mocked(getWorkshop).mockResolvedValue(work);
    vi.mocked(listWorkshopSources).mockClear(); vi.mocked(listWorkshopEvents).mockClear();
    const converter=createWorkshopPiTools({workshop:work,workshopId:'w',workDir:join(tmpdir(),'unregistered-nonexistent-work-input')})
      .find(tool=>tool.name==='workshopConvertDocument')!;
    await expect(converter.execute('blocked',{sourceId:'forged-staged-source'})).rejects.toMatchObject({code:'work_file_unavailable',status:403});
    expect(listWorkshopSources).not.toHaveBeenCalled(); expect(listWorkshopEvents).not.toHaveBeenCalled();
    vi.mocked(getWorkshop).mockResolvedValue({...work,modelConfig:{...work.modelConfig,allowedTools:[]}});
    await expect(converter.execute('revoked',{sourceId:'forged-staged-source'})).rejects.toThrow('not granted');
  });

  it('does not elevate temporary conversation paths into a Work file binding', async () => {
    mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
    const work:any={id:'w',userId:'u',modelConfig:{role:'document_markdown_cleaner',allowedTools:['workshopConvertDocument']},boundaryPolicy:{}};
    vi.mocked(getWorkshop).mockResolvedValue(work);
    const sources=createConversationFileSources({workshopId:'w',runId:'run',inputFiles:['unregistered-private-file.md']});
    const converter=createWorkshopPiTools({workshop:work,workshopId:'w',runId:'run',workDir:join(tmpdir(),'unregistered-conversation-input'),conversationSources:sources})
      .find(tool=>tool.name==='workshopConvertDocument')!;
    await expect(converter.execute('temporary',{sourceId:sources[0].id})).rejects.toMatchObject({code:'work_file_unavailable'});
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

describe('Pi unbound conversion recovery cannot bypass source admission', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mockedCreateWorkshopToolDefinitions.mockReturnValue([]);
  });
  it.each(['agent-authored-log','prior-runtime-conversion','changed-output-replay','adapter-retry'])('refuses %s before replay, parsing or memory synchronization', async attempt => {
    const work:any={id:'work-fixture',userId:'owner-fixture',modelConfig:{role:'document_markdown_cleaner',allowedTools:['workshopConvertDocument']},boundaryPolicy:{}};
    vi.mocked(getWorkshop).mockResolvedValue(work);
    vi.mocked(listWorkshopEvents).mockResolvedValue([{id:'old-event',type:'document_converted',metadata:{receiptAuthority:'runtime',sourceId:attempt}}] as any);
    const converter=createWorkshopPiTools({workshop:work,workshopId:work.id,runId:'run-fixture',workDir:join(tmpdir(),'unregistered-'+attempt)})
      .find(tool=>tool.name==='workshopConvertDocument')!;
    await expect(converter.execute(attempt,{sourceId:attempt})).rejects.toMatchObject({status:403,code:'work_file_unavailable'});
    expect(listWorkshopEvents).not.toHaveBeenCalled(); expect(listWorkshopSources).not.toHaveBeenCalled(); expect(applyDocumentMemoryUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(appendWorkshopEvent).mock.calls.some(([event])=>event.type==='document_converted')).toBe(false);
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
