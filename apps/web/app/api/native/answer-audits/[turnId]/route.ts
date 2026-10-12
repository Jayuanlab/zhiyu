import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { AgentAnswerAuditError, getAgentAnswerAuditSummary, getAgentAnswerBodyMirror } from "@/lib/db/agent-answer-audits";

export async function GET(_request: Request, context: { params: Promise<{ turnId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { turnId } = await context.params;
    const summary = await getAgentAnswerAuditSummary({ ownerId: session.user.id, turnId });
    if (!summary) return NextResponse.json({ error: "Answer turn not found", code: "answer_turn_not_found" }, { status: 404 });
    const bodyMirror = await getAgentAnswerBodyMirror({ ownerId: session.user.id, summary });
    return NextResponse.json({ ...summary, bodyMirror, queryUrl: `/api/native/answer-audits/${summary.turnId}` }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AgentAnswerAuditError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "Unable to read answer audit", code: "answer_audit_unavailable" }, { status: 503 });
  }
}
