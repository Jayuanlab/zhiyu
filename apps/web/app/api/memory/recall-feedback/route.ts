import { auth } from '@/app/(auth)/auth';
import { recallFeedbackInput, recordRecallFeedback, RecallFeedbackError } from "@/lib/memory/governance/recall-feedback";
import type { NextRequest } from 'next/server';
import { readBoundedJson } from "../_shared";
import { errorResponse } from "../owner-route-helpers";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

export async function POST(request: NextRequest) {
  if (resolveExecutionLease()) return Response.json({ code: "memory_owner_context_required" }, { status: 403 });
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const parsed = recallFeedbackInput.safeParse(await readBoundedJson(request));
    if (!parsed.success) return Response.json({ error: 'Invalid recall feedback.' }, { status: 400 });
    const result = await recordRecallFeedback({ ...parsed.data,
      userId: session.user.id, contactEmail: session.user.email,
    });
    return Response.json({ ok: true, feedbackId: result.id }, { status: 201 });
  } catch (error) {
    if (error instanceof MemoryModuleError || error instanceof SyntaxError) return errorResponse(error, "Feedback unavailable");
    if (error instanceof RecallFeedbackError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Feedback could not be confirmed. Retry with the same feedback ID.' }, { status: 503 });
  }
}
