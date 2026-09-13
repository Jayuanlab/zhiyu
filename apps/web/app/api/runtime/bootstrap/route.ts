import { auth } from "@/app/(auth)/auth";
import { bootstrapRuntimeForUser } from "@/lib/runtime/bootstrap";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		return NextResponse.json(
			await bootstrapRuntimeForUser({
				userId: session.user.id,
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		console.error("[RuntimeBootstrap] GET error:", error);
		return NextResponse.json(
			{
				success: false,
				error: "runtime_status_unavailable",
			},
			{ status: 503 },
		);
	}
}
