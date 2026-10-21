// One fresh SDK session per case. This process never loads answer labels.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { EvalConfigurationLockError, evalProviderLockPath, readEvalProviderLock, verifyEvalVersionLock, readLockedEvalProvider } from './lib/platform-eval-v2-provider-lock.mjs';
import { createHostAnswerEvidenceSession, selectHostAnswerEvidenceContract, type HostAnswerEvidenceSession } from '../lib/ai/runtime/answer-evidence-selection';
import type { PlatformFieldPageBinding } from '../lib/ai/platform-field-pages';
import { guardExactLoopAnswer } from '../lib/ai/runtime/answer-evidence-loop-gate';
import { guardOwnerLoopFacetAnswer } from '../lib/ai/loop-owner-facet-session';
import { createOwnerLoopPartialHost, type OwnerLoopPartialHost } from '../lib/ai/loop-partial-host';
import { wrapOwnerLoopWorkflowReaders } from '../lib/ai/loop-partial-workflow-tools';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@openzhiyu/ai/agent/types';
import { type PlatformAnswerSession } from '../lib/ai/runtime/platform-answer-session';
import { guardPlatformAnswer } from '../lib/ai/runtime/platform-answer-gate';
import { createMemoryReadBudget } from '../lib/ai/memory-read-budget';
import type { AnswerEvidenceSession } from '../lib/ai/runtime/answer-evidence-session';
import { answerEvidenceHash, answerTextHash } from '../lib/ai/runtime/answer-evidence-core';
import { buildMessageInterpretationInstruction, PLATFORM_MESSAGE_INTERPRETATION_SCHEMA_VERSION } from '../lib/ai/runtime/platform-message-interpretation';
import { PlatformReadHandleRegistry, type PlatformReadIdentity } from '../lib/ai/platform-read-handle-registry';
import { createProviderOutputBudget } from '@openzhiyu/ai/agent/runtime/provider-output-budget';
const [folderArgument, runArgument, id] = process.argv.slice(2);
const folder = path.resolve(folderArgument), outputDir = path.resolve(runArgument);
if (!outputDir.startsWith(folder + path.sep) || !/^REAL-(?:0[0-9]{2}|100)$/.test(id)) throw Error('Invalid run scope');
const inherited = new Set(Object.keys(process.env));
for (const filename of [path.resolve('../../.env'), '.env', '.env.local']) if (fs.existsSync(filename)) {
  for (const [key, value] of Object.entries(parse(fs.readFileSync(filename)))) if (!inherited.has(key)) process.env[key] = value;
}
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
const question = fs.readFileSync(path.join(folder, 'questions.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text)).find(question => question.id === id);
if (!question || question.requester.userId !== manifest.ownerId) throw Error('Question owner mismatch');
const executionTrack = manifest.executionTracks[id];
const started = Date.now();
const runtimeFiles = ['scripts/run-platform-capability-eval-v2-worker.mts', 'scripts/lib/platform-eval-v2-frozen-tools.mts',
  'lib/ai/native-pi-web-chat-tools.ts', 'lib/ai/runtime/pi-tool-adapter.ts', 'lib/ai/runtime/tool-executor.ts',
  'lib/ai/platform-record-reader.ts', 'lib/ai/memory-read-budget.ts', 'lib/ai/memory-access.ts',
  'lib/ai/loop-runtime-evidence-boundary.ts', 'lib/ai/loop-owner-facet-session.ts', 'lib/ai/loop-repair-read-coverage.ts',
  'lib/ai/loop-partial-host.ts', 'lib/ai/loop-partial-delivery.ts',
  'lib/ai/loop-partial-workflow-tools.ts',
  'lib/ai/jev-platform-prefetch.ts', 'lib/memory/retrieval/jev-recall-router.ts', 'lib/ai/native-pi-user-config.ts',
  'lib/ai/platform-source-discovery.ts', 'lib/ai/platform-record-semantics.ts', 'lib/ai/platform-statistics-semantics.ts', 'lib/ai/platform-answer-coverage.ts',
  'lib/ai/platform-statistics-proof.ts', 'lib/ai/platform-field-reader.ts', 'lib/ai/platform-read-handle-registry.ts', 'lib/ai/platform-published-record-facts.ts',
  'lib/ai/platform-field-pages.ts', 'lib/ai/runtime/platform-field-page-evidence.ts',
  'lib/ai/runtime/answer-evidence-core.ts', 'lib/ai/runtime/answer-evidence-session.ts', 'lib/ai/runtime/answer-evidence-selection.ts',
  'lib/ai/runtime/answer-evidence-loop-gate.ts', 'lib/ai/runtime/platform-answer-contract.ts', 'lib/ai/runtime/platform-answer-session.ts', 'lib/ai/runtime/platform-answer-gate.ts',
  'lib/ai/runtime/platform-answer-validator.ts', 'lib/ai/runtime/platform-answer-renderer.ts', 'lib/ai/runtime/platform-requested-state-counts.ts', 'lib/ai/runtime/platform-answer-continuation.ts',
  'lib/ai/runtime/platform-message-interpretation.ts',
  'lib/ai/runtime/platform-processing-job-boundaries.ts', 'lib/interactions/processing-job-policy.ts',
  '../../packages/ai/src/agent/types.ts', '../../packages/ai/src/agent/runtime/pi-harness-adapter.ts', '../../packages/ai/src/agent/runtime/pi-stream-diagnostics.ts',
  '../../packages/ai/src/agent/runtime/host-readonly-continuation.ts', '../../packages/ai/src/agent/runtime/provider-output-budget.ts'];
const sourceHashes = Object.fromEntries(runtimeFiles.map(filename => [filename, createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]));
const verifySourceHashes = () => {
  const changed = Object.entries(sourceHashes).filter(([filename, expected]) => !fs.existsSync(filename) || createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== expected).map(([filename]) => filename);
  if (changed.length) throw new EvalConfigurationLockError('evaluation_source_version_drift');
  return { verified: true, sourceFileCount: runtimeFiles.length };
};
const record: any = { id, question: question.question, asOf: question.asOf, executionTrack, startedAt: new Date().toISOString(),
  status: 'running', answer: null, events: [], toolCalls: [], traces: [], toolsEnabled: false,
  metadata: { engine: 'pi', goldInjected: false, labelsInjected: false, sourceAdapter: 'frozen-source-tools',
    maxOutputTokens: 2200, maximumToolCalls: 20, timeoutMs: 240000,
    recordSnapshotCapturedAt: manifest.recordSnapshotCapturedAt, repositoryCapturedAt: manifest.repositoryCapturedAt, sourceHashes,
    jevFlags: Object.fromEntries(['BRAIN_JEV_ROUTING', 'BRAIN_JEV_MODE', 'BRAIN_JEV_TARGETED_RETRY'].map(key => [key, process.env[key] ?? null])) } };
const save = () => fs.writeFileSync(path.join(outputDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
const redact = (value: unknown) => String(value).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
save();
let fixture: any;
let answerSession: HostAnswerEvidenceSession | undefined;
let partialHost: OwnerLoopPartialHost | undefined;
const memoryReadBudget = createMemoryReadBudget();
const readIdentity: PlatformReadIdentity = { ownerId: manifest.ownerId, requester: { kind: 'chat', id }, turnId: `platform-v2-${id}-${started}` };
const readRegistry = new PlatformReadHandleRegistry(readIdentity);
const outputBudget = createProviderOutputBudget({ perRequestTokens: 2200, totalReservedTokens: 21 * 2200 });
let continuationActive = false;
const evidenceSelection = executionTrack === 'sandbox_workflow' ? null : selectHostAnswerEvidenceContract(question.question, {
  loopMode: process.env.ANSWER_EVIDENCE_MODE, platformMode: process.env.PLATFORM_ANSWER_MODE,
});
const boundedContinuation = evidenceSelection?.kind === 'platform' && evidenceSelection.mode === 'enforce_supported' && process.env.PLATFORM_ANSWER_CONTINUATION === 'bounded';
const auditEvents: any[] = [];
const auditKeys = new Map<string, string>();
let auditSealed = false;
const isolatedAuditSink = async (event: any) => {
  const digest = answerEvidenceHash(event);
  if (auditKeys.has(event.eventKey)) {
    if (auditKeys.get(event.eventKey) !== digest) throw Error('Frozen answer audit key conflict');
    return;
  }
  if (auditSealed) throw Error('Frozen answer audit is sealed');
  auditKeys.set(event.eventKey, digest); auditEvents.push(event);
  if (['turn_completed', 'turn_failed', 'turn_aborted'].includes(event.eventType)) auditSealed = true;
  record.answerAuditEvents = auditEvents; save();
};
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
try {
  const providerLockPath = evalProviderLockPath(process.env.PLATFORM_EVAL_PROVIDER_LOCK_PATH, outputDir);
  const providerLock = providerLockPath ? readEvalProviderLock(providerLockPath, outputDir) : null;
  if (providerLock) {
    if (providerLock.ownerId !== manifest.ownerId || providerLock.folder !== folder) throw new EvalConfigurationLockError('provider_lock_scope_invalid');
    record.metadata.configurationLock = verifyEvalVersionLock(providerLock);
  }
  const { getUserLlmProviderConfig } = await import('../lib/ai/user-llm-api-settings');
  const { resolveNativePiUserConfig } = await import('../lib/ai/native-pi-user-config');
  const [openAI, anthropic] = providerLock ? [undefined, undefined] : await Promise.all(['openai_compatible', 'anthropic_compatible'].map(providerType => getUserLlmProviderConfig({ userId: manifest.ownerId, providerType: providerType as any })));
  const locked = providerLock ? await readLockedEvalProvider({ lock: providerLock, role: 'agent', readSetting: undefined }) : null;
  const config = locked ? { ...locked.config, protocol: locked.snapshot.providerType === 'openai_compatible' ? 'openai-completions' as const : 'anthropic-messages' as const } : resolveNativePiUserConfig({ openAI: openAI ?? undefined, anthropic: anthropic ?? undefined,
    env: { apiKey: process.env.PI_AGENT_API_KEY, baseUrl: process.env.PI_AGENT_BASE_URL, model: process.env.PI_AGENT_MODEL,
      protocol: process.env.PI_AGENT_PROTOCOL as any } });
  if (!config.apiKey || !config.model) throw Error('Configured Pi model unavailable');
  record.metadata.model = config.model;
  record.metadata.protocol = config.protocol;
  record.metadata.providerHost = config.baseUrl ? new URL(config.baseUrl).host : null;
  if (locked) record.metadata.providerSnapshot = locked.snapshot;
  const { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } = await import('@openzhiyu/ai/agent/runtime');
  const { buildPlatformRecallPromptInstruction } = await import('../lib/ai/platform-recall');
  const { prefetchPlatformWithJev } = await import('../lib/ai/jev-platform-prefetch');
  let tools: any[];
  let authorizeFrozenFieldPageFinal: ((binding:PlatformFieldPageBinding)=>Promise<boolean>)|undefined;
  let prompt = `${buildPlatformRecallPromptInstruction()}\n${question.question}`;
  const messageInterpretationInstruction = evidenceSelection?.kind === 'platform'
    ? buildMessageInterpretationInstruction(evidenceSelection.plan) : '';
  if (messageInterpretationInstruction) prompt += `\n\n${messageInterpretationInstruction}`;
  record.metadata.messageInterpretationInstructionVersion = messageInterpretationInstruction ? PLATFORM_MESSAGE_INTERPRETATION_SCHEMA_VERSION : null;
  record.metadata.messageInterpretationInstructionHash = messageInterpretationInstruction ? answerTextHash(messageInterpretationInstruction) : null;
  if (executionTrack === 'sandbox_workflow') {
    const workflows = await import('./lib/platform-eval-v2-workflows.mjs');
    fixture = await workflows.prepareWorkflow({ id, outputDir: path.join(outputDir, 'fixtures', id) });
    if (fixture.status === 'fixture_error') { record.status = 'fixture_error'; record.error = fixture.error ?? fixture.reason; record.workflow = fixture; }
    else {
      // Preserve every original fixture action; only registered owner readers gain a construction receipt.
      tools = wrapOwnerLoopWorkflowReaders(fixture.tools as AgentTool[], () => partialHost);
      prompt = `${question.question}\n\n${fixture.promptContext}`;
    }
  } else {
    const { createFrozenEvalTools, FROZEN_SOURCE_READER_VERSION, FROZEN_SOURCE_TOOL_ADAPTER } = await import('./lib/platform-eval-v2-frozen-tools.mts');
    tools = await createFrozenEvalTools({ folder, manifest, question, model: config.model, provider: 'pi',
      turnId: readIdentity.turnId, platformReadRegistry: readRegistry, platformReadIdentity: readIdentity,
      memoryReadBudget, onResultConstructed: receipt => answerSession?.observeToolConstruction(receipt),
      onFieldPageAuthorizer: authorize => { authorizeFrozenFieldPageFinal=authorize; },
      onTrace: (trace: any) => { record.traces.push(trace); save(); } });
    record.metadata.sourceAdapter = FROZEN_SOURCE_TOOL_ADAPTER;
    record.metadata.readerContractVersion = FROZEN_SOURCE_READER_VERSION;
  }
  if (record.status !== 'fixture_error') {
    record.toolsEnabled = true;
    record.metadata.allowedTools = tools!.map(tool => tool.name);
    record.metadata.sourceAdapter = executionTrack === 'sandbox_workflow' ? fixture.adapterId : record.metadata.sourceAdapter;
    const modelOptions = createPiRuntimeOptionsFromModelConfig({ ...config, model: config.model });
    // Harness 0.85.1 derives intended output from model.maxTokens; an unknown
    // streamOptions.maxTokens property does not constrain a provider request.
    const runtime = createPiAgentRuntime({ ...modelOptions, model: { ...modelOptions.model, maxTokens: 2200 }, adapter: 'harness', tools: tools!,
      streamOptions: { ...modelOptions.streamOptions, timeoutMs: 240000 },
      streamFn: (model, context, options) => {
        const cap = continuationActive ? model.maxTokens : Math.min(model.maxTokens, outputBudget.reserveMainForward());
        return modelOptions.streamFn({ ...model, maxTokens: cap }, context, { ...options, maxTokens: cap });
      } });
    record.metadata.effectiveOutputLimitSource = 'model.maxTokens';
    record.metadata.legacyNominalOptionIgnored = true;
    record.metadata.adapter = runtime.metadata;
    const actualRuntimeSnapshot = { schemaVersion: 'frozen-answer-runtime.v1', sourceHashes,
      model: config.model, protocol: config.protocol, adapter: runtime.metadata,
      toolSchemaHash: answerEvidenceHash(tools!.map(tool => ({ name: tool.name, parameters: tool.parameters }))),
      mode: evidenceSelection?.mode ?? 'off', ruleVersion: evidenceSelection?.ruleVersion ?? null,
      contractKind: evidenceSelection?.kind === 'platform' ? evidenceSelection.plan.kind : evidenceSelection?.kind ?? null,
      sourceAdapter: record.metadata.sourceAdapter, snapshotAt: manifest.recordSnapshotCapturedAt,
      messageInterpretationInstructionVersion: record.metadata.messageInterpretationInstructionVersion,
      messageInterpretationInstructionHash: record.metadata.messageInterpretationInstructionHash,
      budgets: { maximumToolCalls: 20, maxOutputTokens: 2200, totalOutputReservations: 21 * 2200, outputMeasurement: 'configured_upper_bound_reservations', timeoutMs: 240000 }, continuation: boundedContinuation ? 'bounded' : 'off' };
    const actualRuntimeHash = answerEvidenceHash(actualRuntimeSnapshot);
    record.metadata.answerEvidence = { mode: actualRuntimeSnapshot.mode, eligible: Boolean(evidenceSelection),
      contractKind: actualRuntimeSnapshot.contractKind, ruleVersion: actualRuntimeSnapshot.ruleVersion,
      actualRuntimeHash, gateLoaded: Boolean(evidenceSelection), auditSink: 'isolated_file_events', continuation: actualRuntimeSnapshot.continuation };
    if (evidenceSelection) {
      answerSession = createHostAnswerEvidenceSession(evidenceSelection, { turnId: `platform-v2-${id}-${started}`,
        ownerId: manifest.ownerId, question: question.question, runtimeHash: actualRuntimeHash,
        policyHash: answerEvidenceHash({ ownerId: manifest.ownerId, allowedTools: tools!.map(tool => tool.name), sourceAdapter: record.metadata.sourceAdapter }),
        snapshotAt: manifest.recordSnapshotCapturedAt, timePolicy: { mode: 'unconstrained' },
        resolveFieldPageReadHandle: handle=>readRegistry.resolve(handle,readIdentity),
        authorizeFieldPageFinal: binding=>authorizeFrozenFieldPageFinal?.(binding)??Promise.resolve(false),
        ...(boundedContinuation ? { readonlyContinuation: { enabled: true as const,
          resolveReadHandle: handle => readRegistry.resolve(handle, readIdentity), readBudgetSnapshot: memoryReadBudget.snapshot } } : {}),
        auditSink: isolatedAuditSink, authorizeFinal: async () => question.requester.userId === manifest.ownerId && tools!.some(tool => tool.name === 'platformRecall') });
      await isolatedAuditSink({ eventKey: 'runtime_loaded', eventType: 'runtime_loaded', payload: { ...actualRuntimeSnapshot, actualRuntimeHash } });
    }
    if (!answerSession && evidenceSelection === null && fixture?.status === 'ready'
      && fixture.trustedRuntimeContext?.ownerId === manifest.ownerId) {
      const context = fixture.trustedRuntimeContext;
      partialHost = createOwnerLoopPartialHost({ selectedEvidence: evidenceSelection, context,
        originalQuestion: question.question, turnId: readIdentity.turnId, runtimeHash: actualRuntimeHash,
        policyHash: answerEvidenceHash({ ownerId: manifest.ownerId, tools: tools!.map(tool => tool.name), adapter: context.adapter }),
        toolNames: tools!.map(tool => tool.name), auditSink: isolatedAuditSink,
        authorizeFinal: async () => !controller.signal.aborted && question.requester.userId === manifest.ownerId
          && fixture?.trustedRuntimeContext?.ownerId === manifest.ownerId
          && fixture?.trustedRuntimeContext?.loopId === context.loopId
          && tools!.some(tool => tool.name === context.toolName) });
      await partialHost?.core.append({ eventKey: 'runtime_loaded', eventType: 'runtime_loaded',
        payload: { ...actualRuntimeSnapshot, actualRuntimeHash, originalQuestionHash: answerTextHash(JSON.stringify(question.question)) } });
    }
    if (executionTrack !== 'sandbox_workflow') {
      const prefetch = prefetchPlatformWithJev({ question: question.question, prompt, tools: tools!, signal: controller.signal,
        onEvidenceEmbedded: answerSession ? binding => answerSession!.bindPromptEvidence(binding) : undefined });
      while (true) {
        const event = await prefetch.next(); if (event.done) { prompt = event.value; break; }
        await answerSession?.observeToolResult(event.value); record.events.push(event.value); save();
      }
    }
    record.metadata.promptHash = createHash('sha256').update(prompt).digest('hex');
    record.metadata.sourceVerifiedBeforeModel = verifySourceHashes();
    // Fixture setup and JEV prefetch may take time. Recheck immediately before
    // the first main-model turn; the session then uses this immutable config.
    if (providerLock) {
      const current = await readLockedEvalProvider({ lock: providerLock, role: 'agent', readSetting: undefined });
      record.metadata.providerVerifiedBeforeModelAt = new Date().toISOString();
      record.metadata.providerFingerprintBeforeModel = current.snapshot.fingerprint;
      verifyEvalVersionLock(providerLock);
    }
    let count = 0;
    const rawEvents: AgentMessage[] = [];
    const rawStream = (async function* () {
      for await (const event of runtime.run({ operation: 'run', prompt, options: { sessionId: `platform-v2-${id}-${started}`, abortController: controller,
        onToolContextCommitted: answerSession || partialHost
          ? receipt => answerSession ? answerSession.observeContextCommitted(receipt) : partialHost!.onToolContextCommitted(receipt) : undefined,
        onPromptContextCommitted: answerSession ? receipt => answerSession!.observePromptContextCommitted(receipt) : undefined,
        ...(boundedContinuation ? { hostReadonlyContinuation: {
          beforeClose: () => (answerSession as PlatformAnswerSession).beforeClose(),
          reserveOutputTokens: outputBudget.reserveContinuationEpisode,
          onEpisodeStarted: async episode => {
            await (answerSession as PlatformAnswerSession).observeContinuationStarted(episode);
            await isolatedAuditSink({ eventKey: 'continuation_output_reserved', eventType: 'continuation_output_reserved', payload: { outputBudget: outputBudget.snapshot() } });
            continuationActive = true;
          },
        } } : {}),
        onBeforeToolUse: async () => { if (++count > 20) throw Error('Per-case tool-call safety budget exceeded'); } } })) {
        rawEvents.push(event);
        if (event.type === 'runtime_terminal' && answerSession) await isolatedAuditSink({ eventKey: 'retrieval_budget_closed', eventType: 'retrieval_budget_closed',
          payload: { budget: memoryReadBudget.snapshot(), outputBudget: outputBudget.snapshot(), providerStreamDiagnostics: event.providerStreamDiagnostics ?? null } });
        yield event;
      }
    })();
    const displayStream = answerSession && evidenceSelection
      ? evidenceSelection.kind === 'platform' ? guardPlatformAnswer(rawStream, answerSession as PlatformAnswerSession)
        : guardExactLoopAnswer(rawStream, answerSession as AnswerEvidenceSession)
      : fixture?.trustedRuntimeContext ? guardOwnerLoopFacetAnswer(rawStream, question.question, fixture.trustedRuntimeContext, partialHost?.binding) : rawStream;
    for await (const event of displayStream) {
      record.events.push(event); save();
    }
    record.rawAnswer = rawEvents.filter(event => event.type === 'result').at(-1)?.content
      ?? rawEvents.filter(event => event.type === 'text').map(event => event.content ?? '').join('');
    record.rawRuntimeTerminal = rawEvents.find(event => event.type === 'runtime_terminal')?.runtimeTerminal ?? null;
    record.providerStreamDiagnostics = rawEvents.find(event => event.type === 'runtime_terminal')?.providerStreamDiagnostics ?? null;
    record.metadata.memoryReadBudget = memoryReadBudget.snapshot();
    record.metadata.outputReservations = outputBudget.snapshot();
    record.toolCalls = record.events.filter((event: any) => event.type === 'tool_use');
    record.results = record.events.filter((event: any) => event.type === 'result');
    record.answer = record.results.at(-1)?.content ?? record.events.filter((event: any) => event.type === 'text').map((event: any) => event.content ?? '').join('');
    const errors = record.events.filter((event: any) => event.type === 'error');
    record.toolErrors = record.events.filter((event: any) => event.type === 'tool_result' && event.isError);
    record.status = controller.signal.aborted ? 'timeout' : errors.length ? 'agent_error' : record.answer && record.events.some((event: any) => event.type === 'done') ? 'completed' : 'incomplete';
    if (errors.length) record.error = errors.map((event: any) => redact(event.message)).join('\n');
    record.metadata.sourceVerifiedAfterModel = verifySourceHashes();
    if (providerLock) {
      verifyEvalVersionLock(providerLock);
      const current = await readLockedEvalProvider({ lock: providerLock, role: 'agent', readSetting: undefined });
      record.metadata.providerFingerprintAfterModel = current.snapshot.fingerprint;
      record.metadata.providerVerifiedAfterModelAt = new Date().toISOString();
    }
    if (fixture) record.workflow = await fixture.verify({ answer: record.answer, events: record.events, toolCalls: record.toolCalls });
  }
} catch (error) {
  record.status = executionTrack === 'sandbox_workflow' && !record.toolsEnabled ? 'fixture_error' : controller.signal.aborted ? 'timeout' : 'agent_error';
  record.error = redact(error instanceof Error ? error.message : error);
  if (error instanceof EvalConfigurationLockError) { record.errorCode = error.code; record.failureStage = 'configuration_lock'; }
} finally {
  clearTimeout(timer);
  readRegistry.close();
  if (partialHost && !partialHost.core.snapshot().closing)
    await partialHost.closeUnstarted('workflow_did_not_reach_answer_delivery_terminal');
  if (fixture?.cleanup) {
    try { const cleanup = await fixture.cleanup(); record.workflow = { ...record.workflow, cleanup }; }
    catch (error) { record.workflow = { ...record.workflow, cleanup: { status: 'failed', error: redact(error) } }; }
  }
  record.finishedAt = new Date().toISOString(); record.ms = Date.now() - started; save();
  try { const { closeDb } = await import('../lib/db/adapters'); await closeDb(); } catch { /* result already captures the application run */ }
}
process.exit(record.status === 'completed' ? 0 : 1);
