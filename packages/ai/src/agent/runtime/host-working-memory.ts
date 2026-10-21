import { createHash } from 'node:crypto';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type, type Context, type Message } from '@earendil-works/pi-ai';
import { observeWorkingMemorySources, projectWorkingMemorySource, type ObservedWorkingMemorySource } from './host-working-memory-sources';

export type HostWorkingMemoryMode = 'off' | 'shadow' | 'apply';

export interface WorkingMemoryNote {
  /** Stable run-local notebook key; never an external file path. */
  key?: string;
  text: string;
  evidenceIds: string[];
}

/** Model-authored task state, never a verified fact store or a policy source. */
export interface WorkingMemoryState {
  facts: WorkingMemoryNote[];
  hypotheses: WorkingMemoryNote[];
  openQuestions: string[];
  nextAction: WorkingMemoryNote;
}

/** A host-approved static caution; exact values never exempt failure fields. */
export interface WorkingMemoryReadCautionRule {
  toolName: string;
  warningCodes: string[];
  warningTexts: string[];
}

export interface WorkingMemorySourceCaution extends WorkingMemoryReadCautionRule {
  toolCallId: string;
}

export interface WorkingMemoryDirectoryEntry {
  toolCallId: string;
  toolName: string;
  /** Protocol siblings remain intact when this result body is projected. */
  groupToolCallIds: string[];
  characters: number;
  projected: boolean;
  referenceEligible: boolean;
  projectionEligible: boolean;
  projectionBlockedReasons: string[];
  /** Hash of the immutable, complete tool-result content, computed by the host. */
  contentHash: string;
  sourceIdentity: Record<string, string | number | boolean>;
  sourceIdentityStatus?: 'reported' | 'missing' | 'conflicting';
  provider?: string;
  detail?: string;
  sourceCautions?: Pick<WorkingMemoryReadCautionRule, 'warningCodes' | 'warningTexts'>;
  retainedCautions?: Pick<WorkingMemoryReadCautionRule, 'warningCodes' | 'warningTexts'>;
}

export interface WorkingMemoryCatalogSummary {
  evidenceCount: number;
  referenceEligibleCount: number;
  projectionCandidateCount: number;
  blockedCount: number;
  blockedReasons: { code: string; count: number }[];
  truncated: boolean;
}

export interface HostWorkingMemoryAuditEvent {
  commitOrigin?: 'validated_report_checkpoint';
  validatedReportHash?: string;
  sourceCheckpointHash?: string;
  schemaVersion: 'host-working-memory.v1';
  status: 'ready_for_projection';
  operation: 'update' | 'restore';
  mode: HostWorkingMemoryMode;
  commandId: string;
  previousVersion: number;
  version: number;
  editCount: number;
  /** Cumulative set after this command. */
  pruneToolCallIds: string[];
  /** Newly selected IDs in this command. */
  actionPruneToolCallIds: string[];
  restoredToolCallIds: string[];
  state: WorkingMemoryState;
  retainedReadCautions?: WorkingMemorySourceCaution[];
  projectionKind?: 'result_body_placeholder';
  catalogSummary?: WorkingMemoryCatalogSummary;
  evidenceCatalog?: WorkingMemoryDirectoryEntry[];
  projectionCandidates?: WorkingMemoryDirectoryEntry[];
  policyIdentity?: WorkingMemoryPolicyIdentity;
  phase?: 'LOG' | 'PLAN';
  readCount?: number;
  logCount?: number;
  planCount?: number;
}

export interface HostWorkingMemoryProjectionEvent {
  schemaVersion: 'host-working-memory.v1';
  /** This receipt means the provider request was prepared, not understood. */
  status: 'provider_request_prepared';
  mode: HostWorkingMemoryMode;
  version: number;
  pruneToolCallIds: string[];
  originalMessageCount: number;
  projectedMessageCount: number;
  originalChars: number;
  projectedChars: number;
  retainedReadCautions?: WorkingMemorySourceCaution[];
  projectionKind?: 'result_body_placeholder';
  catalogSummary?: WorkingMemoryCatalogSummary;
  evidenceCatalog?: WorkingMemoryDirectoryEntry[];
  projectionCandidates?: WorkingMemoryDirectoryEntry[];
  policyIdentity?: WorkingMemoryPolicyIdentity;
  phase?: 'LOG' | 'PLAN';
  readCount?: number;
  logCount?: number;
  planCount?: number;
}

export interface WorkingMemoryPolicyIdentity { version: string; hash: string }

export interface WorkingMemoryProtocol {
  deduplication: 'normalized-text-evidence' | 'exact-text-evidence';
  retrievalOrder: 'evidence-first' | 'recent-first';
  maxRetrievedNotes: number;
  maxReadCalls: number;
}

export interface HostWorkingMemoryUsageEvent {
  schemaVersion: 'host-working-memory.v1';
  status: 'provider_result_received';
  mode: HostWorkingMemoryMode;
  version: number;
  invocation: number;
  model: string;
  provider: string;
  elapsedMs: number;
  usageStatus: 'reported' | 'partial' | 'unknown';
  source: 'sdk_result' | 'unknown';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  policyIdentity?: WorkingMemoryPolicyIdentity;
}

export interface HostWorkingMemoryRejectedEvent {
  schemaVersion: 'host-working-memory.v1';
  operation?: 'read' | 'update' | 'restore';
  mode: HostWorkingMemoryMode;
  version: number;
  commandId?: string;
  code: string;
  detail: string;
}

