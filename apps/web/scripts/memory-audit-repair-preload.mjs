/** Opt-in production audit. Only a matching server-owned execution lease is observed/budgeted. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repository, readJson, writeOnce, digest, same, assertAnchor, anchorPath, assertSources, assertBuild, assertCumulativeBudget, verifyPreserved, BUDGET, ROUNDS } from './prove-memory-continuity-audit-repair.mjs';

export function modelPayload(value) {
  return !!value && typeof value.model === 'string' && (Array.isArray(value.messages) || Array.isArray(value.input) || typeof value.input === 'string');
}
export function trustedTarget(plan, lease, intent) {
  return !!lease && lease.userId === plan.identity.userId && lease.workshopId === plan.identity.workshopId
    && ROUNDS.includes(intent?.round) && intent.planHash === digest(plan) && intent.expectedRunId === lease.runId
    && typeof lease.workerId === 'string' && lease.workerId.length > 0 && same(intent.budget, BUDGET)
    && Number.isFinite(Date.parse(intent.createdAt)) && Date.parse(intent.deadlineAt) - Date.parse(intent.createdAt) === BUDGET.maxSeconds * 1000;
}
export function providerKind(payload) {
  if (payload.tools?.some(tool => (tool.function?.name ?? tool.name) === 'workingMemory')) return 'working-memory-agent';
  const text = JSON.stringify([payload.system, payload.messages ?? payload.input]);
  if (text.includes('recall planner for a unified memory platform')) return 'recall-planner';
  return 'auxiliary-model';
}
export function safeResponseSummary(body) {
  return { finishReasons: (body.choices ?? []).map(choice => choice.finish_reason ?? null), stopReason: body.stop_reason ?? null,
    usage: body.usage ?? null, providerError: !!body.error, validJsonResponse: true };
}
export function canonicalPreparedTime(value) {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
  }
  try {
    const time = Date.prototype.getTime.call(value);
    return Number.isFinite(time) ? Date.prototype.toISOString.call(value) : null;
  } catch { return null; }
}
export function preparedReceipt(event) {
  if (!event) return null;
  const createdAt = canonicalPreparedTime(event.createdAt);
  if (createdAt === null) throw Error('Persisted preparation timestamp is invalid');
  return { eventId: event.id, seq: event.seq, createdAt, version: event.metadata.version,
    policyIdentity: event.metadata.policyIdentity, loopRunId: event.loopRunId };
}
export function exactTransportPreparation(event, prepared, lease, bodyHash) {
  const m=event?.metadata,p=m?.logicalPrepared;
  return !!prepared && !!p && event?.type==='provider_transport_attempt' && m?.schemaVersion==='host-provider-transport.v1' && m.receiptAuthority==='runtime'
    && m.phase==='prepared' && m.currentRunId===lease.runId && event.runId===lease.runId && event.loopRunId===lease.runId && event.workshopId===lease.workshopId
    && typeof event.loopId==='string' && same(m.scope,{kind:'loop',loopId:event.loopId}) && (!lease.loopId||event.loopId===lease.loopId)
    && Number.isSafeInteger(event.seq) && Number.isSafeInteger(m.logicalInvocation) && m.logicalInvocation>0
    && Number.isSafeInteger(m.transportOrdinal) && m.transportOrdinal>0 && [1,2].includes(m.attempt) && m.bodyHash===bodyHash
    && p.eventId===prepared.eventId && p.seq===prepared.seq && p.createdAt===prepared.createdAt && p.version===prepared.version && same(p.policyIdentity,prepared.policyIdentity)
    && m.actorId===lease.userId && m.execution?.runId===lease.runId && m.execution.workerId===lease.workerId && Number.isSafeInteger(lease.token) && lease.token>0 && m.execution.token===lease.token
    && (m.attempt===1 ? m.sameBody===null && m.sameHeaders===null : m.sameBody===true && m.sameHeaders===true)
    && event.seq>prepared.seq && Number.isFinite(Date.parse(m.deadlineAt));
}
export function createAuditedFetch({ originalFetch, plan, leaseReader, intentReader, readPrepared, readTransport, recordRequest, recordResponse, countRequests, onTarget = () => {},
  assertFrozen = () => {}, assertAggregate = () => {}, boot, network, now = () => Date.now() }) {
  const reserved = new Map();
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'POST') return originalFetch(input, init);
    const lease = await leaseReader();
    // Ordinary work and HTTP processes are never modified by this audit.
    if (!lease || lease.userId !== plan.identity.userId || lease.workshopId !== plan.identity.workshopId) return originalFetch(input, init);
    const intent = intentReader(lease.runId);
    if (!intent) return originalFetch(input, init);
    if (!trustedTarget(plan, lease, intent)) throw Error('Planned production run authority or fixed deadline is inconsistent');
    let payload, bodyBytes;
    if (method.toUpperCase() === 'POST') {
      try {
        // RequestInit.body overrides Request.body. Audit the exact composed bytes
        // that fetch will send, including the recovery wrapper's Uint8Array body.
        bodyBytes=new Uint8Array(await new Request(input,init).clone().arrayBuffer());
        if(bodyBytes.length)payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bodyBytes));
      }
      catch { /* Non-JSON tools pass through unchanged. */ }
    }
    if (!modelPayload(payload)) return originalFetch(input, init);
    assertFrozen();
    assertAggregate();
    onTarget(lease, intent);
    await network.prepare?.();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const count = Math.max(countRequests(intent.round), reserved.get(intent.round) ?? 0), remaining = Date.parse(intent.deadlineAt) - now();
    if (count >= BUDGET.maxRequests || remaining <= 0) throw Error('Production acceptance budget exhausted before transmission');
    const kind = providerKind(payload), endpointHash = digest(url.origin + url.pathname);
    if (kind === 'working-memory-agent' && (payload.model !== plan.provider.actualModel || endpointHash !== plan.provider.actualEndpointHash)) throw Error('Frozen actual main provider drift rejected before transmission');
    const index = count + 1;
    reserved.set(intent.round, index);
    const prepared = kind === 'working-memory-agent' ? await readPrepared(lease) : null;
    if (kind === 'working-memory-agent' && (!prepared || prepared.loopRunId !== lease.runId)) throw Error('Exact own-run persisted preparation missing');
    const wireBodyHash=digest(Buffer.from(bodyBytes));
    const transport=kind==='working-memory-agent'?await readTransport?.(lease):null;
    if(kind==='working-memory-agent'&&!exactTransportPreparation(transport,prepared,{...lease,loopId:plan.identity.loopId},wireBodyHash))throw Error('Actual physical transport preparation is absent or inconsistent');
    if (Date.parse(intent.deadlineAt) <= now()) throw Error('Production acceptance deadline exhausted before transmission');
    const request = { schemaVersion: 'memory-production-provider-request.v1', index, round: intent.round, kind,
      model: payload.model, protocol: /\/messages$/.test(url.pathname) ? 'anthropic-messages' : 'openai-completions', endpointHash, payloadHash: digest(payload), payload,
      dispatchedAt: new Date(now()).toISOString(), hostPrepared: prepared, wireBodyHash,
      transportPrepared:transport?{eventId:transport.id,seq:transport.seq,createdAt:transport.createdAt,
        logicalInvocation:transport.metadata.logicalInvocation,attempt:transport.metadata.attempt,transportOrdinal:transport.metadata.transportOrdinal,
        bodyHash:transport.metadata.bodyHash,deadlineAt:transport.metadata.deadlineAt}:null,
      authority: { kind: 'server_owned_async_local_storage', module: 'apps/web/lib/work-runtime/execution-context.ts',
        userId: lease.userId, workshopId: lease.workshopId, runId: lease.runId, workerId: lease.workerId },
      bootId: boot.bootId, pid: boot.pid, planHash: digest(plan), network: network.metadata,
      credentialValuesOrHashesRecorded: false, requestHeadersRecorded: false };
    recordRequest(intent.round, index, request);
    const responseRecord = { responseStatus: null, error: null, receivedAt: null, responseSummary: null };
    try {
      const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const deadline = AbortSignal.timeout(Math.max(1, Date.parse(intent.deadlineAt) - now()));
      const signal = existingSignal ? AbortSignal.any([existingSignal, deadline]) : deadline;
      const response = await originalFetch(input, network.apply(url, { ...init, signal }));
      responseRecord.responseStatus = response.status; responseRecord.receivedAt = new Date(now()).toISOString();
      // Auxiliary requests are non-stream JSON. Record only safe terminal/usage fields, never headers or output text.
      if (kind !== 'working-memory-agent' && payload.stream !== true) {
        try { responseRecord.responseSummary = safeResponseSummary(await response.clone().json()); }
        catch { responseRecord.responseSummary = { validJsonResponse: false }; }
      }
      return response;
    } catch (error) { responseRecord.error = /^[A-Za-z_][A-Za-z_0-9]*$/.test(error?.name) ? error.name : 'unknown_error'; throw error; }
    finally { recordResponse(intent.round, index, responseRecord); }
  };
}
/** Read-only full persisted trace, authorized by the originally observed server execution lease. */
export async function observePersistedRun({ plan, lease, intent, boot, readOwnedRun, record, sleep = ms => new Promise(done => { const timer = setTimeout(done, ms); timer.unref?.(); }), now = () => Date.now() }) {
  if (!trustedTarget(plan, lease, intent)) throw Error('Untrusted trace observation scope');
  while (now() <= Date.parse(intent.deadlineAt) + 15_000) {
    const run = await readOwnedRun(lease, plan.identity.loopId);
    if (run && !['queued', 'running'].includes(run.status)) {
      if (run.id !== lease.runId || run.loopId !== plan.identity.loopId) throw Error('Persisted trace identity mismatch');
      const verification = run.verificationResult;
      record({ schemaVersion: 'memory-production-worker-run.v1', round: intent.round, runId: run.id, loopId: run.loopId, status: run.status,
        outputSummary: run.outputSummary, error: run.error, startedAt: run.startedAt, completedAt: run.completedAt,
        verificationResult: verification, verificationHash: digest(verification), capturedAt: new Date(now()).toISOString(),
        authority: { kind: 'read_only_existing_owner_services_from_observed_server_lease', userId: lease.userId, workshopId: lease.workshopId, runId: lease.runId, workerId: lease.workerId },
        bootId: boot.bootId, pid: boot.pid, planHash: digest(plan), sourceHashes: plan.sourceHashes });
      return;
    }
    await sleep(500);
  }
  throw Error('Persisted trace observation deadline reached');
}

