import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { createOwnerMemoryClient } from "@/lib/memory";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await context.params;
    return NextResponse.json(await createOwnerMemoryClient(session.user.id).explain({ receiptId: id }));
  } catch (error) {
    if (error instanceof MemoryModuleError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: "Receipt unavailable", code: "memory_request_failed" }, { status: 503 });
  }
}
