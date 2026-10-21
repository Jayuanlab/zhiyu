import { createHash } from 'node:crypto';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { WorkingMemoryDirectoryEntry, WorkingMemoryReadCautionRule } from './host-working-memory';

export interface ObservedWorkingMemorySource {
  resultIndex: number;
  fingerprint: string;
  entry: Omit<WorkingMemoryDirectoryEntry, 'projected'>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/|+-]{0,255}$/;
const identityKeys = new Set(['evidenceId', 'sourceEventId', 'evidenceEventId', 'contentHash', 'rawHash', 'url', 'source',
  'finalUrl', 'finalUrlVerified', 'retrievedAt', 'fetchedAt', 'offset', 'nextOffset', 'contentLength', 'truncated', 'totalChars', 'sourceVersion', 'sha256', 'path']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Successful observations and removable text are different capabilities. */
function inspectResult(result: ToolResultMessage, rule?: WorkingMemoryReadCautionRule) {
  const reasons = new Set<string>();
  let referenceEligible = true;
  const sourceIdentity: WorkingMemoryDirectoryEntry['sourceIdentity'] = { observedAt: result.timestamp };
  let identityConflict = false;
  const identity = (key: string, value: string | number | boolean) => {
    if (sourceIdentity[key] !== undefined && sourceIdentity[key] !== value) identityConflict = true;
    else sourceIdentity[key] = value;
  };
  const codes = new Set<string>(), texts = new Set<string>();
  const retainedCodes = new Set<string>(), retainedTexts = new Set<string>();
  let provider: string | undefined, detail: string | undefined;
  const block = (reason: string, prohibitsReference = false) => {
    reasons.add(reason);
    if (prohibitsReference) referenceEligible = false;
  };
  const warning = (value: unknown, isCode: boolean) => {
    if (value === undefined || value === null || value === '' || value === false) return;
    if (typeof value !== 'string') { block('unrecognized_warning'); return; }
    const target = isCode ? codes : texts;
    if (target.size < 16) target.add(value.slice(0, 2000));
    else block('warning_metadata_limit');
    if (value.length > 2000) block('warning_metadata_limit');
    if (rule?.warningCodes.includes(value)) retainedCodes.add(value);
    else if (rule?.warningTexts.includes(value)) retainedTexts.add(value);
    else block(/fallback/i.test(value) ? 'fallback_warning' : 'source_warning');
  };
  const inspect = (value: unknown, depth: number, identityEligible = true): void => {
    if (!value || typeof value !== 'object') return;
    if (depth > 8) { block('inspection_depth_limit', true); return; }
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1, false); return; }
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[_-]/g, '');
      if (identityEligible && identityKeys.has(key) && (typeof child === 'string' || typeof child === 'boolean' ||
        typeof child === 'number' && Number.isFinite(child))) identity(key, typeof child === 'string' ? child.slice(0, 2000) : child);
      if (identityEligible && normalized === 'content' && typeof child === 'string') identity('contentLength', child.length);
      if (identityEligible && normalized === 'provider' && typeof child === 'string') provider = child.slice(0, 128);
      if (identityEligible && normalized === 'detail' && typeof child === 'string') detail = child.slice(0, 256);
      if (['denied', 'requireapproval', 'requiresapproval', 'approvalrequired', 'awaitingapproval', 'pendingapproval'].includes(normalized) && child === true) block('approval_or_denial', true);
      if (normalized === 'iserror' && child === true || ['ok', 'success', 'allowed'].includes(normalized) && child === false) block('failed_result', true);
      if (['error', 'approval', 'permissionrequest'].includes(normalized) && child !== undefined && child !== null && child !== '' && child !== false) block('control_or_error_result', true);
      if (normalized === 'finalurlverified' && child === false) block('redirect_unverified');
      if (['degraded', 'fallback', 'partial'].includes(normalized) && child === true) block('degraded_source');
      if (normalized === 'fallbackerrors' && (Array.isArray(child) ? child.length > 0 : !!child)) block('fallback_warning');
      if (normalized === 'warning') warning(child, false);
      if (normalized === 'warnings') {
        if (Array.isArray(child)) for (const item of child) warning(item, true);
        else warning(child, true);
      }
      if (['status', 'decision', 'behavior'].includes(normalized) && typeof child === 'string') {
        if (/^(error|failed|failure|denied|deny|blocked|aborted|pending|pending_approval|needs_approval|require_approval|requires_approval|awaiting_approval)$/i.test(child)) block('control_or_error_result', true);
        if (/^(degraded|partial)$/i.test(child)) block('degraded_source');
      }
      if (normalized === 'detail' && typeof child === 'string' && /^(provider|fetch|read|source)[_-](failed|unavailable|error)$/i.test(child)) block('failed_result', true);
      inspect(child, depth + 1, identityEligible && ['result', 'data', 'receipt', 'sourceIdentity'].includes(key));
    }
  };
  if (result.isError !== false) block('failed_result', true);
  if (result.addedToolNames?.length) block('control_result', true);
  if (result.content.some(item => item.type !== 'text')) block('non_text_result');
  inspect(result.details, 0);
  for (const item of result.content) {
    if (item.type !== 'text') continue;
    if (/\b(permission denied|access denied|approval required|awaiting approval|tool denied|read failed|provider unavailable)\b/i.test(item.text)) block('control_or_error_result', true);
    try { inspect(JSON.parse(item.text), 0); } catch { /* Literal source text remains an observation. */ }
  }
  if (identityConflict) block('source_identity_conflict');
  return { referenceEligible, projectionBlockedReasons: [...reasons], sourceIdentity,
    sourceIdentityStatus: identityConflict ? 'conflicting' as const : Object.keys(sourceIdentity).length > 1 ? 'reported' as const : 'missing' as const, provider, detail,
    ...(codes.size || texts.size ? { sourceCautions: { warningCodes: [...codes], warningTexts: [...texts] } } : {}),
    ...(retainedCodes.size || retainedTexts.size ? { retainedCautions: { warningCodes: [...retainedCodes], warningTexts: [...retainedTexts] } } : {}) };
}