export interface HostWorkingMemoryOptions {
  mode: HostWorkingMemoryMode;
  /** Host status feedback for ordinary continuous tasks, never a forced save. */
  modelSaveFeedback?: boolean;
  /** Host-approved pure reads only. Names do not confer execution permission. */
  readonlyToolNames: string[];
  /** Explicit denials override the read list. */
  deniedToolNames?: string[];
  /** Only exact static warnings for exact registered read tools may be retained
   * with their source identity while the original read is projected out. */
  retainedReadCautions?: WorkingMemoryReadCautionRule[];
  maxEdits?: number;
  maxSummaryChars?: number;
  onAudit: (event: HostWorkingMemoryAuditEvent) => void | Promise<void>;
  onProjection?: (event: HostWorkingMemoryProjectionEvent) => void | Promise<void>;
  onRejected?: (event: HostWorkingMemoryRejectedEvent) => void | Promise<void>;
  policyIdentity?: WorkingMemoryPolicyIdentity;
  memoryProtocol?: WorkingMemoryProtocol;
  onUsage?: (event: HostWorkingMemoryUsageEvent) => void | Promise<void>;
}

export interface WorkingMemorySnapshot {
  schemaVersion: 'host-working-memory.v1';
  authority: 'model-authored-unverified';
  mode: HostWorkingMemoryMode;
  version: number;
  editCount: number;
  maxEdits: number;
  maxSummaryChars: number;
  state: WorkingMemoryState;
  pruneToolCallIds: string[];
  directory: WorkingMemoryDirectoryEntry[];
  evidenceCatalog: WorkingMemoryDirectoryEntry[];
  projectionCandidates: WorkingMemoryDirectoryEntry[];
  catalogSummary: WorkingMemoryCatalogSummary;
  directoryTruncated: boolean;
  retainedReadCautions: WorkingMemorySourceCaution[];
  policyIdentity?: WorkingMemoryPolicyIdentity;
  phase?: 'LOG' | 'PLAN';
  readCount: number;
  logCount: number;
  planCount: number;
  stateScope: 'complete' | 'query';
  indexedNotes: { key: string; category: 'fact' | 'hypothesis' | 'nextAction'; text: string; evidenceIds: string[] }[];
  retrieval?: { query: string; matchedCount: number; returnedCount: number; maxChars: number; truncated: boolean };
}

type WorkingMemoryCommand = {
  operation: 'read';
  query?: string;
  maxChars?: number;
} | {
  operation: 'update';
  commandId: string;
  expectedVersion: number;
  state: WorkingMemoryState;
  pruneToolCallIds: string[];
  phase?: 'LOG' | 'PLAN';
} | {
  operation: 'restore';
  commandId: string;
  expectedVersion: number;
};

export type WorkingMemoryResult = {
  ok: true;
  duplicate?: boolean;
  snapshot: WorkingMemorySnapshot;
} | {
  ok: false;
  code: string;
  detail: string;
  version: number;
};

const HARD_MAX_EDITS = 16;
const HARD_MAX_SUMMARY_CHARS = 12000;
const MAX_DIRECTORY = 64;
const MAX_CATALOG_CHARS = 24000;
const MAX_IDS = 64;
const MAX_COMMANDS = 33; // Bounded updates plus independent restore capacity.
const MAX_ITEM_CHARS = 2000;
const MAX_CAUTION_RULES = 8;
const MAX_CAUTION_VALUES = 8;
const MAX_CAUTION_CHARS = 1000;
const MAX_CAUTION_CONFIG_CHARS = 8000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|+-]{0,255}$/;

const noteSchema = Type.Object({
  key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  text: Type.String({ maxLength: MAX_ITEM_CHARS }),
  evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: MAX_IDS, uniqueItems: true,
    description: 'Current catalog toolCallId, or an exact observed source identity (evidenceId/sourceEventId/sha256). The host binds identities to current authorized receipts; unknown or ambiguous identities are rejected.' }),
}, { additionalProperties: false });
const stateSchema = Type.Object({
  facts: Type.Array(Type.Object({
    ...noteSchema.properties,
    text: Type.String({ minLength: 1, maxLength: MAX_ITEM_CHARS }),
    evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: MAX_IDS, uniqueItems: true,
      description: 'At least one referenceEligible current evidenceCatalog.toolCallId. Never invent a source or remove evidence to force a fact through validation.' }),
  }, { additionalProperties: false }), { maxItems: 24, description: 'Use [] when no observed fact can be supported. Questions alone can be saved without inventing facts.' }),
  hypotheses: Type.Array(noteSchema, { maxItems: 16 }),
  openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: MAX_ITEM_CHARS }), { maxItems: 16 }),
  nextAction: noteSchema,
}, { additionalProperties: false });

/** The provider schema is descriptive; the host always validates again. */
export const workingMemoryToolParameters = Type.Object({
  operation: Type.Union([Type.Literal('read'), Type.Literal('update'), Type.Literal('restore')]),
  commandId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0, description: 'Current run-local version from workingMemory read, not the version of an inherited checkpoint. A rejected update does not increment it.' })),
  state: Type.Optional(stateSchema),
  pruneToolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: MAX_IDS, uniqueItems: true,
    description: 'Optional IDs to project out. Omit or use [] to save notes without removing any original result bodies.' })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: HARD_MAX_SUMMARY_CHARS })),
  phase: Type.Optional(Type.Union([Type.Literal('LOG'), Type.Literal('PLAN')])),
}, { additionalProperties: false });

function emptyState(): WorkingMemoryState {
  return { facts: [], hypotheses: [], openQuestions: [], nextAction: { text: '', evidenceIds: [] } };
}

const clone = <T>(value: T): T => structuredClone(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const validId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
}

function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_IDS && value.every(validId) && new Set(value).size === value.length;
}

function note(value: unknown): value is WorkingMemoryNote {
  return record(value, ['key', 'text', 'evidenceIds']) && (value.key === undefined || typeof value.key === 'string' && value.key.length <= 128
    && !!value.key.trim() && !/[\p{C}]/u.test(value.key)) && typeof value.text === 'string'
    && value.text.length <= MAX_ITEM_CHARS && ids(value.evidenceIds);
}

