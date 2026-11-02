import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { safeModelCenterSnapshot } from '@openzhiyu/shared/model-center';
import { readModelCenterVersion } from '@/lib/ai/model-center-store';
import { modelCenterErrorResponse } from '@/lib/ai/model-center-service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const revision = z.coerce
      .number()
      .int()
      .positive()
      .parse(new URL(request.url).searchParams.get('revision'));
    return Response.json(
      safeModelCenterSnapshot(
        await readModelCenterVersion(session.user.id, revision),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
