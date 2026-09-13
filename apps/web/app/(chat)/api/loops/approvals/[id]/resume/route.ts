import { auth } from "@/app/(auth)/auth";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";
import { resumeLoopApprovalContinuation } from "@/lib/loops/approval-resume";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		const { id } = await params;
		if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
		const body = (await request.json().catch(() => ({}))) as {
			note?: string | null;
		};

		const result = await resumeLoopApprovalContinuation({
			userId: session.user.id,
			approvalRequestId: id,
			note: body.note ?? null,
		});

		return NextResponse.json(result);
	} catch (error) {
		if(error instanceof WorkCommandConflict)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
		const message =
			error instanceof Error
				? error.message
				: "Failed to resume loop approval continuation";
		const status = message.includes("not found")
			? 404
			: message.includes("Only approved") ||
					message.includes("Continuation is") ||
					message.includes("not pending")
				? 409
				: 500;

		console.error("[LoopApprovals] Resume error:", error);
		return NextResponse.json({ error: message }, { status });
	}
}
