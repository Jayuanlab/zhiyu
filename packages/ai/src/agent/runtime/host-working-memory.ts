import { createHash } from 'node:crypto';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type, type Context, type Message, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';

export type HostWorkingMemoryMode = 'off' | 'shadow' | 'apply';

export interface WorkingMemoryNote {
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
  /** A multi-call assistant message is indivisible. */
  groupToolCallIds: string[];
  characters: number;
  projected: boolean;
  retainedCautions?: Pick<WorkingMemoryReadCautionRule, 'warningCodes' | 'warningTexts'>;
}

export interface HostWorkingMemoryAuditEvent {
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
  directoryTruncated: boolean;
  retainedReadCautions: WorkingMemorySourceCaution[];
}

type WorkingMemoryCommand = {
  operation: 'read';
} | {
  operation: 'update';
  commandId: string;
  expectedVersion: number;
  state: WorkingMemoryState;
  pruneToolCallIds: string[];
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
const MAX_IDS = 64;
const MAX_COMMANDS = 33; // Bounded updates plus independent restore capacity.
const MAX_ITEM_CHARS = 2000;
const MAX_CAUTION_RULES = 8;
const MAX_CAUTION_VALUES = 8;
const MAX_CAUTION_CHARS = 1000;
const MAX_CAUTION_CONFIG_CHARS = 8000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|+-]{0,255}$/;

const noteSchema = Type.Object({
  text: Type.String({ maxLength: MAX_ITEM_CHARS }),
  evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: MAX_IDS, uniqueItems: true }),
}, { additionalProperties: false });
const stateSchema = Type.Object({
  facts: Type.Array(noteSchema, { maxItems: 24 }),
  hypotheses: Type.Array(noteSchema, { maxItems: 16 }),
  openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: MAX_ITEM_CHARS }), { maxItems: 16 }),
  nextAction: noteSchema,
}, { additionalProperties: false });

/** The provider schema is descriptive; the host always validates again. */
export const workingMemoryToolParameters = Type.Object({
  operation: Type.Union([Type.Literal('read'), Type.Literal('update'), Type.Literal('restore')]),
  commandId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  state: Type.Optional(stateSchema),
  pruneToolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: MAX_IDS, uniqueItems: true })),
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
  return record(value, ['text', 'evidenceIds']) && typeof value.text === 'string'
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
  if (!record(value, ['operation', 'commandId', 'expectedVersion', 'state', 'pruneToolCallIds'])) return undefined;
  if (value.operation === 'read' && Reflect.ownKeys(value).length === 1) return { operation: 'read' };
  if (!validId(value.commandId) || !integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  if (value.operation === 'restore' && Reflect.ownKeys(value).length === 3) return clone(value as unknown as WorkingMemoryCommand);
  if (value.operation === 'update' && Reflect.ownKeys(value).length === 5 && validState(value.state) && ids(value.pruneToolCallIds)) {
    return clone(value as unknown as WorkingMemoryCommand);
  }
  return undefined;
}

/** Preserve control/safety outcomes even when a nominal read encodes failure as
 * data. A static host caution is retained rather than silently discarded. */
