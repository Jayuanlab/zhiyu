import { auth } from "@/app/(auth)/auth";
import { getRuntimeStatusSnapshot } from "@/lib/runtime/status";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		return NextResponse.json(await getRuntimeStatusSnapshot(session.user.id));
	} catch (error) {
		console.error("[RuntimeStatus] GET error:", error);
		return NextResponse.json(
			{
				error: "runtime_status_unavailable",
			},
			{ status: 503 },
		);
	}
}
