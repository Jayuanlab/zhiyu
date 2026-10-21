import { z } from 'zod';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createWorkshopToolDefinitions } from './mcp-tools';
import { resolveWorkshopPiAllowedTools } from './tool-access';
import { getWorkshop, appendWorkshopEvent } from './service';
import { loadSkills, getSkillContent } from '@/lib/ai/skills/loader';
import { readSkillReference } from '@/lib/ai/skills/resource-reader';
import { createMemoryAccessTool } from '@/lib/ai/memory-access';
import { workMemorySourceFilters } from "@/lib/memory/context/runtime-applicability";
import {
  createNativePiWebChatTools,
  NATIVE_PI_WEB_CHAT_TOOLS,
} from '@/lib/ai/native-pi-web-chat-tools';
import { createPiLocalTools, PI_LOCAL_TOOL_NAMES } from './pi-local-tools';
import type { WorkshopSource } from '@/lib/db/schema';
import { runCuaWorkTask } from '@/lib/work-runtime/cua/run-task';
import {hostCodebaseRoot} from './codebase-read';
import { readWorkFileBytes } from '@/lib/memory/files/read';
import { saveWorkDerivedFile } from '@/lib/memory/files/derived';
import { readLocalFileSnapshot } from '@/lib/memory/files/local-snapshot';
import { convertWorkshopDocumentToMarkdown } from './document-markdown';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { checkedRunPath } from './pi-local-tools';

const DOCUMENT_CLEANER_ROLE = 'document_markdown_cleaner';

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
  if (!input.workDir) return null;
  return {
    name: 'workshopConvertDocument',
    label: 'Convert document to Markdown chunks',
    description: 'Convert one currently bound immutable file snapshot into a managed derived Markdown artifact. Requires this Work role, an explicit conversion tool grant and current source binding permission. Original files are never edited; paths and staged indexes do not grant access.',
    parameters: Type.Object({ sourceId: Type.String() }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (toolCallId, rawParams, signal) => {
      signal?.throwIfAborted();
      const sourceId = (rawParams as { sourceId?: unknown }).sourceId;
      if (typeof sourceId !== 'string' || !sourceId.trim()) throw Error('sourceId is required');
      const current = await getWorkshop(input.workshop.userId, input.workshopId);
      const currentConfig = asRecord(current?.modelConfig);
      if (!current || currentConfig.role !== DOCUMENT_CLEANER_ROLE ||
        !stringArray(currentConfig.allowedTools).some(name => leafToolName(name).toLowerCase() === 'workshopconvertdocument') ||
        !resolveWorkshopPiAllowedTools(current, ['workshopConvertDocument'], ['workshopConvertDocument']).length) {
        throw Error('Document conversion is not granted to this Work');
      }
      const read = await readWorkFileBytes(sourceId, { permission: 'convert', tool: 'workshopConvertDocument' });
      const inputs = await checkedRunPath(input.workDir!, 'inputs'); await mkdir(inputs, { recursive: true });
      const temporary = await mkdtemp(join(inputs, '.bound-'));
      try {
        const filePath = join(temporary, `source${extname(read.name).toLowerCase()}`);
        await writeFile(filePath, read.bytes, { flag: 'wx' });
        signal?.throwIfAborted();
        const converted = await convertWorkshopDocumentToMarkdown({ runDir: input.workDir!, inputPath: relative(input.workDir!, filePath), sourceId, originalName: read.name });
        if (converted.source.sha256 !== read.sha256) throw Error('Converter input changed after its authorized snapshot read');
        const output = await readLocalFileSnapshot(input.workDir!, relative(input.workDir!, converted.documentPath), 100 * 1024 * 1024);
        const artifact = await saveWorkDerivedFile({ commandId: toolCallId, source: read.ref, name: `${basename(read.name, extname(read.name)).slice(0, 150)}.md`, bytes: output.bytes });
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded', sourceId, sourceRevision: read.ref.revision,
          sourceReceiptId: read.receiptId, artifactId: artifact.manifest.id, artifactRevision: artifact.ref.revision,
          artifactUrl: artifact.manifest.url, receiptId: artifact.receipt.id, chunkCount: converted.chunkCount, warnings: converted.warnings,
          semantics: 'derived_content', originalFileEdited: false }) }], details: { artifactId: artifact.manifest.id, sourceId,
            sourceRevision: read.ref.revision, receiptId: artifact.receipt.id, chunkCount: converted.chunkCount, warnings: converted.warnings } };
      } finally { await rm(temporary, { recursive: true, force: true }); }
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
  const nativeTools = createNativePiWebChatTools({ userId: input.workshop.userId, memoryWorkId: input.workshopId,
    memorySourceFilters: workMemorySourceFilters(input.workshop.modelConfig), includeMemoryAccess: false })
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
