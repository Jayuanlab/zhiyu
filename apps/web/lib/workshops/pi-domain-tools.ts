import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createWorkshopToolDefinitions } from './mcp-tools';
import { resolveWorkshopPiAllowedTools } from './tool-access';
import { getWorkshop, appendWorkshopEvent, listWorkshopSources, listWorkshopEvents } from './service';
import { loadSkills, getSkillContent } from '@/lib/ai/skills/loader';
import { readSkillReference } from '@/lib/ai/skills/resource-reader';
import { createMemoryAccessTool } from '@/lib/ai/memory-access';
import {
  createNativePiWebChatTools,
  NATIVE_PI_WEB_CHAT_TOOLS,
} from '@/lib/ai/native-pi-web-chat-tools';
import { createPiLocalTools, PI_LOCAL_TOOL_NAMES } from './pi-local-tools';
import { convertWorkshopDocumentToMarkdown } from './document-markdown';
import type { WorkshopEvent, WorkshopSource } from '@/lib/db/schema';
import { conversationInputSourceId } from './conversation-input';
import { runCuaWorkTask } from '@/lib/work-runtime/cua/run-task';
import {hostCodebaseRoot} from './codebase-read';

const DOCUMENT_CLEANER_ROLE = 'document_markdown_cleaner';

/** Conversion and memory are separate receipts. Retry memory against the same immutable event. */
async function synchronizeDocumentMemory(input: {
  userId: string; workId: string; runDir: string; temporary: boolean;
}, event: WorkshopEvent | undefined, receipt: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.temporary) return { status: 'skipped', reason: '临时对话资料仅用于本次运行，不自动写入长期记忆。' };
  try {
    if (!event?.id || event.type !== 'document_converted' || event.workshopId !== input.workId ||
        receipt.receiptAuthority !== 'runtime') throw Error('Runtime conversion receipt unavailable');
    const root = await realpath(input.runDir);
    const artifact = async (value: unknown) => {
      if (typeof value !== 'string' || !isAbsolute(value)) throw Error('Conversion artifact path invalid');
      const canonical = await realpath(value), rel = relative(root, canonical);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('Conversion artifact outside this run');
      return readFile(canonical);
    };
    const [document, manifestBytes] = await Promise.all([artifact(receipt.documentPath), artifact(receipt.manifestPath)]);
    const documentSha256 = createHash('sha256').update(document).digest('hex');
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (documentSha256 !== receipt.documentSha256 || manifestSha256 !== receipt.manifestSha256 ||
        manifest.source?.sourceId !== receipt.sourceId || manifest.source?.sha256 !== receipt.sourceSha256 ||
        manifest.source?.format !== receipt.sourceFormat || manifest.document?.sha256 !== documentSha256 ||
        !Array.isArray(manifest.chunks) || manifest.chunks.length !== receipt.chunkCount || manifest.chunks.length > 4096 ||
        JSON.stringify(manifest.conversion?.warnings) !== JSON.stringify(receipt.warnings)) {
      throw Error('Conversion artifacts do not match the persisted receipt');
    }
    for (let offset = 0; offset < manifest.chunks.length; offset += 25) {
      await Promise.all(manifest.chunks.slice(offset, offset + 25).map(async (chunk: { fileName?: unknown; sha256?: unknown }) => {
        if (typeof chunk.fileName !== 'string' || chunk.fileName !== basename(chunk.fileName)) throw Error('Invalid conversion chunk path');
        const bytes = await artifact(join(dirname(String(receipt.manifestPath)), chunk.fileName));
        if (createHash('sha256').update(bytes).digest('hex') !== chunk.sha256) throw Error('Conversion chunk changed');
      }));
    }
    const { applyDocumentMemoryUpdate } = await import('@/lib/brain/memory-update-document');
    const result = await applyDocumentMemoryUpdate({
      userId: input.userId, workId: input.workId,
      sourceId: String(receipt.sourceId), sourceEventId: event.id,
      sourceEventSeq: event.seq, observedAt: new Date(event.createdAt).toISOString(),
      sourceSha256: String(receipt.sourceSha256), documentSha256, manifestSha256,
      sourceFormat: String(receipt.sourceFormat), chunkCount: Number(receipt.chunkCount),
      warnings: Array.isArray(receipt.warnings) ? receipt.warnings.map(String) : [],
      sourceName: event.title,
    });
    return { status: result.status, result };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'memory_update_failed';
    const warning = '转换产物已生成，但记忆同步失败；重试转换工具会核对并重试同一回执的记忆同步。';
    try {
      await appendWorkshopEvent({ workshopId: input.workId, runId: event?.runId,
        loopId: event?.loopId, loopRunId: event?.loopRunId, type: 'memory_update_failed',
        title: '文档转换记忆同步待恢复', body: warning,
        metadata: { sourceEventId: event?.id ?? null, sourceId: receipt.sourceId, code, receiptAuthority: 'runtime' },
      });
    } catch { /* The caller still receives the failed synchronization and its recovery instruction. */ }
    return { status: 'failed', code, warning };
  }
}

