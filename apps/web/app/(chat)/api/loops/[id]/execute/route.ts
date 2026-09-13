import { auth } from "@/app/(auth)/auth";
import { getLoopDashboardDetail } from "@/lib/loops/dashboard";
import { runLoopHarness } from "@/lib/loops/harness";
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {LoopExecutionBusy} from '@/lib/work-runtime/loop-execution';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === "object" && !Array.isArray(body) ? body : {};
	} catch {
		return {};
	}
}

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
		const body = await readJsonBody(request);
		if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
		const commandId=body.commandId??request.headers.get('Idempotency-Key');
		if(typeof commandId!=='string'||!commandId.trim()||commandId.length>256||(body.expectedVersion!==undefined&&(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<0))||(body.dryRun!==undefined&&typeof body.dryRun!=='boolean'))return NextResponse.json({error:'invalid_command'},{status:400});
		const dryRun = body.dryRun !== false;

		const execution = await runLoopHarness({
			userId: session.user.id,
			loopId: id,
			commandId,
			expectedVersion: body.expectedVersion as number|undefined,
			mode: dryRun ? "dry_run" : "native_agent",
			triggeredBy: "manual",
			reason: {
				api: "/api/loops/[id]/execute",
				dryRun,
			},
		});
		const loop = await getLoopDashboardDetail(session.user.id, id);

		return NextResponse.json({
			commandId,
			result: execution.result,
			harness: execution.harness,
			loop,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to execute loop";
		const status = error instanceof WorkCommandConflict||error instanceof LoopExecutionBusy||error instanceof ExecutionLeaseError?error.status:message === "Loop not found" ? 404 : 500;

		console.error("[Loops] POST execute error:", error);
		return NextResponse.json({ error: message,...(error instanceof WorkCommandConflict||error instanceof LoopExecutionBusy||error instanceof ExecutionLeaseError?{code:error.code}:{}) }, { status });
	}
}