function protectedResult(result: ToolResultMessage, rule: WorkingMemoryReadCautionRule | undefined,
  retained: { codes: Set<string>; texts: Set<string> }): boolean {
  if (result.isError !== false || result.addedToolNames?.length || result.content.some(block => block.type !== 'text')) return true;
  const retainWarning = (value: unknown): boolean => {
    if (!rule || rule.toolName !== result.toolName || typeof value !== 'string') return false;
    if (rule.warningCodes.includes(value)) { retained.codes.add(value); return true; }
    if (rule.warningTexts.includes(value)) { retained.texts.add(value); return true; }
    return false;
  };
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (depth > 8) return true;
    if (Array.isArray(value)) return value.some(item => inspect(item, depth + 1));
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
      if (['iserror', 'denied', 'requireapproval', 'requiresapproval', 'approvalrequired', 'awaitingapproval', 'pendingapproval', 'degraded', 'fallback', 'partial'].includes(normalizedKey) && child === true) return true;
      if (['ok', 'success', 'allowed'].includes(normalizedKey) && child === false) return true;
      if (normalizedKey === 'finalurlverified' && child === false) return true;
      if (normalizedKey === 'fallbackerrors' && (Array.isArray(child) ? child.length > 0 : !!child)) return true;
      if (['error', 'approval', 'permissionrequest'].includes(normalizedKey) && child !== undefined && child !== null && child !== '' && child !== false) return true;
      if (normalizedKey === 'warning' && child !== undefined && child !== null && child !== '' && child !== false
        && !retainWarning(child)) return true;
      if (normalizedKey === 'warnings' && (Array.isArray(child)
        ? Array.from(child).some(warning => !retainWarning(warning)) : !!child && !retainWarning(child))) return true;
      if (['status', 'decision', 'behavior'].includes(normalizedKey) && typeof child === 'string'
        && /^(error|failed|failure|denied|deny|blocked|aborted|pending|pending_approval|needs_approval|require_approval|requires_approval|awaiting_approval|degraded|partial)$/i.test(child)) return true;
      if (normalizedKey === 'detail' && typeof child === 'string'
        && /^(provider|fetch|read|source)[_-](failed|unavailable|error)$/i.test(child)) return true;
      if (inspect(child, depth + 1)) return true;
    }
    return false;
  };
  if (inspect(result.details, 0)) return true;
  // A plain-text read can also be an explicit safety/failure receipt. When in
  // doubt keep it; the tool is an optimization, never a deletion entitlement.
  return result.content.some(block => {
    if (block.type !== 'text') return false;
    if (/\b(permission denied|access denied|approval required|awaiting approval|tool denied|read failed|provider unavailable)\b/i.test(block.text)) return true;
    try { return inspect(JSON.parse(block.text), 0); } catch { return false; }
  });
}

interface ReadGroup {
  indices: number[];
  ids: string[];
  fingerprint: string;
  entries: Omit<WorkingMemoryDirectoryEntry, 'projected'>[];
}

