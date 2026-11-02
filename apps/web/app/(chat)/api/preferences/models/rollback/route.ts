import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import {
  getModelCenterResponse,
  modelCenterErrorResponse,
} from '@/lib/ai/model-center-service';
import { saveModelCenterSnapshot } from '@/lib/ai/model-center-store';
const schema = z.object({
  expectedRevision: z.number().int().positive(),
  restoreRevision: z.number().int().positive(),
});
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const payload = schema.parse(await request.json());
    await saveModelCenterSnapshot({
      ...payload,
      userId: session.user.id,
      document: {},
      action: 'rollback',
    });
    return Response.json(await getModelCenterResponse(session.user.id));
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