/** Only host-listed reads enter the evidence catalog. Business and management
 * results stay in the protocol but can never be selected by the memory tool. */
export function observeWorkingMemorySources(messages: Message[], allowed: Set<string>, denied: Set<string>,
  rules: Map<string, WorkingMemoryReadCautionRule>): Map<string, ObservedWorkingMemorySource> {
  const counts = new Map<string, { calls: number; results: number }>();
  const count = (id: string, type: 'calls' | 'results') => {
    const item = counts.get(id) ?? { calls: 0, results: 0 };
    item[type] += 1; counts.set(id, item);
  };
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') count(block.id, 'calls');
    if (message.role === 'toolResult') count(message.toolCallId, 'results');
  }
  const catalog = new Map<string, ObservedWorkingMemorySource>();
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant.role !== 'assistant') continue;
    const calls = assistant.content.filter((block): block is ToolCall => block.type === 'toolCall');
    const groupIds = calls.map(call => call.id);
    const following = messages.slice(index + 1, index + 1 + calls.length);
    const results = following.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    const complete = calls.length > 0 && calls.length <= 64 && results.length === calls.length &&
      calls.every(call => idPattern.test(call.id) && counts.get(call.id)?.calls === 1 && counts.get(call.id)?.results === 1 &&
        results.some(result => result.toolCallId === call.id && result.toolName === call.name));
    for (const call of calls) {
      if (!idPattern.test(call.id) || !allowed.has(call.name) || call.name === 'workingMemory') continue;
      const matching = results.find(result => result.toolCallId === call.id && result.toolName === call.name);
      const resultIndex = matching ? messages.indexOf(matching, index + 1) : -1;
      const inspected = matching ? inspectResult(matching, rules.get(call.name)) : {
        referenceEligible: false, projectionBlockedReasons: ['incomplete_pair'], sourceIdentity: {},
      };
      const reasons = new Set(inspected.projectionBlockedReasons);
      let referenceEligible = inspected.referenceEligible;
      if (!complete) { reasons.add('incomplete_pair'); referenceEligible = false; }
      if (assistant.stopReason !== 'toolUse' || assistant.errorMessage) { reasons.add('invalid_assistant_result'); referenceEligible = false; }
      if (denied.has(call.name) || denied.has('*')) { reasons.add('denied_tool'); referenceEligible = false; }
      const contentHash = matching ? digest(matching.content) : digest(null);
      const entry = { toolCallId: call.id, toolName: call.name, groupToolCallIds: [...groupIds],
        characters: matching ? JSON.stringify(matching.content).length : 0, contentHash, ...inspected,
        referenceEligible, projectionEligible: referenceEligible && reasons.size === 0, projectionBlockedReasons: [...reasons] };
      // A duplicate ID can be inspected, but never supports a note or projection.
      catalog.set(call.id, { resultIndex, fingerprint: digest([assistant, matching ?? null]), entry });
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const result = messages[index];
    if (result.role !== 'toolResult' || !allowed.has(result.toolName) || result.toolName === 'workingMemory' ||
      !idPattern.test(result.toolCallId) || catalog.has(result.toolCallId)) continue;
    const inspected = inspectResult(result, rules.get(result.toolName));
    catalog.set(result.toolCallId, { resultIndex: index, fingerprint: digest(result), entry: {
      toolCallId: result.toolCallId, toolName: result.toolName, groupToolCallIds: [],
      characters: JSON.stringify(result.content).length, contentHash: digest(result.content), ...inspected,
      referenceEligible: false, projectionEligible: false,
      projectionBlockedReasons: [...new Set([...inspected.projectionBlockedReasons, 'incomplete_pair',
        ...(denied.has(result.toolName) || denied.has('*') ? ['denied_tool'] : [])])],
    } });
  }
  return catalog;
}

/** Model-facing placeholder; raw assistant blocks and result identity are
 * unchanged. The original content/details stay exclusively in the transcript. */
export function projectWorkingMemorySource(message: ToolResultMessage, source: ObservedWorkingMemorySource): ToolResultMessage {
  const receipt = { schemaVersion: 'host-projected-source.v1', authority: 'host-context-projection',
    toolCallId: message.toolCallId, toolName: message.toolName, contentHash: source.entry.contentHash,
    sourceIdentity: source.entry.sourceIdentity, provider: source.entry.provider, detail: source.entry.detail,
    sourceCautions: source.entry.sourceCautions, originalCharacters: source.entry.characters,
    recovery: 'workingMemory operation=restore restores the exact original result in this run without re-executing tools',
    warning: 'Original result body is omitted from this provider input. This placeholder is not the original tool return or verified evidence. Consult cited non-authoritative working notes or restore the original.' };
  return { ...message, content: [{ type: 'text', text: `HOST-PROJECTED SOURCE BODY\n${JSON.stringify(receipt)}` }], details: receipt };
}