function createCuaTaskTool(input: Input): AgentTool<any> | null {
  if (!input.runId || !input.workDir || !input.executionLease) return null;
  return {
    name: 'workshopRunComputerUse',
    label: 'Run a computer-use task',
    description: 'Delegate one complete task to the upstream OpenAI CUA agent. JavaScript uses persistent Playwright browser code; Python uses persistent PyAutoGUI desktop code on this machine. The upstream run records screenshots and replay. Do not use it for sending messages, purchases, deletion, or permission changes.',
    parameters: Type.Object({
      backend: Type.Union([Type.Literal('javascript'), Type.Literal('python')]),
      prompt: Type.String(),
    }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (toolCallId, rawParams, signal) => {
      const params = rawParams as { backend?: string; prompt?: string };
      if (params.backend !== 'javascript' && params.backend !== 'python') throw Error('Invalid CUA backend');
      if (typeof params.prompt !== 'string') throw Error('CUA prompt is required');
      signal?.throwIfAborted();
      const current = await getWorkshop(input.workshop.userId, input.workshopId);
      const configured = stringArray(asRecord(current?.modelConfig).allowedTools).map(name => leafToolName(name).toLowerCase());
      if (!current || !configured.includes('workshopruncomputeruse') ||
        !resolveWorkshopPiAllowedTools(current, ['workshopRunComputerUse'], ['workshopRunComputerUse']).length) {
        throw Error('Computer use is not granted to this Work');
      }
      const result = await runCuaWorkTask({
        backend: params.backend, prompt: params.prompt, toolCallId,
        workshopId: input.workshopId, runId: input.runId!, workDir: input.workDir!,
        lease: input.executionLease!, signal,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

function createDocumentConversionTool(input: Input): AgentTool<any> | null {
  const runDir = input.workDir;
  if (!runDir) return null;
  let previousReceipts: Map<string, { receipt: Record<string, unknown>; event: WorkshopEvent | undefined }> | null = null;
  return {
    name: 'workshopConvertDocument',
    label: 'Convert document to Markdown chunks',
    description: 'Convert one staged file source into a full Markdown document, numbered Markdown chunks, and a provenance manifest. Use the staged sourceId; unsupported and empty documents fail explicitly.',
    parameters: Type.Object({ sourceId: Type.String() }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (_id, rawParams, signal) => {
      signal?.throwIfAborted();
      const params = rawParams as { sourceId?: unknown };
      const sourceId = typeof params?.sourceId === 'string' ? params.sourceId.trim() : '';
      if (!sourceId) throw Error('sourceId is required');
      const current = await getWorkshop(input.workshop.userId, input.workshopId);
      const currentConfig = asRecord(current?.modelConfig);
      if (!current || currentConfig.role !== DOCUMENT_CLEANER_ROLE ||
        !stringArray(currentConfig.allowedTools).some(name => leafToolName(name).toLowerCase() === 'workshopconvertdocument') ||
        !resolveWorkshopPiAllowedTools(current, ['workshopConvertDocument'], ['workshopConvertDocument']).length) {
        throw Error('Document conversion is not granted to this Work');
      }
      // Runtime-owned descriptors are confined to this run and never register durable sources.
      const sources: WorkshopSource[] = input.conversationSources ?? await listWorkshopSources(input.workshopId, 1000);
      const source = sources.find(item => item.id === sourceId && item.type === 'file' && item.enabled);
      if (!source) throw Error('File source is unavailable or disabled');
      if (input.conversationSources && (!input.runId || source.workshopId !== input.workshopId ||
          source.config?.scope !== 'conversation' || source.config?.runId !== input.runId ||
          !source.uri || source.id !== conversationInputSourceId(input.runId, source.uri))) {
        throw Error('Temporary input is outside this conversation run');
      }
      const index = JSON.parse(await readFile(join(runDir, 'inputs', 'index.json'), 'utf8')) as {
        staged?: Array<{sourceId: string; runPath: string; sha256: string}>;
      };
      const staged = index.staged?.find(item => item.sourceId === sourceId);
      if (!staged) throw Error('File source was not staged for this run');
      signal?.throwIfAborted();
      if (!previousReceipts) {
        const events = await listWorkshopEvents(input.workshopId, {
          runId: input.loopRunId ?? input.runId ?? undefined,
          types: ['document_converted'],
          limit: 1001,
        });
        previousReceipts = new Map();
        for (const event of events as WorkshopEvent[]) {
          if (input.loopRunId ? event.loopRunId !== input.loopRunId : event.runId !== input.runId || event.loopRunId) continue;
          const metadata = asRecord(event.metadata);
          if (metadata.receiptAuthority !== 'runtime' || typeof metadata.sourceId !== 'string') continue;
          const known = previousReceipts.get(metadata.sourceId);
          if (!known?.event || event.seq > known.event.seq) {
            previousReceipts.set(metadata.sourceId, { receipt: metadata, event });
          }
        }
      }
      const previous = previousReceipts.get(sourceId);
      const prior = previous?.receipt;
      const memoryContext = { userId: input.workshop.userId, workId: input.workshopId, runDir, temporary: Boolean(input.conversationSources) };
      if (prior) {
        if (prior.sourceSha256 !== staged.sha256 ||
          createHash('sha256').update(await readFile(staged.runPath)).digest('hex') !== staged.sha256) {
          throw Error('Staged source changed since the previous conversion');
        }
        const memoryUpdate = await synchronizeDocumentMemory(memoryContext, previous?.event, prior);
        return { content: [{ type: 'text', text: JSON.stringify({ ...prior, memoryUpdate }) }],
          details: { sourceId, manifestPath: prior.manifestPath, chunkCount: prior.chunkCount, memoryUpdate } };
      }
      let result;
      try {
        result = await convertWorkshopDocumentToMarkdown({
          runDir, inputPath: staged.runPath,
          sourceId, originalName: source.name,
        });
        if (result.source.sha256 !== staged.sha256) throw Error('Staged source changed during conversion');
      } catch (error) {
        if (!signal?.aborted) {
          await appendWorkshopEvent({
            workshopId: input.workshopId, runId: input.runId, loopId: input.loopId, loopRunId: input.loopRunId,
            type: 'document_conversion_failed', title: source.name,
            body: error instanceof Error ? error.message : String(error),
            metadata: { receiptAuthority: 'runtime', sourceId, sourceName: source.name, error: error instanceof Error ? error.message : String(error) },
          }).catch(() => undefined);
        }
        throw error;
      }
      const manifestSha256 = createHash('sha256').update(await readFile(result.manifestPath)).digest('hex');
      const documentSha256 = createHash('sha256').update(await readFile(result.documentPath)).digest('hex');
      const conversionEvent = await appendWorkshopEvent({
        workshopId: input.workshopId, runId: input.runId, loopId: input.loopId, loopRunId: input.loopRunId,
        type: 'document_converted', title: source.name,
        body: `${result.chunkCount} Markdown chunks generated`,
        metadata: { receiptAuthority: 'runtime', sourceId, sourceSha256: result.source.sha256, sourceFormat: result.source.format,
          ...(input.conversationSources ? { inputReceipts: [{ path: source.uri, status: 'used', detail: `${result.chunkCount} 个 Markdown 分片已生成并核验` }] } : {}),
          documentPath: result.documentPath, documentSha256,
          manifestPath: result.manifestPath, manifestSha256,
          chunkCount: result.chunkCount, chunks: result.chunks, warnings: result.warnings,
          artifacts: [
            { fileName: 'document.md', path: result.documentPath, sha256: documentSha256,
              label: '完整 Markdown', kind: 'document', mime: 'text/markdown' },
            { fileName: 'manifest.json', path: result.manifestPath, sha256: manifestSha256,
              label: '产物清单', kind: 'manifest', mime: 'application/json' },
            ...result.chunks.map(chunk => ({ fileName: `chunk-${String(chunk.index + 1).padStart(4, '0')}.md`,
              path: chunk.path, sha256: chunk.sha256,
              label: `分片 ${chunk.index + 1}`, kind: 'chunk', mime: 'text/markdown' })),
          ] },
      });
      const receipt = {
        sourceId, sourceSha256: result.source.sha256, sourceFormat: result.source.format,
        documentPath: result.documentPath, manifestPath: result.manifestPath,
        chunkCount: result.chunkCount, chunks: result.chunks, warnings: result.warnings,
      };
      const persistedReceipt = { ...receipt, documentSha256, manifestSha256, receiptAuthority: 'runtime' };
      previousReceipts.set(sourceId, { receipt: persistedReceipt, event: conversionEvent });
      const memoryUpdate = await synchronizeDocumentMemory(memoryContext, conversionEvent, persistedReceipt);
      return { content: [{ type: 'text', text: JSON.stringify({ ...receipt, memoryUpdate }) }], details: { sourceId, manifestPath: result.manifestPath, chunkCount: result.chunkCount, memoryUpdate } };
    },
  };
}

type Input = Parameters<typeof createWorkshopToolDefinitions>[0] & {
  allowedTools?: readonly string[]; workDir?: string; conversationSources?: WorkshopSource[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function leafToolName(name: string) {
  return name.split('__').pop() ?? name;
}

export function isWorkshopPiBuiltinTool(name: string) {
  const leaf = leafToolName(name);
  return ['Read','Glob','Grep','WebFetch','LSP','TodoWrite','Bash','Task','Edit','Write'].includes(leaf);
}

export function isPiDomainRequestedTool(name: string) {
  const leaf = leafToolName(name);
  if (isWorkshopPiBuiltinTool(leaf)) return false;
  if ((NATIVE_PI_WEB_CHAT_TOOLS as readonly string[]).includes(leaf)) return true;
  return /^(workshop|wechat|interaction|ownerContext|webReadPage|aStock|quant|watchlist|video|douyin|Skill)/.test(leaf);
}

function normalizeRuntimeRequestedTools(input: Input, registered: readonly string[]) {
  const registeredSet = new Set(registered);
  const normalized: string[] = [];
  for (const name of input.allowedTools ?? []) {
    const leaf = leafToolName(name);
    if (registeredSet.has(leaf) || isPiDomainRequestedTool(leaf)) normalized.push(leaf);
  }
  return [...new Set(normalized)];
}

function normalizeConfiguredTools(input: Input) {
  return stringArray(asRecord(input.workshop.modelConfig).allowedTools)
    .map(name => {
      const leaf = leafToolName(name);
      if (isPiDomainRequestedTool(leaf)) return leaf;
      return input.workDir ? PI_LOCAL_TOOL_NAMES.find(local => local.toLowerCase() === leaf.toLowerCase()) : undefined;
    })
    .filter((name): name is string => Boolean(name));
}

function withRuntimeRequestedTools(input: Input) {
  const requested = normalizeRuntimeRequestedTools(input, []);
  if (!requested.length) return input.workshop;
  const config = asRecord(input.workshop.modelConfig);
  return {
    ...input.workshop,
    modelConfig: {
      ...config,
      allowedTools: [...new Set([...stringArray(config.allowedTools), ...requested])],
    },
  };
}

/** Reuse the domain handlers, not a Claude process or MCP transport. */
export function adaptWorkshopDefinition(definition: SdkMcpToolDefinition<any>): AgentTool<any> {
  const schema = z.object(definition.inputSchema);
  return {
    name: definition.name, label: definition.name, description: definition.description,
    parameters: Type.Unsafe(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })),
    replay: 'never', executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const parsed = await schema.parseAsync(params);
      signal?.throwIfAborted();
      const result = await definition.handler(parsed, { signal, toolCallId });
      const text = (result.content ?? []).map((block: any) => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n');
      if (result.isError) throw new Error(text || `Tool failed: ${definition.name}`);
      const content = (result.content ?? []).map((block: any) => block.type === 'image'
        ? { type: 'image' as const, data: block.data as string, mimeType: block.mimeType as string }
        : { type: 'text' as const, text: block.type === 'text' ? block.text as string : JSON.stringify(block) });
      return { content, details: { toolCallId } };
    },
  };
}

export function createWorkshopPiTools(input: Input): AgentTool<any>[] {
  const requestedForPolicy = normalizeRuntimeRequestedTools(input, []);
  const policyWorkshop = withRuntimeRequestedTools({...input, allowedTools: requestedForPolicy});
  const definitions = createWorkshopToolDefinitions({...input, workshop: policyWorkshop, runtime: 'pi'});
  const definitionNames = new Set(definitions.map(definition => definition.name));
  const nativeTools = createNativePiWebChatTools({ userId: input.workshop.userId, memoryWorkId: input.workshopId, includeMemoryAccess: false })
    .filter(tool => isPiDomainRequestedTool(tool.name) && !definitionNames.has(tool.name));
  const explicitlyAllowed = new Set(stringArray(asRecord(input.workshop.modelConfig).allowedTools).map(name => leafToolName(name).toLowerCase()));
  const codebaseRoot=asRecord(asRecord(input.workshop.modelConfig).codebaseRead).enabled===true
    ? hostCodebaseRoot() : undefined;
  const localTools = input.workDir && PI_LOCAL_TOOL_NAMES.some(name => explicitlyAllowed.has(name.toLowerCase()))
    ? createPiLocalTools(input.workDir,codebaseRoot).filter(tool => explicitlyAllowed.has(tool.name.toLowerCase()))
    : [];
  const conversionTool = explicitlyAllowed.has('workshopconvertdocument') ? createDocumentConversionTool(input) : null;
  const cuaTool = explicitlyAllowed.has('workshopruncomputeruse') ? createCuaTaskTool(input) : null;
  const registered = [...definitions.map(d => d.name), ...nativeTools.map(tool => tool.name), ...localTools.map(tool => tool.name), ...(conversionTool ? [conversionTool.name] : []), ...(cuaTool ? [cuaTool.name] : []), 'Skill', 'askMemory'];
  const requestedTools = normalizeRuntimeRequestedTools(input, registered);
  const configuredTools = normalizeConfiguredTools(input);
  const required = [...configuredTools, ...requestedTools];
  if (required.length) {
    const expected = resolveWorkshopPiAllowedTools(policyWorkshop, required, required);
    const missing = expected.filter(name => !registered.includes(name));
    if (missing.length) throw Error(`Work Pi tools not implemented: ${missing.join(', ')}`);
  }
  const requestedScope = requestedTools.length
    ? requestedTools
    : configuredTools.length
      ? configuredTools
      : registered;
  const names = new Set(resolveWorkshopPiAllowedTools(policyWorkshop, registered, requestedScope));
  const tools = [
    ...definitions.filter(d => names.has(d.name)).map(adaptWorkshopDefinition),
    ...nativeTools.filter(tool => names.has(tool.name)),
    ...(conversionTool && names.has(conversionTool.name) ? [conversionTool] : []),
    ...(cuaTool && names.has(cuaTool.name) ? [cuaTool] : []),
    ...localTools.filter(tool => names.has(tool.name)).map(tool => ({...tool, execute: async (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const current = await getWorkshop(input.workshop.userId, input.workshopId);
      const currentAllowed = stringArray(asRecord(current?.modelConfig).allowedTools).map(name => leafToolName(name).toLowerCase());
      if (!current || !currentAllowed.includes(tool.name.toLowerCase()) || !resolveWorkshopPiAllowedTools(current, [tool.name], [tool.name]).length) {
        throw Error(`Work Pi local tool denied: ${tool.name}`);
      }
      if((tool.name==='Glob'||tool.name==='Grep'||(tool.name==='Read'&&/^repo[\\/]/.test(String(params.path))))&&asRecord(asRecord(current.modelConfig).codebaseRead).enabled!==true)throw Error('Codebase read grant has been revoked');
      return tool.execute(id, params, signal, onUpdate);
    }})),
  ];
  if (names.has('Skill')) {
    tools.push({name: 'Skill', label: 'Skill', description: 'Read the complete instructions of a skill assigned to this Work. To read a referenced Markdown contract, provide resource such as references/proposal-contract.md (maximum 64 KiB, no truncation). Guidance never grants tool permissions.',
      parameters: Type.Object({skill: Type.String(), resource: Type.Optional(Type.String())}), replay: 'never', executionMode: 'sequential',
      execute: async (_id, rawParams, signal) => {
        const params = z.object({skill:z.string(), resource:z.string().optional()}).parse(rawParams);
        signal?.throwIfAborted();
        const current = await getWorkshop(input.workshop.userId, input.workshopId);
        if (!current || !resolveWorkshopPiAllowedTools(current, ['Skill']).length) throw Error('Skill access denied');
        const config = current.modelConfig as Record<string, any>;
        const assigned = new Set([...(config.primarySkills ?? []), ...Object.values(config.loopSkillMap ?? {})]);
        if (!assigned.has(params.skill)) throw Error('Skill is not assigned to this Work');
        const skill = loadSkills().find(s => s.name === params.skill);
        if (!skill) throw Error(`Assigned skill unavailable: ${params.skill}`);
        signal?.throwIfAborted();
        if (params.resource !== undefined) {
          const { content, ...details } = await readSkillReference(skill.path, params.resource);
          signal?.throwIfAborted();
          return {content: [{type:'text', text:content}], details:{skill:params.skill, ...details}};
        }
        const content = getSkillContent(skill.path);
        if (!content) throw Error(`Assigned skill unavailable: ${params.skill}`);
        return {content: [{type:'text', text:content}], details:{
          skill:params.skill, sourcePath:resolve(skill.path, 'SKILL.md'), resource:'SKILL.md',
          byteLength:Buffer.byteLength(content, 'utf8'), contentHash:createHash('sha256').update(content, 'utf8').digest('hex'),
        }};
      }});
  }
  const audit = (tool: AgentTool<any>): AgentTool<any> => ({...tool, execute: async (id, params, signal, onUpdate) => {
    const start = Date.now();
    try {
      const result = await tool.execute(id, params, signal, onUpdate);
      const localArtifact = (tool.name === 'Write' || tool.name === 'Edit') && result.details
        ? { artifactPath: (result.details as any).artifactPath, sha256: (result.details as any).sha256 }
        : undefined;
      const outputRoot = input.workDir ? resolve(input.workDir, 'outputs') : null;
      const artifactPath = typeof localArtifact?.artifactPath === 'string' ? resolve(localArtifact.artifactPath) : null;
      const relativeOutput = outputRoot && artifactPath ? relative(outputRoot, artifactPath) : null;
      const publishedArtifact = artifactPath && relativeOutput && relativeOutput !== '..' &&
        !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput) &&
        typeof localArtifact?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(localArtifact.sha256)
          ? { fileName: basename(artifactPath), path: artifactPath, sha256: localArtifact.sha256,
              label: basename(artifactPath), kind: 'file' }
          : null;
      await appendWorkshopEvent({workshopId:input.workshopId,runId:input.runId,loopId:input.loopId,loopRunId:input.loopRunId,
        type:'tool_result',title:tool.name,body:'Pi domain tool completed',metadata:{runtimeTrace:true,piDomainTool:true,toolName:tool.name,toolUseId:id,durationMs:Date.now()-start,...((result.details as any)?.codebaseObservation ? {codebaseObservation:(result.details as any).codebaseObservation}:{}),...(tool.name === 'Skill' ? {skillResource:result.details} : {}), ...(localArtifact ? {localArtifact} : {}), ...(publishedArtifact ? {artifacts:[publishedArtifact]} : {})}});
      return result;
    } catch(error) {
      await appendWorkshopEvent({workshopId:input.workshopId,runId:input.runId,loopId:input.loopId,loopRunId:input.loopRunId,
        type:'tool_error',title:tool.name,body:error instanceof Error?error.message:String(error),metadata:{runtimeTrace:true,piDomainTool:true,toolName:tool.name,toolUseId:id}});
      throw error;
    }
  }});
  const audited = tools.map(audit);
  const approvalOnly = new Set(stringArray(asRecord(input.workshop.modelConfig).requiresApprovalTools).map(name => leafToolName(name).toLowerCase()));
  if (names.has('askMemory')) audited.push(audit(createMemoryAccessTool({ tools: audited.filter(tool => !approvalOnly.has(tool.name.toLowerCase())),
    identity: { kind: 'workshop', id: input.workshopId, mission: input.workshop.mission ?? undefined } })));
  return audited;
}