async function activate() {
  const planFile = process.env.ZHIYU_MEMORY_PRODUCTION_PLAN;
  if (!planFile) return;
  const plan = readJson(resolve(planFile)), directory = plan.outputDirectory;
  assertAnchor(readJson(anchorPath(repository)), plan, directory); assertSources(repository, plan.sourceHashes); assertBuild(repository, plan.build);
  assertCumulativeBudget(plan,directory);
  verifyPreserved(plan);
  const args = process.argv.slice(1).map(value => value.replaceAll('\\', '/'));
  const role = args.some(value => value.endsWith('/scripts/start-runtime-worker.mjs') || value === 'scripts/start-runtime-worker.mjs') ? 'worker'
    : args.some(value => /next\/dist\/bin\/next$/.test(value)) && args.includes('start') ? 'web'
      : args.some(value => value.endsWith('/scripts/start-managed-application.mjs') || value === './scripts/start-managed-application.mjs') ? 'manager' : 'other';
  if (role === 'other') return;
  const selectedBuildDirectory = resolve(repository, 'apps/web', process.env.ZHIYU_WINDOWS_DISTRIBUTION === '1' ? '.tmp/next-windows-distribution'
    : /^\d{2}$/.test(process.env.ZHIYU_REVIEW_BUILD ?? '') ? `.tmp/next-review-${process.env.ZHIYU_REVIEW_BUILD}` : '.next');
  if (selectedBuildDirectory !== plan.build.directory) throw Error('Actual process distDir differs from explicit production build plan');
  const boot = { schemaVersion: 'memory-production-boot.v1', bootId: randomUUID(), role, pid: process.pid, ppid: process.ppid,
    startedAt: new Date().toISOString(), nodeEnv: process.env.NODE_ENV ?? null, planHash: digest(plan),
    build: plan.build, sourceHashes: plan.sourceHashes, argv: args,
    sourceObservation: 'Boot filesystem hashes; actual execution module identity is separately bound by server-owned ALS in provider receipts.',
    workerPolicy: { modules: (process.env.ZHIYU_RUNTIME_MODULES ?? '').split(','), workshopIds: (process.env.ZHIYU_RUNTIME_WORKSHOP_IDS ?? '').split(','), maxToolCalls: process.env.LOOP_MAX_TOOL_CALLS ?? null },
    reviewBuild: process.env.ZHIYU_REVIEW_BUILD ?? null,
    selectedBuildDirectory,
    credentialValuesOrHashesRecorded: false };
  writeOnce(resolve(directory, 'spool', `boot-${role}-${boot.bootId}.json`), boot);
  if (role !== 'worker') return;
  if (boot.nodeEnv !== 'production' || !same(boot.workerPolicy, plan.workerPolicy)) throw Error('Acceptance worker loaded unexpected production scope/tool budget');
  // Do not eagerly import business modules before the project's official TSX preload has initialized.
  let contextModule, eventModule, network, networkReady;
  const observing = new Set();
  const originalFetch = globalThis.fetch;
  const lazyNetwork = { metadata: null, apply(url, init) { return network.apply(url, init); },
    async prepare() {
      networkReady ??= (async () => {
        const { prepareMemoryAcceptanceNetwork } = await import('./lib/memory-acceptance-network.ts');
        network = await prepareMemoryAcceptanceNetwork(plan.network.mode, { ...(plan.network.preferredAddress ? { preferredAddress: plan.network.preferredAddress } : {}) });
        lazyNetwork.metadata = network.metadata;
      })();
      await networkReady;
    } };
  globalThis.fetch = createAuditedFetch({ originalFetch, plan, boot, network: lazyNetwork,
    leaseReader: async () => {
      contextModule ??= await import(pathToFileURL(resolve(repository, 'apps/web/lib/work-runtime/execution-context.ts')).href);
      return contextModule.resolveExecutionLease();
    },
    intentReader: runId => ROUNDS.map(round => resolve(directory, `round-${round}-intent.json`)).filter(existsSync).map(readJson).find(intent => intent.expectedRunId === runId),
    countRequests: round => readdirSync(resolve(directory, 'spool')).filter(name => name.startsWith(`${round}-`) && name.endsWith('.request.json')).length,
    assertFrozen: () => { assertSources(repository, plan.sourceHashes); assertBuild(repository, plan.build); verifyPreserved(plan); },
    assertAggregate: () => assertCumulativeBudget(plan,directory),
    onTarget: (lease, intent) => {
      if (observing.has(lease.runId)) return; observing.add(lease.runId);
      void observePersistedRun({ plan, lease, intent, boot,
        readOwnedRun: async (observed, loopId) => {
          const service = await import(pathToFileURL(resolve(repository, 'apps/web/lib/loops/service.ts')).href);
          const owned = await service.getLoopInWorkshop({ userId: observed.userId, workshopId: observed.workshopId, loopId });
          if (!owned) throw Error('Observed worker trace owner no longer owns Loop');
          const runs = await service.listLoopRuns(loopId, { limit: 100 });
          return runs.find(run => run.id === observed.runId) ?? null;
        }, record: value => writeOnce(resolve(directory, 'spool', `${intent.round}-worker-run.json`), value),
      }).catch(error => writeOnce(resolve(directory, 'spool', `${intent.round}-worker-run-error.json`), { schemaVersion: 'memory-production-worker-run-error.v1', round: intent.round, planHash: digest(plan), errorClass: error.name ?? 'Error', readOnly: true }));
    },
    readPrepared: async lease => {
      eventModule ??= await import(pathToFileURL(resolve(repository, 'apps/web/lib/workshops/service.ts')).href);
      const events = await eventModule.listWorkshopEvents(lease.workshopId, { runId: lease.runId, loopRunId: lease.runId, types: ['working_memory_projected'], limit: 100, order: 'asc' });
      if (events.length >= 100) throw Error('Own-run prepared audit read exceeded bounded window');
      const event = events.filter(item => item.workshopId === lease.workshopId && item.runId === lease.runId && item.loopId === plan.identity.loopId && item.loopRunId === lease.runId
        && item.metadata?.receiptAuthority === 'runtime' && item.metadata.status === 'provider_request_prepared').at(-1);
      return preparedReceipt(event);
    },
    readTransport: async lease => {
      eventModule ??= await import(pathToFileURL(resolve(repository, 'apps/web/lib/workshops/service.ts')).href);
      const events=await eventModule.listWorkshopEvents(lease.workshopId,{runId:lease.runId,loopRunId:lease.runId,types:['provider_transport_attempt'],limit:500,order:'asc'});
      if(events.length>=500)throw Error('Own-run physical audit read exceeded bounded window');
      return events.filter(event=>event.workshopId===lease.workshopId&&event.runId===lease.runId&&event.loopRunId===lease.runId&&event.loopId===plan.identity.loopId&&event.metadata?.receiptAuthority==='runtime'&&event.metadata.phase==='prepared').at(-1)??null;
    },
    recordRequest: (round, index, value) => writeOnce(resolve(directory, 'spool', `${round}-${String(index).padStart(2, '0')}.request.json`), value),
    recordResponse: (round, index, value) => writeOnce(resolve(directory, 'spool', `${round}-${String(index).padStart(2, '0')}.response.json`), value),
  });
}
if (process.env.ZHIYU_MEMORY_PRODUCTION_PLAN) await activate();
