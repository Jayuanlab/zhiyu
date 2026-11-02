import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { getAuthMode, isLoopbackHostname } from '@/lib/auth/request-boundary';
import { modelCenterErrorResponse } from '@/lib/ai/model-center-service';
import {
  readMachineModelSettings,
  saveMachineModelSettings,
} from '@/lib/ai/machine-model-settings';
export const dynamic = 'force-dynamic';
const schema = z.object({
  expectedRevision: z.string().length(64),
  updates: z.record(z.string(), z.string().max(4096).nullable()),
});
export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return Response.json(
      await readMachineModelSettings(getAuthMode() === 'local_owner'),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (
    getAuthMode() !== 'local_owner' ||
    !isLoopbackHostname(new URL(request.url).hostname)
  )
    return Response.json(
      { error: 'machine_settings_owner_only' },
      { status: 403 },
    );
  try {
    const payload = schema.parse(await request.json());
    return Response.json(
      await saveMachineModelSettings({ ...payload, actor: session.user.id }),
    );
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
