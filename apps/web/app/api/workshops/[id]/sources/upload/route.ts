import { NextResponse, type NextRequest } from 'next/server';
import { requireMemoryUser, errorResponse } from '@/app/api/memory/owner-route-helpers';
import { artifactMultipart, requireArtifactSameOrigin } from '@/lib/memory/artifacts/http';
import { uploadWorkFile } from '@/lib/memory/files/upload';
import { MemoryModuleError } from '@/lib/memory/kernel/errors';
import { extname } from 'node:path';
import { getMimeTypeFromExtension } from '@/lib/files/config';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try {
    requireArtifactSameOrigin(request);
    const form = await artifactMultipart(request);
    if ([...form.keys()].some(key => !['file', 'commandId', 'expiresAt'].includes(key))) throw new MemoryModuleError('invalid_memory_request', 400, 'Unknown upload field');
    if (['file', 'commandId', 'expiresAt'].some(key => form.getAll(key).length !== 1)) throw new MemoryModuleError('invalid_memory_request', 400, 'A single file, command ID and authorization expiry are required');
    const file = form.get('file');
    if (!(file instanceof File)) throw new MemoryModuleError('invalid_memory_request', 400, 'A file is required');
    const result = await uploadWorkFile(owner.userId, { workshopId: (await params).id, commandId: form.get('commandId'),
      expiresAt: form.get('expiresAt'), name: file.name, contentType: file.type || getMimeTypeFromExtension(extname(file.name)) || 'application/octet-stream' }, new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error, 'The private Work file upload could not be completed'); }
}
