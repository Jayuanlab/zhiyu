import { db } from '@/lib/db/client';
import { privateArtifactStore } from '../artifacts/object-store';
import { artifactDigest, verifyArtifactMedia } from '../artifacts/policy';
import { MAX_ARTIFACT_BYTES } from '../artifacts/contracts';
import { MemoryModuleError } from '../kernel/errors';
import { readFileBindingForShare, type FileReadAuthority } from '../adapters/postgres/file-bindings';
import { withArtifactOwner, lockArtifact, artifactRef } from '../adapters/postgres/artifacts';

export type FilePhysicalTicket = Readonly<{ kind: 'work-file-physical'; bindingId: string; revision: string; artifactId: string; artifactRevision: string;
  sha256: string; sizeBytes: number; contentType: string; name: string }>;
const issued = new WeakMap<object, { bytes: Uint8Array; authority: FileReadAuthority }>();
export type ArtifactPhysicalTicket = Readonly<{ kind: 'owner-artifact-physical'; artifactId: string; artifactRevision: string; sha256: string; sizeBytes: number }>;
const ownerIssued = new WeakMap<object, string>();
const unavailable = () => new MemoryModuleError('file_source_integrity_unavailable', 503, 'The actual private file object could not be verified at its bound version');
/** Real object IO is deliberately outside the final permission/audit transaction. */
export async function prepareFilePhysical(input: FileReadAuthority, expectedRevision?: string): Promise<FilePhysicalTicket> {
  const current = await db.transaction(store => readFileBindingForShare(store, input)).catch(error => {
    if (error instanceof MemoryModuleError) throw error;
    throw unavailable();
  });
  if (expectedRevision && current.revision !== expectedRevision) throw unavailable();
  let bytes: Uint8Array;
  try {
    bytes = await privateArtifactStore(current.manifest.provider).read(current.manifest.objectKey, MAX_ARTIFACT_BYTES);
    if (bytes.byteLength !== current.manifest.sizeBytes || artifactDigest(bytes) !== current.manifest.sha256) throw unavailable();
    verifyArtifactMedia(bytes, current.manifest.contentType);
  } catch { throw unavailable(); }
  const ticket = Object.freeze({ kind: 'work-file-physical' as const, bindingId: current.binding.id, revision: current.revision, artifactId: current.manifest.id,
    artifactRevision: current.binding.artifactRevision, sha256: current.manifest.sha256, sizeBytes: bytes.byteLength,
    contentType: current.manifest.contentType, name: current.manifest.name });
  issued.set(ticket, { bytes, authority: structuredClone(input) });
  return ticket;
}
export function physicalTicketBytes(ticket: FilePhysicalTicket): Uint8Array {
  const actual = issued.get(ticket); if (!actual) throw unavailable();
  return actual.bytes.slice();
}
export function assertPhysicalTicket(ticket: FilePhysicalTicket | undefined, input: FileReadAuthority,
  current: Awaited<ReturnType<typeof readFileBindingForShare>>) {
  const actual = ticket && issued.get(ticket);
  if (!ticket || !actual || actual.authority.userId !== input.userId || actual.authority.workId !== input.workId
    || actual.authority.permission !== input.permission || actual.authority.tool !== input.tool
    || ticket.bindingId !== current.binding.id || ticket.revision !== current.revision || ticket.artifactId !== current.manifest.id
    || ticket.artifactRevision !== current.binding.artifactRevision || ticket.sha256 !== current.manifest.sha256 || ticket.sizeBytes !== current.manifest.sizeBytes) throw unavailable();
}
export async function prepareArtifactPhysical(userId: string, artifactId: string, revision: string): Promise<ArtifactPhysicalTicket> {
  const row = await withArtifactOwner(userId, 'share', async store => {
    const current = await lockArtifact(store, userId, artifactId, 'share');
    if (!current || current.state !== 'active' || artifactRef(current).revision !== revision) throw unavailable();
    return current;
  });
  try {
    const bytes = await privateArtifactStore(row.provider).read(row.objectKey, MAX_ARTIFACT_BYTES);
    if (bytes.byteLength !== row.sizeBytes || artifactDigest(bytes) !== row.sha256) throw unavailable();
    verifyArtifactMedia(bytes, row.contentType);
  } catch { throw unavailable(); }
  const ticket = Object.freeze({ kind: 'owner-artifact-physical' as const, artifactId, artifactRevision: revision, sha256: row.sha256, sizeBytes: row.sizeBytes });
  ownerIssued.set(ticket, userId); return ticket;
}
export function assertArtifactPhysicalTicket(ticket: ArtifactPhysicalTicket | FilePhysicalTicket | undefined, userId: string,
  current: { ref: { record: { id: string }; revision: string }; sha256: string; sizeBytes: number }) {
  if (!ticket || ownerIssued.get(ticket) !== userId || ticket.artifactId !== current.ref.record.id
    || ticket.artifactRevision !== current.ref.revision || ticket.sha256 !== current.sha256 || ticket.sizeBytes !== current.sizeBytes) throw unavailable();
}