function validState(value: unknown): value is WorkingMemoryState {
  if (!record(value, ['facts', 'hypotheses', 'openQuestions', 'nextAction'])) return false;
  return Array.isArray(value.facts) && value.facts.length <= 24
    && value.facts.every(item => note(item) && !!item.text.trim() && item.evidenceIds.length > 0)
    && Array.isArray(value.hypotheses) && value.hypotheses.length <= 16
    && value.hypotheses.every(item => note(item) && !!item.text.trim())
    && Array.isArray(value.openQuestions) && value.openQuestions.length <= 16
    && value.openQuestions.every(item => typeof item === 'string' && !!item.trim() && item.length <= MAX_ITEM_CHARS)
    && note(value.nextAction) && (!!value.nextAction.text.trim() || value.nextAction.evidenceIds.length === 0);
}

function parseCommand(value: unknown): WorkingMemoryCommand | undefined {
  if (!record(value, ['operation', 'commandId', 'expectedVersion', 'state', 'pruneToolCallIds', 'query', 'maxChars', 'phase'])) return undefined;
  if (value.operation === 'read' && Reflect.ownKeys(value).every(key => ['operation', 'query', 'maxChars'].includes(String(key))) &&
    (value.query === undefined || typeof value.query === 'string' && !!value.query.trim() && value.query.length <= 256) &&
    (value.maxChars === undefined || integer(value.maxChars, 256, HARD_MAX_SUMMARY_CHARS))) return clone(value as unknown as WorkingMemoryCommand);
  if (!validId(value.commandId) || !integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  if (value.operation === 'restore' && Reflect.ownKeys(value).length === 3) return clone(value as unknown as WorkingMemoryCommand);
  if (value.operation === 'update' && Reflect.ownKeys(value).every(key => ['operation', 'commandId', 'expectedVersion', 'state', 'pruneToolCallIds', 'phase'].includes(String(key))) &&
    (value.phase === undefined || value.phase === 'LOG' || value.phase === 'PLAN') && validState(value.state) &&
    (value.pruneToolCallIds === undefined || ids(value.pruneToolCallIds))) {
    return clone({ operation: 'update', commandId: value.commandId, expectedVersion: value.expectedVersion,
      state: value.state, pruneToolCallIds: value.pruneToolCallIds ?? [], ...(value.phase === undefined ? {} : { phase: value.phase }) } as WorkingMemoryCommand);
  }
  return undefined;
}

function keyedState(value: WorkingMemoryState, previous: WorkingMemoryState, protocol: WorkingMemoryProtocol): WorkingMemoryState | string {
  const seenKeys = new Set<string>();
  const priorCategories = new Map<string, string>();
  for (const [category, entries] of [['fact', previous.facts], ['hypothesis', previous.hypotheses], ['nextAction', [previous.nextAction]]] as const) {
    for (const entry of entries) if (entry.key) priorCategories.set(entry.key, category);
  }
  const keyText = (entry: WorkingMemoryNote) => JSON.stringify([
    protocol.deduplication === 'normalized-text-evidence' ? entry.text.trim().replace(/\s+/g, ' ').toLowerCase() : entry.text,
    [...entry.evidenceIds].sort(),
  ]);
  const normalize = (entries: WorkingMemoryNote[], category: string): WorkingMemoryNote[] | string => {
    const seenContent = new Set<string>();
    const result: WorkingMemoryNote[] = [];
    for (const entry of entries) {
      const content = keyText(entry);
      const key = entry.key ?? `wm-${category}-${createHash('sha256').update(content).digest('hex').slice(0, 24)}`;
      if (priorCategories.has(key) && priorCategories.get(key) !== category) return 'note_category_conflict';
      if (seenKeys.has(key) && !seenContent.has(content)) return 'duplicate_note_key';
      if (seenContent.has(content)) continue;
      seenKeys.add(key); seenContent.add(content); result.push({ ...clone(entry), key });
    }
    return result;
  };
  const facts = normalize(value.facts, 'fact'); if (typeof facts === 'string') return facts;
  const hypotheses = normalize(value.hypotheses, 'hypothesis'); if (typeof hypotheses === 'string') return hypotheses;
  const next = value.nextAction.text.trim() ? normalize([value.nextAction], 'nextAction') : [clone(value.nextAction)];
  if (typeof next === 'string') return next;
  return { facts, hypotheses, openQuestions: [...new Set(value.openQuestions)], nextAction: next[0] };
}

/** Run-local projection controller. The SDK transcript is never mutated. */
export function createHostWorkingMemory(input: {
  options?: HostWorkingMemoryOptions;
  signal: AbortSignal;
  onFailure?: (message: string) => void;
}) {
  const options = input.options;
  const mode = options?.mode ?? 'off';
  const maxEdits = options?.maxEdits ?? 4;
  const maxSummaryChars = options?.maxSummaryChars ?? 6000;
  const policyIdentity = options?.policyIdentity ? clone(options.policyIdentity) : undefined;
  const memoryProtocol: WorkingMemoryProtocol = options?.memoryProtocol ? clone(options.memoryProtocol) : {
    deduplication: 'normalized-text-evidence', retrievalOrder: 'evidence-first', maxRetrievedNotes: 16, maxReadCalls: 16,
  };
  const allowed = new Set(options?.readonlyToolNames ?? []);
  // Management results hold the current state and are always pinned.
  allowed.delete('workingMemory');
  const denied = new Set(options?.deniedToolNames ?? []);
  let cautionRules = new Map<string, WorkingMemoryReadCautionRule>();
  let cautionsValidated = false;
  let version = 0;
  let editCount = 0;
  let state = emptyState();
  let phase: 'LOG' | 'PLAN' | undefined;
  let readCount = 0, logCount = 0, planCount = 0, usageInvocation = 0;
  let failure: string | undefined;
  let evidenceCatalog = new Map<string, ObservedWorkingMemorySource>();
  let projectionCandidates = new Map<string, ObservedWorkingMemorySource>();
  const pruned = new Map<string, string>();
  // Restoring clears the projection selection, never the integrity obligation
  // for original results which this run has already promised to recover.
  const retainedSources = new Map<string, string>();
  const commands = new Map<string, { fingerprint: string; result: WorkingMemoryResult }>();
  let prepared: { version: number; fingerprint: string; event: HostWorkingMemoryProjectionEvent } | undefined;
  let serial = Promise.resolve();
  const fail = (detail: string) => {
    if (!failure) { failure = detail; input.onFailure?.(failure); }
    return new Error(failure);
  };
  const guard = () => {
    input.signal.throwIfAborted();
    if (failure) throw new Error(failure);
  };
  const awaitHost = async <T>(work: Promise<T>): Promise<T> => {
    guard();
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(input.signal.reason ?? new Error('Working memory aborted.'));
      input.signal.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([work, aborted]); guard(); return result; }
    finally { input.signal.removeEventListener('abort', abort); }
  };
  const assertReady = () => {
    if (!options || mode === 'off') return;
    if (!['shadow', 'apply'].includes(mode) || !integer(maxEdits, 1, HARD_MAX_EDITS)
      || !integer(maxSummaryChars, 256, HARD_MAX_SUMMARY_CHARS) || typeof options.onAudit !== 'function'
      || (options.onProjection !== undefined && typeof options.onProjection !== 'function')
      || (options.onRejected !== undefined && typeof options.onRejected !== 'function')
      || (options.onUsage !== undefined && typeof options.onUsage !== 'function')
      || (policyIdentity !== undefined && (!record(policyIdentity, ['version', 'hash']) || !validId(policyIdentity.version)
        || typeof policyIdentity.hash !== 'string' || !/^[a-f0-9]{64}$/.test(policyIdentity.hash)))
      || !record(memoryProtocol, ['deduplication', 'retrievalOrder', 'maxRetrievedNotes', 'maxReadCalls'])
      || !['normalized-text-evidence', 'exact-text-evidence'].includes(memoryProtocol.deduplication)
      || !['evidence-first', 'recent-first'].includes(memoryProtocol.retrievalOrder)
      || !integer(memoryProtocol.maxRetrievedNotes, 1, 56) || !integer(memoryProtocol.maxReadCalls, 1, 64)
      || !Array.isArray(options.readonlyToolNames) || options.readonlyToolNames.length === 0
      || options.readonlyToolNames.length > 256 || options.readonlyToolNames.some(name => !validId(name))
      || (options.deniedToolNames !== undefined && (!Array.isArray(options.deniedToolNames)
        || options.deniedToolNames.length > 256 || options.deniedToolNames.some(name => !validId(name))))) {
      throw fail('Working memory configuration is invalid.');
    }
    if (cautionsValidated) return;
    const configured = options.retainedReadCautions;
    if (configured !== undefined) {
      const strings = (value: unknown, codes: boolean): value is string[] => Array.isArray(value)
        && value.length <= MAX_CAUTION_VALUES && new Set(value).size === value.length
        && Array.from(value).every(item => typeof item === 'string' && !!item.trim() && item.length <= MAX_CAUTION_CHARS
          && (!codes || validId(item)));
      if (!Array.isArray(configured) || configured.length > MAX_CAUTION_RULES
        || Array.from(configured).some(rule => !record(rule, ['toolName', 'warningCodes', 'warningTexts'])
          || Reflect.ownKeys(rule).length !== 3 || !validId(rule.toolName) || !allowed.has(rule.toolName)
          || denied.has(rule.toolName) || !strings(rule.warningCodes, true) || !strings(rule.warningTexts, false)
          || rule.warningCodes.length + rule.warningTexts.length === 0)
        || new Set(configured.map(rule => rule.toolName)).size !== configured.length
        || JSON.stringify(configured).length > MAX_CAUTION_CONFIG_CHARS) {
        throw fail('Working memory retained read caution configuration is invalid.');
      }
      cautionRules = new Map(configured.map(rule => [rule.toolName, clone(rule)]));
    }
    cautionsValidated = true;
  };
  const sourceCautions = (sourceIds: Iterable<string>): WorkingMemorySourceCaution[] => {
    const result: WorkingMemorySourceCaution[] = [];
    for (const id of new Set(sourceIds)) {
      const entry = evidenceCatalog.get(id)?.entry;
      if (entry?.sourceCautions) result.push({ toolCallId: id, toolName: entry.toolName, ...clone(entry.sourceCautions) });
    }
    return result;
  };
  const snapshot = (query?: string, maxChars = maxSummaryChars): WorkingMemorySnapshot => {
    const directory: WorkingMemoryDirectoryEntry[] = [];
    let catalogChars = 2;
    for (const source of [...evidenceCatalog.values()].reverse()) {
      const entry = { ...clone(source.entry), projected: mode === 'apply' && pruned.has(source.entry.toolCallId) };
      const chars = JSON.stringify(entry).length + 1;
      if (directory.length >= MAX_DIRECTORY || catalogChars + chars > MAX_CATALOG_CHARS) continue;
      directory.unshift(entry); catalogChars += chars;
    }
    const directoryTruncated = directory.length < evidenceCatalog.size;
    const blockedReasons = new Map<string, number>();
    for (const source of evidenceCatalog.values()) for (const reason of source.entry.projectionBlockedReasons) {
      blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
    }
    const referenceEligibleCount = [...evidenceCatalog.values()].filter(source => source.entry.referenceEligible).length;
    let indexedNotes: WorkingMemorySnapshot['indexedNotes'] = [
      ...state.facts.map(note => ({ ...clone(note), key: note.key!, category: 'fact' as const })),
      ...state.hypotheses.map(note => ({ ...clone(note), key: note.key!, category: 'hypothesis' as const })),
      ...(state.nextAction.text ? [{ ...clone(state.nextAction), key: state.nextAction.key!, category: 'nextAction' as const }] : []),
    ];
    if (query) {
      const terms = query.trim().toLowerCase().split(/\s+/);
      indexedNotes = indexedNotes.filter(note => terms.some(term => `${note.key} ${note.text} ${note.evidenceIds.join(' ')}`.toLowerCase().includes(term)));
    }
    const matchedCount = indexedNotes.length;
    if (memoryProtocol.retrievalOrder === 'evidence-first') indexedNotes.sort((a, b) => b.evidenceIds.length - a.evidenceIds.length);
    else indexedNotes.reverse();
    const retrieved: WorkingMemorySnapshot['indexedNotes'] = [];
    let usedChars = 2;
    for (const note of indexedNotes) {
      const chars = JSON.stringify(note).length + 1;
      if (retrieved.length >= memoryProtocol.maxRetrievedNotes || usedChars + chars > maxChars) continue;
      retrieved.push(note); usedChars += chars;
    }
    return {
      schemaVersion: 'host-working-memory.v1', authority: 'model-authored-unverified', mode, version,
      editCount, maxEdits, maxSummaryChars, state: query ? emptyState() : clone(state), pruneToolCallIds: [...pruned.keys()],
      ...(policyIdentity ? { policyIdentity: clone(policyIdentity) } : {}), ...(phase ? { phase } : {}), readCount, logCount, planCount,
      stateScope: query ? 'query' : 'complete', indexedNotes: retrieved,
      ...(query ? { retrieval: { query, matchedCount, returnedCount: retrieved.length, maxChars, truncated: retrieved.length < matchedCount } } : {}),
      directory, evidenceCatalog: clone(directory), projectionCandidates: directory.filter(entry => entry.projectionEligible),
      catalogSummary: { evidenceCount: evidenceCatalog.size, referenceEligibleCount, projectionCandidateCount: projectionCandidates.size,
        blockedCount: evidenceCatalog.size - projectionCandidates.size, blockedReasons: [...blockedReasons].map(([code, count]) => ({ code, count })),
        truncated: directoryTruncated },
      directoryTruncated,
      retainedReadCautions: sourceCautions(directory.map(entry => entry.toolCallId).concat([...pruned.keys()])),
    };
  };
  const rejected = (code: string, detail: string): WorkingMemoryResult => ({ ok: false, code, detail, version });
  const execute = async (value: unknown, origin?: Pick<HostWorkingMemoryAuditEvent, 'commitOrigin' | 'validatedReportHash' | 'sourceCheckpointHash'>): Promise<WorkingMemoryResult> => {
    guard();
    assertReady();
    if (mode === 'off') return rejected('disabled', 'Working memory is disabled for this run.');
    const command = parseCommand(value);
    if (!command) return rejected('invalid_command', 'Invalid workingMemory command. read accepts only operation, optional query/maxChars. update requires commandId, expectedVersion and state with facts, hypotheses, openQuestions and nextAction; pruneToolCallIds may be omitted or [] to retain original bodies. Every note needs text and evidenceIds from evidenceCatalog.toolCallId (not source hashes, sourceEventId or evidenceId). Read the current version and catalog before correcting the command. Extra fields, malformed IDs and configured length limits remain rejected.');
    if (command.operation === 'read') {
      if (readCount >= memoryProtocol.maxReadCalls) return rejected('read_limit', 'The run-local memory read budget is exhausted; restore remains available.');
      readCount += 1; planCount += 1; phase = 'PLAN';
      return { ok: true, snapshot: snapshot(command.query, command.maxChars) };
    }
    const fingerprint = JSON.stringify({command,origin});
    const previous = commands.get(command.commandId);
    if (previous) return previous.fingerprint === fingerprint
      ? { ...clone(previous.result), duplicate: true } as WorkingMemoryResult
      : rejected('command_id_conflict', 'This commandId was already used with different content.');
    if (command.expectedVersion !== version) return rejected('version_conflict', 'Read the current version before proposing an edit.');
    if (commands.size >= MAX_COMMANDS) return rejected('command_limit', 'The bounded command ledger is full.');
    const nextPruned = command.operation === 'restore' ? new Map<string, string>() : new Map(pruned);
    const visibleIds = new Set(snapshot().directory.map(entry => entry.toolCallId));
    const boundState = command.operation === 'restore' ? emptyState() : clone(command.state);
    if(command.operation==='update')for(const note of [...boundState.facts,...boundState.hypotheses,boundState.nextAction]){
      const bound:string[]=[];
      for(const id of note.evidenceIds){
        if(evidenceCatalog.has(id)){bound.push(id);continue;}
        const matches=[...evidenceCatalog.values()].filter(s=>['evidenceId','sourceEventId','evidenceEventId','sha256'].some(k=>s.entry.sourceIdentity[k]===id));
        // One immutable source may have several read windows. Never conflate
        // distinct sources, accept a failed receipt, or look beyond this run.
        const identities=new Set(matches.map(s=>JSON.stringify([s.entry.toolName,s.entry.sourceIdentity.url??s.entry.sourceIdentity.path,
          s.entry.sourceIdentity.contentHash??s.entry.sourceIdentity.sha256,s.entry.sourceIdentity.rawHash])));
        if(!matches.length||identities.size!==1||matches.some(s=>!s.entry.referenceEligible||s.entry.sourceIdentityStatus==='conflicting'
          ||!visibleIds.has(s.entry.toolCallId)&&!pruned.has(s.entry.toolCallId)))return rejected('unknown_evidence',`Source identity is unknown, ambiguous, conflicting or not an authorized current observation. Read evidenceCatalog and use its toolCallId. Current eligible IDs: ${JSON.stringify([...evidenceCatalog.values()].filter(s=>s.entry.referenceEligible&&visibleIds.has(s.entry.toolCallId)).slice(-8).map(s=>s.entry.toolCallId))}`);
        bound.push(...matches.map(s=>s.entry.toolCallId));
      }
      note.evidenceIds=[...new Set(bound)];
      if(note.evidenceIds.length>MAX_IDS)return rejected('unknown_evidence','Source identity expands beyond the bounded reference limit; cite exact toolCallIds.');
    }
    const keyed = command.operation === 'restore' ? emptyState() : keyedState(boundState, state, memoryProtocol);
    if (typeof keyed === 'string') return rejected(keyed, 'Stable notebook keys must be unique and cannot move a hypothesis into facts or change its category.');
    const nextState = keyed;
    if (command.operation === 'update') {
      if (editCount >= maxEdits) return rejected('edit_limit', 'The update limit is exhausted; read or restore remains available.');
      if (JSON.stringify(nextState).length > maxSummaryChars) return rejected('summary_limit', 'Working state exceeds the configured character limit.');
      const references = [...nextState.facts, ...nextState.hypotheses, nextState.nextAction].flatMap(item => item.evidenceIds);
      if (references.some(id => !evidenceCatalog.get(id)?.entry.referenceEligible || (!visibleIds.has(id) && !pruned.has(id)))) {
        const available = [...evidenceCatalog.values()].filter(source => source.entry.referenceEligible
          && (visibleIds.has(source.entry.toolCallId) || pruned.has(source.entry.toolCallId))).map(source => source.entry.toolCallId);
        return rejected('unknown_evidence', `Each evidenceIds entry must be an evidenceCatalog.toolCallId, not sourceIdentity.evidenceId or sourceEventId. Current eligible toolCallIds (up to 16): ${JSON.stringify(available.slice(0, 16))}${available.length > 16 ? ' (truncated; use read to inspect the catalog)' : ''}.`);
      }
      for (const id of command.pruneToolCallIds) {
        const source = projectionCandidates.get(id);
        if (!source || !visibleIds.has(id)) return rejected('unsafe_prune', 'The selected ID is unknown, protected, unpaired, or outside the projection candidates.');
        if (pruned.has(id)) return rejected('already_pruned', 'An already projected ID cannot be selected again.');
        nextPruned.set(id, source.fingerprint);
      }
      const retained = new Set(references);
      if ([...nextPruned.keys()].some(id => !retained.has(id))) {
        return rejected('unreferenced_prune', 'Every projected read must remain cited in working state.');
      }
    }
    const observed = snapshot();
    const audit: HostWorkingMemoryAuditEvent = {
      ...origin,
      schemaVersion: 'host-working-memory.v1', status: 'ready_for_projection', operation: command.operation, mode,
      commandId: command.commandId, previousVersion: version, version: version + 1,
      editCount: editCount + (command.operation === 'update' ? 1 : 0),
      pruneToolCallIds: [...nextPruned.keys()],
      actionPruneToolCallIds: command.operation === 'update' ? command.pruneToolCallIds : [],
      restoredToolCallIds: command.operation === 'restore' ? [...pruned.keys()] : [],
      state: clone(nextState),
      retainedReadCautions: sourceCautions(command.operation === 'update'
        ? [...nextState.facts, ...nextState.hypotheses, nextState.nextAction].flatMap(note => note.evidenceIds) : [...pruned.keys()]),
      projectionKind: 'result_body_placeholder', catalogSummary: observed.catalogSummary,
      evidenceCatalog: observed.evidenceCatalog, projectionCandidates: observed.projectionCandidates,
      ...(policyIdentity ? { policyIdentity: clone(policyIdentity) } : {}),
      ...(command.operation === 'update' ? { phase: command.phase ?? 'LOG' } : phase ? { phase } : {}),
      readCount, logCount: logCount + (command.operation === 'update' && command.phase !== 'PLAN' ? 1 : 0),
      planCount: planCount + (command.operation === 'update' && command.phase === 'PLAN' ? 1 : 0),
    };
    try {
      await awaitHost(Promise.resolve().then(() => options!.onAudit(clone(audit))));
      guard();
    } catch (error) {
      if (input.signal.aborted || failure) throw error;
      return rejected('audit_failed', 'The host could not persist the audit receipt; previous state is intact.');
    }
    state = clone(nextState);
    pruned.clear();
    for (const [id, digest] of nextPruned) { pruned.set(id, digest); retainedSources.set(id, digest); }
    version = audit.version;
    editCount = audit.editCount;
    phase = audit.phase; logCount = audit.logCount!; planCount = audit.planCount!;
    const result: WorkingMemoryResult = { ok: true, snapshot: snapshot() };
    commands.set(command.commandId, { fingerprint, result: clone(result) });
    return result;
  };
  const manage = (value: unknown): Promise<WorkingMemoryResult> => {
    const work = serial.then(() => execute(value));
    serial = work.then(() => undefined, () => undefined);
    return work;
  };
  const messageFingerprint = (messages: Message[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const observe = (messages: Message[]) => {
    if (mode === 'off') return;
    guard();
    assertReady();
    try {
      const nextCatalog = observeWorkingMemorySources(messages, allowed, denied, cautionRules);
      const nextCandidates = new Map([...nextCatalog].filter(([, source]) => source.entry.projectionEligible));
      for (const [id, digest] of retainedSources) {
        if (nextCandidates.get(id)?.fingerprint !== digest) throw fail('Working memory projected evidence is missing, changed, or no longer safe. Start a new run with intact source history.');
      }
      evidenceCatalog = nextCatalog;
      projectionCandidates = nextCandidates;
    } catch (error) {
      if (input.signal.aborted || failure) throw error;
      throw fail('Working memory source inspection failed.');
    }
  };
  const projectContext = (context: Context): Context => {
    if (mode === 'off') return context;
    guard();
    try {
      // The SDK can copy the hook's output array when converting provider
      // messages. Exact content identity, scoped to one pending request,
      // recognizes only this host's own projection without a prompt marker.
      if (prepared?.version === version && prepared.fingerprint === messageFingerprint(context.messages)) return context;
      observe(context.messages);
      const replacements = new Map<number, ObservedWorkingMemorySource>();
      if (mode === 'apply') for (const id of pruned.keys()) {
        const source = projectionCandidates.get(id)!;
        replacements.set(source.resultIndex, source);
      }
      const projected: Context = replacements.size ? { ...context,
        messages: context.messages.map((message, index) => {
          const source = replacements.get(index);
          return source && message.role === 'toolResult' ? projectWorkingMemorySource(message, source) : message;
        }) } : context;
      const observed = snapshot();
      prepared = { version, fingerprint: messageFingerprint(projected.messages), event: {
        schemaVersion: 'host-working-memory.v1', status: 'provider_request_prepared', mode, version,
        pruneToolCallIds: [...pruned.keys()], originalMessageCount: context.messages.length,
        projectedMessageCount: projected.messages.length, originalChars: JSON.stringify(context.messages).length,
        projectedChars: JSON.stringify(projected.messages).length,
        retainedReadCautions: sourceCautions(pruned.keys()),
        projectionKind: 'result_body_placeholder', catalogSummary: observed.catalogSummary,
        evidenceCatalog: observed.evidenceCatalog, projectionCandidates: observed.projectionCandidates,
        ...(policyIdentity ? { policyIdentity: clone(policyIdentity) } : {}), ...(phase ? { phase } : {}), readCount, logCount, planCount,
      } };
      return projected;
    } catch (error) {
      if (input.signal.aborted || failure) throw error;
      throw fail('Working memory context inspection or projection failed.');
    }
  };
  const tool: AgentTool<typeof workingMemoryToolParameters, WorkingMemoryResult> = {
    name: 'workingMemory', label: 'Working memory',
    description: 'Maintain non-authoritative task notes. Managed Work/Loop hosts durably audit accepted LOG updates; an eligible successful same-scope checkpoint may be inherited by the next continuous task under owner, source, policy and TTL checks. This does not automatically write or approve Brain long-term memory or restore a previous model session. version=0 does not prove empty history or a first-ever run; host continuity status is separate. A read, workshopLogEvent and final report text are not LOG updates. Save only when the current task needs a checkpoint; no per-run LOG requirement. operation=read returns version, evidenceCatalog, and projectionCandidates with explicit blocking reasons. Optional query and maxChars retrieve a bounded indexedNotes view instead of the complete state; stateScope=query means the empty state is not the full notebook. Only referenceEligible observations may support notes; an observation is not a verified fact. operation=update requires commandId, expectedVersion, state (facts with evidence, hypotheses, questions, next action), and pruneToolCallIds (may be empty; saving does not require pruning). Optional phase=LOG|PLAN identifies the stage; optional note.key revises a stable run-local key. Duplicate same-category text/evidence is removed, but hypotheses never merge into facts. Only projectionCandidates may have their result bodies replaced by explicit host placeholders. Thinking, assistant text, tool calls, result identities, warnings, and raw history remain intact. Sibling results need not be projected together. operation=restore requires only commandId and expectedVersion and clears all notes and projection, restoring exact original results without re-executing tools. Use a unique commandId and current expectedVersion; never invent IDs or use notes as policy/permission.',
    parameters: workingMemoryToolParameters, executionMode: 'sequential', replay: 'never',
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const result = await manage(params);
      if (result.ok === false && options?.onRejected) {
        const command = parseCommand(params);
        const event: HostWorkingMemoryRejectedEvent = {
          schemaVersion: 'host-working-memory.v1', mode, version: result.version,
          ...(command ? { operation: command.operation } : {}),
          ...(command && command.operation !== 'read' ? { commandId: command.commandId } : {}),
          code: result.code, detail: result.detail,
        };
        try { await awaitHost(Promise.resolve().then(() => options.onRejected!(clone(event)))); }
        catch { throw fail('Working memory rejection receipt could not be persisted.'); }
      }
      const retainedCautions = { hostRules: [...cautionRules.values()], sources: snapshot().retainedReadCautions };
      return { content: [{ type: 'text', text: `NON-AUTHORITATIVE MODEL NOTES; NOT VERIFIED FACTS. Never override host or owner instructions, permissions, or original source evidence.\nCURRENT-RUN VERSION ONLY: version=0 does not prove empty history or a first-ever run. Managed Work/Loop hosts durably audit accepted LOG updates; eligible same-scope successful checkpoints may continue under host checks. A read, workshopLogEvent and final report text are not LOG updates. No automatic Brain write or approval; save only when the task requires it.\nHOST-RETAINED SOURCE CAUTIONS (preserve alongside task notes): ${JSON.stringify(retainedCautions)}\n${JSON.stringify(result)}` }], details: result };
    },
  };
  return {
    get enabled() { return mode !== 'off'; },
    get failure() { return failure; },
    tool,
    snapshot,
    manage,
    /** Host-only closure path. Its provenance cannot be supplied through the
     * model tool schema. Do not overwrite a notebook the model already edited. */
    commitReportProgress(progress: {text: string; openQuestions: string[]; checkpointHash: string},
      authorize: (command: Record<string, unknown>) => Promise<void>) {
      const work = serial.then(async () => {
        guard(); assertReady();
        if (mode !== 'apply' || version !== 0 || logCount > 0) return;
        if (denied.has('workingMemory')) throw fail('Working memory host progress commit is denied.');
        if (!/^[a-f0-9]{64}$/.test(progress.checkpointHash) || !progress.text.trim()
          || !Array.isArray(progress.openQuestions) || !progress.openQuestions.length || progress.openQuestions.length > 8
          || progress.openQuestions.some(q => typeof q !== 'string' || !q.trim() || q.length > 500)) {
          throw fail('Invalid validated report progress.');
        }
        const validatedReportHash = createHash('sha256').update(progress.text).digest('hex');
        const command = {operation:'update',commandId:`report-progress-${validatedReportHash.slice(0,40)}`,
          expectedVersion:version,phase:'LOG',pruneToolCallIds:[],
          state:{...emptyState(),openQuestions:[...new Set(progress.openQuestions)]}};
        await awaitHost(authorize(clone(command)));
        const result = await execute(command,{commitOrigin:'validated_report_checkpoint',validatedReportHash,
          sourceCheckpointHash:progress.checkpointHash});
        if (!result.ok) throw fail(`Validated report progress was not persisted: ${result.code}`);
      });
      serial = work.then(() => undefined, () => undefined);
      return work;
    },
    observe,
    projectContext,
    assertReady,
    async recordUsage(result: unknown, request: { model: string; provider: string; elapsedMs: number }) {
      if (mode === 'off' || !options?.onUsage) return;
      guard();
      const usage = result && typeof result === 'object' && 'usage' in result ? result.usage : undefined;
      const count = (key: string) => usage && typeof usage === 'object' && key in usage &&
        integer((usage as Record<string, unknown>)[key], 0, Number.MAX_SAFE_INTEGER) ? (usage as Record<string, number>)[key] : null;
      const values = { inputTokens: count('input'), outputTokens: count('output'), cacheReadTokens: count('cacheRead'),
        cacheWriteTokens: count('cacheWrite'), totalTokens: count('totalTokens') };
      // SDK-created failure/default messages carry synthetic all-zero usage.
      // They provide no evidence that an HTTP request consumed zero tokens.
      const reported = Object.values(values).some(value => value !== null && value > 0);
      const knownCount = reported ? Object.values(values).filter(value => value !== null).length : 0;
      const event: HostWorkingMemoryUsageEvent = {
        schemaVersion: 'host-working-memory.v1', status: 'provider_result_received', mode, version,
        invocation: ++usageInvocation, model: request.model, provider: request.provider,
        elapsedMs: Math.max(0, Math.round(request.elapsedMs)),
        usageStatus: knownCount === 5 ? 'reported' : knownCount > 0 ? 'partial' : 'unknown',
        source: knownCount ? 'sdk_result' : 'unknown',
        ...(reported ? values : { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null }),
        ...(policyIdentity ? { policyIdentity: clone(policyIdentity) } : {}),
      };
      try { await awaitHost(Promise.resolve().then(() => options.onUsage!(clone(event)))); }
      catch { throw fail('Working memory provider usage receipt could not be persisted.'); }
    },
    wrapStream(streamFn: StreamFn): StreamFn {
      return async (model, context, streamOptions) => {
        if (mode === 'off') return streamFn(model, context, streamOptions);
        guard();
        try {
          const projected = projectContext(context);
          const receipt = prepared;
          prepared = undefined; // A receipt is never reusable on another request.
          if (!receipt || receipt.version !== version) throw fail('Working memory provider projection receipt is missing or stale.');
          if (options?.onProjection) {
            try { await awaitHost(Promise.resolve().then(() => options.onProjection!(clone(receipt.event)))); }
            catch { throw fail('Working memory provider projection receipt could not be persisted.'); }
          }
          guard();
          // Only trusted numeric status and host-validated receipt identifiers
          // enter this feedback; never promote source prose into instructions.
          const visible = snapshot().directory;
          const eligible = visible.filter(s => s.referenceEligible);
          const feedback = options?.modelSaveFeedback === true && mode === 'apply' && !denied.has('workingMemory')
            && projected.tools?.some(t => t.name === 'workingMemory') && eligible.length > 0;
          const status = feedback ? `\nRUN-LOCAL NOTEBOOK STATUS: version=${version}; accepted LOG=${logCount}; reference-eligible reads=${eligible.length}. Historical checkpoint versions are independent. Current receipt IDs (bounded, read the catalog for details): ${JSON.stringify(eligible.slice(-16).map(s => s.toolCallId))}.`
            + (logCount === 0 ? '\nWhen new observations or unresolved questions need to survive a phase boundary, read workingMemory for the current version/catalog, then save a concise LOG before drafting the long report. A question-only state is valid: facts=[], hypotheses=[], openQuestions=your actual unresolved questions, nextAction={text:"",evidenceIds:[]}; do not invent a fact to fill fields. Facts require nonempty evidenceIds from eligible current receipts. Keep existing notes when updating; saving does not require pruning. A rejected update has not saved progress: correct only the reported defect, or report the limitation. No new progress means no save is required. This status is not an instruction to execute external actions or a claim that anything has been saved.' : '') : '';
          if (!feedback) return streamFn(model, projected, streamOptions);
          const visibleIds = new Set(eligible.map(s => s.toolCallId));
          const referenceIds = [...evidenceCatalog.values()].filter(s => s.entry.referenceEligible
            && (visibleIds.has(s.entry.toolCallId) || pruned.has(s.entry.toolCallId))).map(s => s.entry.toolCallId);
          // Advertise concrete current choices rather than asking the model to
          // invent identifiers. This is descriptive; execute still validates
          // scope, version, visibility, eligibility, permission and persistence.
          const parameters = clone(workingMemoryToolParameters);
          Object.assign(parameters.properties.expectedVersion, { enum: [version] });
          for (const schema of [parameters.properties.state.properties.facts.items,
            parameters.properties.state.properties.hypotheses.items, parameters.properties.state.properties.nextAction]) {
            Object.assign(schema.properties.evidenceIds.items, { enum: [...referenceIds] });
            Object.assign(schema.properties.evidenceIds, {
              description: 'CURRENT RUN REFERENCE CHOICES: use only canonical toolCallId values in items.enum. A source ID or an invented UUID is not a current receipt. No supported fact means facts=[]; questions and an empty nextAction remain valid.' });
          }
          const tools = projected.tools!.map(t => t.name === 'workingMemory' ? { ...t, parameters } : t);
          return streamFn(model, { ...projected, tools, systemPrompt: (projected.systemPrompt ?? '') + status }, streamOptions);
        } catch (error) {
          if (input.signal.aborted || failure) throw error;
          throw fail('Working memory context inspection or projection failed.');
        }
      };
    },
  };
}