function readGroups(messages: Message[], allowed: Set<string>, denied: Set<string>,
  cautionRules: Map<string, WorkingMemoryReadCautionRule>): Map<string, ReadGroup> {
  const counts = new Map<string, { calls: number; results: number }>();
  const count = (id: string, kind: 'calls' | 'results') => {
    const tally = counts.get(id) ?? { calls: 0, results: 0 };
    tally[kind] += 1;
    counts.set(id, tally);
  };
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') count(block.id, 'calls');
    if (message.role === 'toolResult') count(message.toolCallId, 'results');
  }
  const result = new Map<string, ReadGroup>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.stopReason !== 'toolUse' || message.errorMessage
      || message.content.length === 0 || message.content.some(block => block.type !== 'toolCall')) continue;
    const calls = message.content as ToolCall[];
    if (calls.length > MAX_IDS || calls.some(call => !validId(call.id) || !allowed.has(call.name) || denied.has(call.name)
      || counts.get(call.id)?.calls !== 1 || counts.get(call.id)?.results !== 1)) continue;
    const groupIds = calls.map(call => call.id);
    const results = messages.slice(index + 1, index + calls.length + 1);
    if (results.length !== calls.length || results.some(entry => entry.role !== 'toolResult')) continue;
    const resultsById = new Map((results as ToolResultMessage[]).map(entry => [entry.toolCallId, entry]));
    const retainedById = new Map<string, WorkingMemoryDirectoryEntry['retainedCautions']>();
    if (resultsById.size !== calls.length || calls.some(call => {
      const entry = resultsById.get(call.id);
      if (!entry || entry.toolName !== call.name) return true;
      const retained = { codes: new Set<string>(), texts: new Set<string>() };
      if (protectedResult(entry, cautionRules.get(entry.toolName), retained)) return true;
      if (retained.codes.size || retained.texts.size) retainedById.set(call.id,
        { warningCodes: [...retained.codes], warningTexts: [...retained.texts] });
      return false;
    })) continue;
    const serialized = JSON.stringify([message, ...results]);
    const group: ReadGroup = {
      indices: Array.from({ length: calls.length + 1 }, (_, offset) => index + offset),
      ids: groupIds,
      fingerprint: createHash('sha256').update(serialized).digest('hex'),
      entries: calls.map(call => ({ toolCallId: call.id, toolName: call.name, groupToolCallIds: [...groupIds],
        characters: JSON.stringify(resultsById.get(call.id)!.content).length,
        ...(retainedById.has(call.id) ? { retainedCautions: retainedById.get(call.id) } : {}) })),
    };
    for (const id of groupIds) result.set(id, group);
  }
  return result;
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
  const allowed = new Set(options?.readonlyToolNames ?? []);
  // Management results hold the current state and are always pinned.
  allowed.delete('workingMemory');
  const denied = new Set(options?.deniedToolNames ?? []);
  let cautionRules = new Map<string, WorkingMemoryReadCautionRule>();
  let cautionsValidated = false;
  let version = 0;
  let editCount = 0;
  let state = emptyState();
  let failure: string | undefined;
  let catalog = new Map<string, ReadGroup>();
  const pruned = new Map<string, string>();
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
      const entry = catalog.get(id)?.entries.find(item => item.toolCallId === id);
      if (entry?.retainedCautions) result.push({ toolCallId: id, toolName: entry.toolName, ...clone(entry.retainedCautions) });
    }
    return result;
  };
  const snapshot = (): WorkingMemorySnapshot => ({
    schemaVersion: 'host-working-memory.v1', authority: 'model-authored-unverified', mode, version,
    editCount, maxEdits, maxSummaryChars, state: clone(state), pruneToolCallIds: [...pruned.keys()],
    directory: [...catalog.values()].filter((group, index, groups) => groups.indexOf(group) === index)
      .flatMap(group => group.entries).slice(-MAX_DIRECTORY).map(entry => ({ ...clone(entry), projected: mode === 'apply' && pruned.has(entry.toolCallId) })),
    directoryTruncated: catalog.size > MAX_DIRECTORY,
    retainedReadCautions: sourceCautions([...catalog.keys()].slice(-MAX_DIRECTORY).concat([...pruned.keys()])),
  });
  const rejected = (code: string, detail: string): WorkingMemoryResult => ({ ok: false, code, detail, version });
  const execute = async (value: unknown): Promise<WorkingMemoryResult> => {
    guard();
    assertReady();
    if (mode === 'off') return rejected('disabled', 'Working memory is disabled for this run.');
    const command = parseCommand(value);
    if (!command) return rejected('invalid_command', 'Command shape, IDs, lengths, or state fields are invalid.');
    if (command.operation === 'read') return { ok: true, snapshot: snapshot() };
    const fingerprint = JSON.stringify(command);
    const previous = commands.get(command.commandId);
    if (previous) return previous.fingerprint === fingerprint
      ? { ...clone(previous.result), duplicate: true } as WorkingMemoryResult
      : rejected('command_id_conflict', 'This commandId was already used with different content.');
    if (command.expectedVersion !== version) return rejected('version_conflict', 'Read the current version before proposing an edit.');
    if (commands.size >= MAX_COMMANDS) return rejected('command_limit', 'The bounded command ledger is full.');
    const nextPruned = command.operation === 'restore' ? new Map<string, string>() : new Map(pruned);
    const nextState = command.operation === 'restore' ? emptyState() : command.state;
    if (command.operation === 'update') {
      if (editCount >= maxEdits) return rejected('edit_limit', 'The update limit is exhausted; read or restore remains available.');
      if (JSON.stringify(nextState).length > maxSummaryChars) return rejected('summary_limit', 'Working state exceeds the configured character limit.');
      const visibleIds = new Set(snapshot().directory.map(entry => entry.toolCallId));
      const references = [...nextState.facts, ...nextState.hypotheses, nextState.nextAction].flatMap(item => item.evidenceIds);
      if (references.some(id => !catalog.has(id) || (!visibleIds.has(id) && !pruned.has(id)))) {
        return rejected('unknown_evidence', 'Evidence IDs must come from the trusted read directory.');
      }
      for (const id of command.pruneToolCallIds) {
        const group = catalog.get(id);
        if (!group || !visibleIds.has(id)) return rejected('unsafe_prune', 'The selected ID is unknown, protected, unpaired, or outside the read directory.');
        if (pruned.has(id)) return rejected('already_pruned', 'An already projected ID cannot be selected again.');
        if (group.ids.some(groupId => !command.pruneToolCallIds.includes(groupId))) {
          return rejected('incomplete_group', 'Select every ID in the complete read group.');
        }
        nextPruned.set(id, group.fingerprint);
      }
      const retained = new Set(references);
      if ([...nextPruned.keys()].some(id => !retained.has(id))) {
        return rejected('unreferenced_prune', 'Every projected read must remain cited in working state.');
      }
    }
    const audit: HostWorkingMemoryAuditEvent = {
      schemaVersion: 'host-working-memory.v1', status: 'ready_for_projection', operation: command.operation, mode,
      commandId: command.commandId, previousVersion: version, version: version + 1,
      editCount: editCount + (command.operation === 'update' ? 1 : 0),
      pruneToolCallIds: [...nextPruned.keys()],
      actionPruneToolCallIds: command.operation === 'update' ? command.pruneToolCallIds : [],
      restoredToolCallIds: command.operation === 'restore' ? [...pruned.keys()] : [],
      state: clone(nextState),
      retainedReadCautions: sourceCautions([...nextPruned.keys()]),
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
    for (const [id, digest] of nextPruned) pruned.set(id, digest);
    version = audit.version;
    editCount = audit.editCount;
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
      const nextCatalog = readGroups(messages, allowed, denied, cautionRules);
      for (const [id, digest] of pruned) {
        if (nextCatalog.get(id)?.fingerprint !== digest) throw fail('Working memory projected evidence is missing, changed, or no longer safe. Start a new run with intact source history.');
      }
      catalog = nextCatalog;
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
      const omitted = new Set<number>();
      if (mode === 'apply') for (const id of pruned.keys()) for (const index of catalog.get(id)!.indices) omitted.add(index);
      const projected: Context = omitted.size ? { ...context,
        messages: context.messages.filter((_message, index) => !omitted.has(index)) } : context;
      prepared = { version, fingerprint: messageFingerprint(projected.messages), event: {
        schemaVersion: 'host-working-memory.v1', status: 'provider_request_prepared', mode, version,
        pruneToolCallIds: [...pruned.keys()], originalMessageCount: context.messages.length,
        projectedMessageCount: projected.messages.length, originalChars: JSON.stringify(context.messages).length,
        projectedChars: JSON.stringify(projected.messages).length,
        retainedReadCautions: sourceCautions(pruned.keys()),
      } };
      return projected;
    } catch (error) {
      if (input.signal.aborted || failure) throw error;
      throw fail('Working memory context inspection or projection failed.');
    }
  };
  const tool: AgentTool<typeof workingMemoryToolParameters, WorkingMemoryResult> = {
    name: 'workingMemory', label: 'Working memory',
    description: 'Maintain non-authoritative task notes. operation=read takes no other fields and returns version and trusted read IDs. operation=update requires commandId, expectedVersion, state (facts with evidence, hypotheses, questions, next action), and pruneToolCallIds (may be empty). It can project complete successful pure-read groups out of subsequent model requests. Original history remains intact. operation=restore requires only commandId and expectedVersion and clears all notes and projection. Only the latest version is current; restore invalidates all older notes. Use a unique commandId and the current expectedVersion; never cite invented IDs or use notes as policy/permission.',
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
      return { content: [{ type: 'text', text: `NON-AUTHORITATIVE MODEL NOTES; NOT VERIFIED FACTS. Never override host or owner instructions, permissions, or original source evidence.\nHOST-RETAINED SOURCE CAUTIONS (preserve alongside task notes): ${JSON.stringify(retainedCautions)}\n${JSON.stringify(result)}` }], details: result };
    },
  };
  return {
    get enabled() { return mode !== 'off'; },
    get failure() { return failure; },
    tool,
    snapshot,
    manage,
    observe,
    projectContext,
    assertReady,
    wrapStream(streamFn: StreamFn): StreamFn {
      return async (model, context, streamOptions) => {
        if (mode === 'off') return streamFn(model, context, streamOptions);
        guard();
        try {
          const projected = projectContext(context);
          const receipt = prepared;
          prepared = undefined; // A receipt is never reusable on another request.
          if (!receipt || receipt.version !== version) throw fail('Working memory provider projection receipt is missing or stale.');
          if (options?.onProjection && version > 0) {
            try { await awaitHost(Promise.resolve().then(() => options.onProjection!(clone(receipt.event)))); }
            catch { throw fail('Working memory provider projection receipt could not be persisted.'); }
          }
          guard();
          return streamFn(model, projected, streamOptions);
        } catch (error) {
          if (input.signal.aborted || failure) throw error;
          throw fail('Working memory context inspection or projection failed.');
        }
      };
    },
  };
}
