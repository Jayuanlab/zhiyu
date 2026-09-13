import { auth } from '@/app/(auth)/auth';
import { recallFeedbackInput, recordRecallFeedback, RecallFeedbackError } from '@/lib/brain/recall-feedback';
import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = recallFeedbackInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid recall feedback.' }, { status: 400 });
  try {
    const result = await recordRecallFeedback({ ...parsed.data,
      userId: session.user.id, contactEmail: session.user.email,
    });
    return Response.json({ ok: true, feedbackId: result.id }, { status: 201 });
  } catch (error) {
    if (error instanceof RecallFeedbackError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Feedback could not be confirmed. Retry with the same feedback ID.' }, { status: 503 });
  }
}
