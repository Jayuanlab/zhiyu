import { auth } from '@/app/(auth)/auth';
import { getAuthMode, requestBoundary } from '@/lib/auth/request-boundary';
import { readLimited } from '@openzhiyu/ai/audio';
import { ZodError } from 'zod';
import { DayError } from './contracts';
export async function dayOwner(request: Request) {
  const session = await auth();
  if (!session?.user?.id) throw new DayError('unauthorized', 401);
  const denied = requestBoundary(request, getAuthMode());
  const origin = request.headers.get('origin');
  const publicOrigin = new URL(
    `${new URL(request.url).protocol}//${request.headers.get('host')}`,
  ).origin;
  if (
    denied ||
    (origin && origin !== publicOrigin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new DayError('same_origin_required', 403);
  const actor = request.headers.get('X-Personal-Day-Actor');
  if (actor && actor !== session.user.id)
    throw new DayError('actor_changed', 409);
  return session.user.id;
}
export const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export function dayErrorResponse(error: unknown) {
  if (error instanceof DayError)
    return Response.json(
      { error: error.code, ...(error.detail ? { detail: error.detail } : {}) },
      { status: error.status, headers: privateHeaders },
    );
  if (error instanceof ZodError)
    return Response.json(
      {
        error: 'invalid_input',
        fields: error.issues.map((i) => i.path.join('.')),
      },
      { status: 400, headers: privateHeaders },
    );
  if (
    error instanceof Error &&
    ['AbortError', 'TimeoutError'].includes(error.name)
  )
    return Response.json(
      { error: 'generation_timed_out' },
      { status: 504, headers: privateHeaders },
    );
  console.error(
    '[Personal day] operation failed',
    error instanceof Error ? error.name : 'UnknownError',
  );
  return Response.json(
    { error: 'daily_service_unavailable' },
    { status: 503, headers: privateHeaders },
  );
}
export async function dayJson(request: Request) {
  const bytes = await readLimited(new Response(request.body), 1024 * 1024);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DayError('invalid_input');
  }
}
