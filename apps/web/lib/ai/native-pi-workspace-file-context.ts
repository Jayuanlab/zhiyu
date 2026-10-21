import { unregisteredFileSource } from "@/lib/memory/evidence/unregistered-file";
import type { importWorkspaceFile } from '@/lib/memory/files/import';
import type { ExactUseAdmission } from '@/lib/memory/context/exact-use-admission';
export interface NativePiWorkspaceFileRef { taskId?: string; path: string; name?: string }
export const NATIVE_PI_WORKSPACE_FILE_TOTAL_CHAR_LIMIT = 16000;
export const NATIVE_PI_WORKSPACE_FILE_PER_FILE_CHAR_LIMIT = 6000;
export const NATIVE_PI_WORKSPACE_FILE_MAX_BYTES = 256 * 1024;
/** Model-selected paths and workDir cannot prove owner, exact version or a scope binding. */
export async function buildNativePiWorkspaceFileRefsContext(input: { workDir: string; refs: NativePiWorkspaceFileRef[] }, _options: {
  totalCharLimit?: number; perFileCharLimit?: number; maxBytes?: number } = {}): Promise<string> {
  if (!input.refs.length) return "";
  return `[Stored source gap: ${JSON.stringify(unregisteredFileSource("unregistered-workspace-file"))}]\n\n`;
}

/** Only the authenticated host calls this for the owner's current selection.
 * Historical paths remain unregistered until this explicit snapshot import. */
export async function importOwnerWorkspaceFileRefs(input: { userId: string; commandId: string; refs: NativePiWorkspaceFileRef[] }) {
  const [{ importWorkspaceFile }, { readArtifact }, { artifactRequestHash }] = await Promise.all([
    import('@/lib/memory/files/import'), import('@/lib/memory/artifacts/service'), import('@/lib/memory/adapters/postgres/artifacts')]);
  const artifactUses: NonNullable<ExactUseAdmission['artifacts']> = [];
  const imports: Array<Awaited<ReturnType<typeof importWorkspaceFile>>> = [];
  const sources: Array<Record<string, unknown>> = []; let remaining = NATIVE_PI_WORKSPACE_FILE_TOTAL_CHAR_LIMIT;
  for (let index = 0; index < Math.min(input.refs.length, 5); index++) {
    const ref = input.refs[index];
    if (!ref.taskId || !remaining) { sources.push({ status: 'unavailable', code: 'workspace_import_scope_unverified', index }); continue; }
    try {
      const imported = await importWorkspaceFile(input.userId, { commandId: `workspace-selection:${artifactRequestHash({ commandId: input.commandId, index })}`,
        taskId: ref.taskId, path: ref.path });
      const read = await readArtifact(input.userId, { artifactId: imported.artifactId, revision: imported.artifactRevision,
        range: { start: 0, end: NATIVE_PI_WORKSPACE_FILE_MAX_BYTES } });
      imports.push(imported);
      if (read.status !== 'ok') { sources.push({ status: 'unavailable', code: 'artifact_version_unavailable', artifactId: imported.artifactId }); continue; }
      if (!read.manifest.contentType.startsWith('text/') && read.manifest.contentType !== 'application/json') {
        sources.push({ status: 'conversion_required', artifactId: imported.artifactId, revision: read.ref.revision,
          warning: 'Managed snapshot imported. Binary content was not inserted as text; use an explicitly authorized converter.' }); continue;
      }
      let content = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes, { stream: read.bytes.byteLength < read.manifest.sizeBytes });
      let end = Math.min(content.length, remaining, NATIVE_PI_WORKSPACE_FILE_PER_FILE_CHAR_LIMIT);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
      content = content.slice(0, end); remaining -= end;
      artifactUses.push({ id: imported.artifactId, revision: read.ref.revision, evidenceReceiptId: read.receipt.id,
        start: 0, end: read.bytes.byteLength });
      sources.push({ status: 'read', artifactId: imported.artifactId, revision: read.ref.revision, receiptId: read.receipt.id,
        content, actualRange: { unit: 'utf16', start: 0, end }, semantics: 'owner_confirmed_imported_snapshot', originalFileCurrent: false,
        truncated: end < new TextDecoder('utf-8').decode(read.bytes).length || read.bytes.byteLength < read.manifest.sizeBytes });
    } catch {
      sources.push({ status: 'unavailable', code: 'workspace_file_import_unavailable', index,
        recovery: 'Review an existing owned task file and explicitly reimport its snapshot; paths and names alone cannot grant access.' });
    }
  }
  if (input.refs.length > 5) sources.push({ status: 'bounded', code: 'workspace_selection_limit', omitted: input.refs.length - 5 });
  return { text: sources.length ? `[Owner selected file snapshots: ${JSON.stringify(sources)}]\n\n` : '', artifactUses, imports,
    coverage: 'bounded_current_owner_selection' as const, complete: false as const };
}
