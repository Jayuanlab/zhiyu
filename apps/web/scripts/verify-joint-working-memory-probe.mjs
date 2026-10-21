import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const folder = path.resolve(process.argv[2] ?? '');
const allowed = path.join(root, '.tmp', 'memory-joint-20261013') + path.sep;
if (!folder.startsWith(allowed)) throw Error('Pass a saved protocol probe folder within this workspace.');
const [manifest, result, seal, eventsText] = await Promise.all(['manifest.json', 'result.json', 'seal.json', 'events.jsonl']
  .map(async file => { const text = await fs.readFile(path.join(folder, file), 'utf8'); return file.endsWith('.jsonl') ? text : JSON.parse(text); }));
const events = eventsText.trim().split('\n').map(JSON.parse);
const requests = events.filter(event => event.type === 'provider_request_prepared');
const usages = events.filter(event => event.type === 'working_memory_usage');
const log = events.find(event => event.type === 'working_memory_updated' && event.metadata.phase === 'LOG');
const plan = events.find(event => event.type === 'working_memory_updated' && event.metadata.phase === 'PLAN');
const projected = events.find(event => event.type === 'working_memory_projected' && event.metadata.pruneToolCallIds?.length
  && event.metadata.projectionKind === 'result_body_placeholder' && event.metadata.evidenceCatalog?.some(entry => entry.projected === true));
const restored = events.find(event => event.type === 'working_memory_restored');
const restoredPrepared = restored && events.find(event => event.type === 'working_memory_projected' && event.metadata.version === restored.metadata.version
  && event.metadata.pruneToolCallIds?.length === 0 && event.metadata.originalChars === event.metadata.projectedChars);
const checks = {
  runtimeCompleted: result.trace.status === 'success',
  executionSealValid: seal.valid === true && seal.codeDrift.length === 0,
  actualProviderPayloads: requests.length === result.trace.providerRequests.length && requests.length > 0
    && requests.every(event => event.metadata.payloadSource === 'sdk_provider_payload' && /^[a-f0-9]{64}$/.test(event.metadata.payloadHash)),
  fullActualUsage: usages.length === requests.length && usages.every((event, index) => event.metadata.invocation === index + 1 && event.metadata.usageStatus === 'reported'),
  logSaved: !!log, planSaved: !!plan, bodyProjected: !!projected, restoredOriginalPrepared: !!restoredPrepared,
  sourceReadExactlyOnce: events.filter(event => event.type === 'source_read').length === 1,
  frozenPolicyMatches: events.every(event => event.metadata.receiptAuthority === 'runtime' && event.metadata.policyIdentity?.hash === manifest.policyIdentity.hash),
  actionsWithinFrozenBoundary: result.trace.actions.every(action => manifest.runtime.allowedTools.includes(action) && !manifest.runtime.deniedTools.includes(action)),
  literalPrinciplesPresent: ['先观测，再建模', '先闭环，再自动', '先边界，再行动', '先稳定，再智能'].every(value => result.trace.output.includes(value)),
};
const report = { kind: 'independent-protocol-receipt-review.v1',
  mechanismPassed: Object.values(checks).every(Boolean), checks,
  initialExerciseResultRetained: result.passed,
  initialPredicateIssue: 'The initial exercise conflated body projection with fewer characters. Receipt review checks the actual projected catalog independently of cost.',
  firstProjectedRequest: projected ? { version: projected.metadata.version, originalChars: projected.metadata.originalChars,
    projectedChars: projected.metadata.projectedChars, delta: projected.metadata.projectedChars - projected.metadata.originalChars } : null,
  actualRequestCount: requests.length, usage: result.usage,
  independentQualityHoldout: false, qualityGainProven: false, tokenGainProven: false, trainingPerformed: false,
  verifierHash: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
  inputHashes: Object.fromEntries(await Promise.all(['manifest.json', 'result.json', 'seal.json', 'events.jsonl'].map(async file =>
    [file, createHash('sha256').update(await fs.readFile(path.join(folder, file))).digest('hex')]))),
};
await fs.writeFile(path.join(folder, 'independent-protocol-review.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ folder, ...report }));
process.exitCode = report.mechanismPassed ? 0 : 1;
