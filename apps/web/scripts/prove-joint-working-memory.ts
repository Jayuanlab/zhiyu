import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// A bounded protocol exercise. This is deliberately separate from quality/holdout evaluation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!process.argv.includes('--run-provider')) throw Error('Pass --run-provider to perform this bounded real model protocol exercise.');
dotenv.config({ path: path.join(root, 'apps/web/.env.local'), quiet: true });
dotenv.config({ path: path.join(root, 'apps/web/.env'), quiet: true });
const protocolArg = process.argv.find(value => value.startsWith('--protocol='))?.slice(11);
if (protocolArg) process.env.PI_AGENT_PROTOCOL = protocolArg;
const [{ createPiRuntimeOptionsFromModelConfig }, { loadJointMemoryProbeProvider }, { createPiMemoryScenarioRunner, hashPiMemoryScenarioToolContract },
  { DEFAULT_WORKING_MEMORY_STRATEGY, workingMemoryStrategyIdentity }, { sha256Canonical }, { hashFrozenMemorySource }] = await Promise.all([
  import('../../../packages/ai/src/agent/runtime/index'), import('./lib/joint-memory-provider-config'),
  import('../lib/harness-evolution/memory-pi-scenario-runner'), import('../lib/workshops/working-memory-strategy'),
  import('../lib/harness-evolution/canonical-json'), import('../lib/harness-evolution/memory-scenario-executor'),
]);
const provider = await loadJointMemoryProbeProvider(process.env.MEMORY_PROBE_ORIGIN ?? 'http://127.0.0.1:3515');
const options = createPiRuntimeOptionsFromModelConfig(provider);
const folder = path.join(root, '.tmp', 'memory-joint-20261013', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(folder, { recursive: true });
const source = { id: 'control-principles',
  content: '工程原则：先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。记忆系统是状态估计器，不是消息堆积。工作记忆中的理解仍需核验，进入长期记忆必须保留来源并经过主人审核。',
  contentHash: '', observedAt: new Date().toISOString(), provider: 'frozen-protocol-exercise', warning: null };
source.contentHash = hashFrozenMemorySource(source.content);
const sources = [source];
const policy = structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY);
const identity = workingMemoryStrategyIdentity(policy);
const runtime = { model: options.model.id, provider: options.model.provider,
  sourceSnapshotHash: sha256Canonical(sources.map(({ content: _content, ...metadata }) => metadata)),
  toolContractHash: hashPiMemoryScenarioToolContract(), allowedTools: ['readFrozenSource', 'workingMemory'],
  deniedTools: ['external_send', 'external_write', 'real_funds', 'payment', 'delete', 'permission_change'],
  budget: { maxModelCalls: 10, maxTotalTokens: 100000, maxDurationMs: 180000 } };
const files = ['packages/ai/src/agent/runtime/host-working-memory.ts', 'packages/ai/src/agent/runtime/host-working-memory-sources.ts',
  'packages/ai/src/agent/runtime/pi-harness-adapter.ts', 'apps/web/lib/harness-evolution/memory-pi-scenario-runner.ts',
  'apps/web/lib/workshops/working-memory-strategy.ts', 'apps/web/scripts/prove-joint-working-memory.ts'];
const codeHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ kind: 'real-provider-memory-protocol-exercise.v1',
  independentQualityHoldout: false, benefitClaimAllowed: false, runtime, policyIdentity: identity, sources,
  configurationSource: provider.configurationSource, protocol: provider.protocol, protocolArgument: protocolArg ?? null,
  usageStreamingRequested: provider.protocol === 'openai-completions',
  runtimeHash: sha256Canonical(runtime), codeHashes, createdAt: new Date().toISOString() }, null, 2), 'utf8');
