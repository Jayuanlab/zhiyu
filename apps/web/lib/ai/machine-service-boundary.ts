import { auth } from '@/app/(auth)/auth';
import {
  getAuthMode,
  isLoopbackHostname,
  requestBoundary,
} from '@/lib/auth/request-boundary';
import { MediaServiceError } from '@openzhiyu/ai/audio';
import { modelCenterErrorResponse } from './model-center-service';
export async function machineServiceOwner(
  request: Request,
): Promise<string | Response> {
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
  const denied = requestBoundary(request, 'local_owner');
  if (denied || request.headers.get('sec-fetch-site') === 'cross-site')
    return Response.json(
      { error: denied || 'cross_site_request' },
      { status: 403 },
    );
  return session.user.id;
}
export function machineServiceErrorResponse(error: unknown) {
  if (error instanceof MediaServiceError)
    return Response.json(
      { error: error.code, httpStatus: error.status },
      { status: 502 },
    );
  if (
    error instanceof Error &&
    ['AbortError', 'TimeoutError'].includes(error.name)
  )
    return Response.json(
      { error: 'machine_test_aborted_or_timed_out' },
      { status: 504 },
    );
  return modelCenterErrorResponse(error);
}
