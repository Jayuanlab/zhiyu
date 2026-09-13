import { auth } from "@/app/(auth)/auth";
import { getLoopDashboardDetail } from "@/lib/loops/dashboard";
import { deleteLoop, getLoop, updateLoop } from "@/lib/loops/service";
import { loopVerificationSchema } from "@/lib/loops/spec";
import { updateWorkLoop, updateWorkLoopModelChecker } from "@/lib/work-runtime/commands";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		const { id } = await params;
		const loop = await getLoopDashboardDetail(session.user.id, id);
		if (!loop) {
			return NextResponse.json({ error: "Loop not found" }, { status: 404 });
		}

		return NextResponse.json({ loop });
	} catch (error) {
		console.error("[Loops] GET by ID error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to get loop" },
			{ status: 500 },
		);
	}
}

const modelCheckerPatchSchema = z
	.object({
		commandId: z.string().min(1).max(256).optional(),
		expectedVersion: z.number().int().nonnegative().max(2147483646).optional(),
		modelChecker: z
			.object({
				enabled: z.boolean(),
				provider: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				maxInputChars: z.number().int().min(2_000).max(50_000).optional(),
			})
			.strict(),
	})
	.strict();

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		const { id } = await params;
		const body = await request.json();
		const parsed = modelCheckerPatchSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: parsed.error.issues[0]?.message ?? "Invalid loop update" },
				{ status: 400 },
			);
		}

		const existing = await getLoop(session.user.id, id);
		if (!existing) {
			return NextResponse.json({ error: "Loop not found" }, { status: 404 });
		}

		if (existing.workshopId) {
			const result = await updateWorkLoopModelChecker({
				userId: session.user.id, workId: existing.workshopId, loopId: id,
				commandId: parsed.data.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
				expectedVersion: parsed.data.expectedVersion,
				modelChecker: parsed.data.modelChecker, source: "owner",
				reason: "Owner updated model checker from loop API",
			});
			// Return the committed result, not a fresh dashboard that could differ
			// on replay after another command changed the Loop.
			return NextResponse.json({ loop: result.loop });
		}

		const verificationConfig = loopVerificationSchema.parse({
			...existing.verificationConfig,
			modelChecker: parsed.data.modelChecker,
		});
		const updated = await updateLoop(session.user.id, id, {
			verificationConfig,
		});
		if (!updated) {
			return NextResponse.json({ error: "Loop not found" }, { status: 404 });
		}

		const loop = await getLoopDashboardDetail(session.user.id, id);
		return NextResponse.json({ loop });
	} catch (error) {
		console.error("[Loops] PATCH by ID error:", error);
		if (error instanceof WorkCommandConflict) return NextResponse.json({error: error.message, code: error.code}, {status: error.status});
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to update loop",
			},
			{ status: error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500 },
		);
	}
}

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		const { id } = await params;
		const existing = await getLoop(session.user.id, id);
		if (!existing) return NextResponse.json({error: "Loop not found"}, {status: 404});
		if (existing.workshopId) {
			const body = await request.json().catch(() => ({}));
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkCommandConflict("invalid_command");
			const result = await updateWorkLoop({
				userId: session.user.id, workId: existing.workshopId, loopId: id,
				commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
				expectedVersion: body.expectedVersion, patch: {status: "archived"},
				source: "owner", reason: "Owner archived loop from task list",
			});
			return NextResponse.json({ok: true, archived: true, loop: result.loop});
		}
		const deleted = await deleteLoop(session.user.id, id);
		if (!deleted) {
			return NextResponse.json({ error: "Loop not found" }, { status: 404 });
		}

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("[Loops] DELETE by ID error:", error);
		if (error instanceof WorkCommandConflict) return NextResponse.json({error: error.message, code: error.code}, {status: error.status});
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Failed to delete loop",
			},
			{ status: 500 },
		);
	}
}