const events: import('../lib/harness-evolution/memory-pi-scenario-runner').PiMemoryScenarioEvent[] = [];
const runner = createPiMemoryScenarioRunner({ model: options.model,
  streamFn: (model, context, streamOptions) => options.streamFn(model, context, { ...streamOptions,
    ...(provider.protocol === 'openai-completions' ? { compat: { supportsUsageInStreaming: true } } : {}) }),
  executionKind: 'provider',
  persistEvent: async event => { await fs.appendFile(path.join(folder, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8'); events.push(event); } });
const scenario = { scenarioKey: 'explicit-memory-protocol', name: 'Explicit bounded LOG PLAN projection restore exercise',
  mode: 'simulation' as const, tags: ['protocol-only'], riskTier: 'normal' as const, fixtureRef: 'frozen-protocol-exercise', preconditions: {},
  taskIntent: `这是一轮明确要求操作的记忆协议检查，不是自然行为或收益测试。按顺序完成，不跳步、不重读来源：
1. 用 readFrozenSource 读取 control-principles。
2. workingMemory operation=read 获取真实 evidenceCatalog、projectionCandidates、version。
3. operation=update，phase=LOG，commandId=probe-log，expectedVersion=刚读到的version。完整状态 facts 写一条 key=principles 的有来源笔记（概括工程原则）；hypotheses=[]，openQuestions=[]，nextAction 说明恢复核对。evidenceIds 使用目录的真实 toolCallId；只选择 projectionCandidates 中的该 toolCallId 放入 pruneToolCallIds。
4. workingMemory operation=read，query=principles，核对返回的笔记与最新version。
5. operation=update，phase=PLAN，commandId=probe-plan，expectedVersion=最新version，保留同 key 的 facts 并将 nextAction 改为恢复该来源；pruneToolCallIds=[]。
6. operation=restore，commandId=probe-restore，expectedVersion=最新version。该动作恢复本轮全部已投影的原始结果，禁止重跑读取工具。
7. 输出 JSON {"sourceId":"control-principles","principles":"原文的四组工程原则","memoryStatus":"unverified"}。不要声称节省token、质量提升或长期记忆已经生效。`,
  expectedArtifacts: ['LOG', 'PLAN', 'projection', 'restore'], hardInvariants: [], forbiddenActions: runtime.deniedTools,
  metrics: [], repetitions: 1, timeoutMs: 180000, status: 'active' as const };
try {
  const trace = await runner.execute({ scenario, repetition: 0, runtime, runtimeHash: sha256Canonical(runtime),
    policy: policy as unknown as Record<string, unknown>, policyHash: identity.hash, sources, allowExternalActions: false });
  const log = events.find(event => event.type === 'working_memory_updated' && event.metadata.phase === 'LOG');
  const plan = events.find(event => event.type === 'working_memory_updated' && event.metadata.phase === 'PLAN');
  const projection = events.find(event => event.type === 'working_memory_projected' && Array.isArray(event.metadata.pruneToolCallIds)
    && event.metadata.pruneToolCallIds.length > 0 && event.metadata.projectionKind === 'result_body_placeholder'
    && Array.isArray(event.metadata.evidenceCatalog) && event.metadata.evidenceCatalog.some(entry =>
      !!entry && typeof entry === 'object' && (entry as { projected?: boolean }).projected === true));
  const restore = events.find(event => event.type === 'working_memory_restored');
  const restoredProjection = restore && events.find(event => event.type === 'working_memory_projected'
    && event.metadata.version === restore.metadata.version && Number(event.metadata.projectedChars) === Number(event.metadata.originalChars));
  const expected = ['先观测，再建模', '先闭环，再自动', '先边界，再行动', '先稳定，再智能'];
  const checks = { runtimeCompleted: trace.status === 'success', actualRequests: trace.providerRequests.length > 0,
    logSaved: !!log, planSaved: !!plan, bodyProjected: !!projection, restored: !!restore, restoredOriginalPrepared: !!restoredProjection,
    sourceReadExactlyOnce: events.filter(event => event.type === 'source_read').length === 1,
    literalPrinciplesPresent: expected.every(value => trace.output.includes(value)),
    frozenPolicyMatches: events.every(event => (event.metadata.policyIdentity as { hash?: string })?.hash === identity.hash) };
  const result = { kind: 'protocol-exercise-result.v1', passed: Object.values(checks).every(Boolean), checks,
    actualRequestCount: trace.providerRequests.length, usage: trace.usage, elapsedMs: trace.durationMs,
    qualityGainProven: false, tokenGainProven: false, trainingPerformed: false, trace };
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  const drift = [];
  for (const file of files) if (createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') !== codeHashes[file]) drift.push(file);
  await fs.writeFile(path.join(folder, 'seal.json'), JSON.stringify({ codeDrift: drift, valid: drift.length === 0 }), 'utf8');
  console.log(JSON.stringify({ folder, passed: result.passed, checks, model: runtime.model,
    actualRequestCount: result.actualRequestCount, usage: result.usage, elapsedMs: result.elapsedMs, codeDrift: drift }));
  process.exit(result.passed && drift.length === 0 ? 0 : 1);
} catch (error) {
  await fs.writeFile(path.join(folder, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(), benefitClaimAllowed: false }), 'utf8');
  console.log(JSON.stringify({ folder, passed: false, failure: 'protocol_exercise_failed' }));
  process.exit(1);
}
