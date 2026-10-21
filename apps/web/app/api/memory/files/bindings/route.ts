import { requireMemoryUser, errorResponse } from '../../owner-route-helpers';
import { readBoundedJson } from '../../_shared';
import { requireArtifactSameOrigin } from '@/lib/memory/artifacts/http';
import { bindWorkFile, listWorkFileBindings } from '@/lib/memory/files/commands';
import { MemoryModuleError } from '@/lib/memory/kernel/errors';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'workshopId') || query.getAll('workshopId').length !== 1) throw new MemoryModuleError('invalid_memory_request', 400, 'A single Work reference is required');
    return Response.json(await listWorkFileBindings(owner.userId, query.get('workshopId') ?? ''), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error, 'Work file authorizations could not be loaded'); }
}
export async function POST(request: Request) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try { requireArtifactSameOrigin(request); return Response.json(await bindWorkFile(owner.userId, await readBoundedJson(request)), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error, 'The Work file authorization could not be saved'); }
}
