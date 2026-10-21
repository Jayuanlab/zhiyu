import { requireMemoryUser, errorResponse } from '../../owner-route-helpers';
import { readBoundedJson } from '../../_shared';
import { requireArtifactSameOrigin } from '@/lib/memory/artifacts/http';
import { importWorkspaceFile } from '@/lib/memory/files/import';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try { requireArtifactSameOrigin(request); return Response.json(await importWorkspaceFile(owner.userId, await readBoundedJson(request)), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error, 'The owned workspace file could not be imported'); }
}
