import { db, withDatabaseTransaction } from '@/lib/db/client';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { withMemoryRecordWrite } from '../revision/transaction';
import { readFileBindingForShare, type FileReadAuthority } from '../adapters/postgres/file-bindings';
import { persistArtifactRead } from '../adapters/postgres/artifacts';
import { prepareFilePhysical, physicalTicketBytes, assertPhysicalTicket } from './physical';
import { admitExactUse, type ExactUsePolicy } from '../context/exact-use-admission';
import { currentExactUseReaderPolicy } from '../context/exact-use';
import { exactUseRegistrationRequired, registerExactUseForDispatch } from '../context/dispatch';
import { MemoryModuleError } from '../kernel/errors';
import { readWorkFileInput, parseFileInput, type FileBindingRef, type FilePermission } from './contracts';
import { ExecutionLeaseError } from '@/lib/work-runtime/execution-errors';
import { MemoryWriteBusy } from '../kernel/reference-errors';

function authority(sourceId: string, permission: FilePermission, tool: FileBindingRef['tool']) {
  const lease = resolveExecutionLease(), policy = currentExactUseReaderPolicy();
  if (!lease || policy && (policy.requester.userId !== lease.userId || policy.requester.type === 'chat'
    || (policy.requester.type === 'work' ? policy.requester.id : policy.requester.workId) !== lease.workshopId))
    throw new MemoryModuleError('work_file_unavailable', 403, 'A current matching Work execution capability is required');
  return { lease, policy: policy ?? { requester: { type: 'work', userId: lease.userId, id: lease.workshopId }, purpose: 'registered_work_file_read' } satisfies ExactUsePolicy,
    authority: { userId: lease.userId, workId: lease.workshopId, sourceId, permission, tool } satisfies FileReadAuthority };
}
/** Metadata is a retrieval lead. A virtual input path never authorizes raw FS. */
export async function describeWorkFileSource(sourceId: string) {
  const context = authority(sourceId, 'read', 'Read');
  let current: Awaited<ReturnType<typeof readFileBindingForShare>>;
  try { current = await db.transaction(store => readFileBindingForShare(store, context.authority)); }
  catch {
    const convert = authority(sourceId, 'convert', 'workshopConvertDocument');
    current = await db.transaction(store => readFileBindingForShare(store, convert.authority));
  }
  return { sourceId, bindingId: current.binding.id, artifactId: current.manifest.id, revision: current.revision, name: current.manifest.name,
    size: current.manifest.sizeBytes, sha256: current.manifest.sha256,
    runPath: `inputs/${sourceId}/${current.manifest.name.replace(/[\\/]/g, '_')}`, semantics: 'owner_bound_imported_snapshot' as const };
}
/** Binary bytes stay inside the converter; the public Read surface is bounded text. */
export async function readWorkFileBytes(sourceId: string, options: { permission: FilePermission; tool: FileBindingRef['tool']; expectedRevision?: string; textOffset?: number }) {
  const context = authority(sourceId, options.permission, options.tool);
  // Reject unsupported/closed model scopes before object IO or returning a body.
  const register = exactUseRegistrationRequired();
  const physical = await prepareFilePhysical(context.authority, options.expectedRevision), bytes = physicalTicketBytes(physical);
  let window: { content: string; actualRange: { unit: 'utf16'; start: number; end: number }; totalCharacters: number; nextOffset: number | null } | undefined;
  if (options.textOffset !== undefined) {
    if (!physical.contentType.startsWith('text/') && physical.contentType !== 'application/json')
      throw new MemoryModuleError('work_file_conversion_required', 415, 'Use the separately permitted document conversion tool for this bound binary file');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MemoryModuleError('file_source_integrity_unavailable', 503, 'The bound file is not valid UTF-8 text'); }
    const start = options.textOffset;
    if (start > content.length || start > 0 && /[\uDC00-\uDFFF]/.test(content[start] ?? '') && /[\uD800-\uDBFF]/.test(content[start - 1]))
      throw new MemoryModuleError('invalid_memory_request', 400, 'Invalid UTF-16 file window boundary');
    let end = Math.min(content.length, start + 8000);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
    window = { content: content.slice(start, end), actualRange: { unit: 'utf16', start, end }, totalCharacters: content.length, nextOffset: end < content.length ? end : null };
  }
  return withDatabaseTransaction(async () => {
    const receipt = await withMemoryRecordWrite(context.lease.userId, 'context_log', async store => {
      const current = await readFileBindingForShare(store, context.authority); assertPhysicalTicket(physical, context.authority, current);
      const saved = await persistArtifactRead(store, current.manifest, { start: 0, end: bytes.byteLength }, 'evidence');
      return { id: saved.id, result: saved };
    });
    const ref: FileBindingRef = { kind: 'file-binding', id: physical.bindingId, revision: physical.revision,
      artifactId: physical.artifactId, artifactRevision: physical.artifactRevision, evidenceReceiptId: receipt.id,
      start: 0, end: bytes.byteLength, permission: options.permission, tool: options.tool };
    const proof = await admitExactUse({ ...context.policy, fileBindings: [{ ...ref, physicalTicket: physical }] });
    if (register) registerExactUseForDispatch(proof);
    return { bytes, ref, receiptId: proof.receiptId, artifactReceiptId: receipt.id, name: physical.name, contentType: physical.contentType,
      sha256: physical.sha256, semantics: 'owner_bound_imported_snapshot' as const, window };
  }).catch(error => {
    if (error instanceof MemoryModuleError || error instanceof ExecutionLeaseError || error instanceof MemoryWriteBusy) throw error;
    throw new MemoryModuleError('file_source_unavailable', 503, 'The bound file read, current authority or its audit could not be completed');
  });
}
export async function readWorkFile(value: unknown) {
  const query = parseFileInput(readWorkFileInput, value);
  const read = await readWorkFileBytes(query.sourceId, { permission: 'read', tool: 'Read', expectedRevision: query.expectedRevision, textOffset: query.offset ?? 0 });
  const { bytes: _bytes, window, ...receipt } = read;
  return { status: 'read' as const, sourceId: query.sourceId, ...receipt, ...window!,
    warning: 'A fixed imported snapshot; the original workspace file is not asserted current. Reimport and rebind to adopt a changed original.' };
}
