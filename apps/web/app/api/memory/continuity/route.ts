import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { inspectMemoryContinuity, parseContinuityInspectionQuery } from "@/lib/memory/continuity/inspection";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const query = parseContinuityInspectionQuery(new URL(request.url).searchParams);
    return NextResponse.json(await inspectMemoryContinuity(session.user.id, query));
  } catch (error) {
    if (error instanceof MemoryModuleError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "Continuity inspection could not be completed", code: "memory_continuity_unavailable" }, { status: 503 });
  }
}
