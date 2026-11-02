import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { modelCenterDocumentSchema } from '@openzhiyu/shared/model-center';
import {
  getModelCenterResponse,
  getModelCenterSnapshot,
  modelCenterErrorResponse,
} from '@/lib/ai/model-center-service';
import { saveModelCenterSnapshot } from '@/lib/ai/model-center-store';

export const dynamic = 'force-dynamic';
const schema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  document: modelCenterDocumentSchema,
  secretUpdates: z
    .record(z.string(), z.string().max(4096).nullable())
    .optional(),
});
export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return Response.json(await getModelCenterResponse(session.user.id), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const payload = schema.parse(await request.json());
    const initial =
      payload.expectedRevision === 0
        ? await getModelCenterSnapshot(session.user.id)
        : null;
    await saveModelCenterSnapshot({
      ...payload,
      userId: session.user.id,
      initialSecrets: initial?.secrets,
      initialDocument: initial?.document,
    });
    return Response.json(await getModelCenterResponse(session.user.id));
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
