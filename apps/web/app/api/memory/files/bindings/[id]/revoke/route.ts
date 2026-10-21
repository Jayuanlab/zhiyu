import { z } from 'zod';
import { requireMemoryUser, errorResponse } from '../../../../owner-route-helpers';
import { readBoundedJson } from '../../../../_shared';
import { requireArtifactSameOrigin } from '@/lib/memory/artifacts/http';
import { revokeWorkFile } from '@/lib/memory/files/commands';
import { parseFileInput } from '@/lib/memory/files/contracts';
export const dynamic = 'force-dynamic';
const input = z.object({ commandId: z.string().trim().min(1).max(200), expectedBindingRevision: z.number().int().positive().safe() }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try { requireArtifactSameOrigin(request); return Response.json(await revokeWorkFile(owner.userId, { ...parseFileInput(input, await readBoundedJson(request)), bindingId: (await params).id }), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error, 'The Work file authorization could not be revoked'); }
}
