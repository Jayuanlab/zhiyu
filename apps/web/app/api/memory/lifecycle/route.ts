import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJson } from "../_shared";
import { requireMemoryUser, errorResponse } from "../owner-route-helpers";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { listLifecycleRecords, governRecordLifecycle } from "@/lib/memory/governance/record-lifecycle";
const recordClass = z.enum(["long_term", "run_record", "acceptance_record"]);
const schema = z.object({ memoryId: z.string().uuid(), expectedVersion: z.string().regex(/^bmrv1:[a-f0-9]{64}$/),
  commandId: z.string().min(1).max(200), action: z.enum(["classify", "rollback"]), recordClass: recordClass.optional(),
  reason: z.string().trim().min(1).max(2000), restoreReceiptId: z.string().uuid().optional(), requireReview: z.boolean().optional() }).strict();
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const user = await requireMemoryUser(); if (user.error) return user.error;
  try {
    const parsed = z.enum(["long_term", "run_record", "acceptance_record", "all"]).safeParse(request.nextUrl.searchParams.get("recordClass") ?? "all");
    if (!parsed.success) throw new MemoryModuleError("invalid_lifecycle", 400, "Invalid record class");
    const raw = request.nextUrl.searchParams.get("cursor");
    let cursor: { updatedAt: string; id: string } | undefined;
    if (raw) {
      try { if (raw.length > 512) throw Error(); cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
      catch { throw new MemoryModuleError("invalid_lifecycle", 400, "Invalid record cursor"); }
      if (!z.object({ updatedAt: z.string().datetime(), id: z.string().uuid() }).strict().safeParse(cursor).success) throw new MemoryModuleError("invalid_lifecycle", 400, "Invalid record cursor");
    }
    const memoryId = request.nextUrl.searchParams.get("memoryId") ?? undefined;
    if (memoryId && !z.string().uuid().safeParse(memoryId).success) throw new MemoryModuleError("invalid_lifecycle", 400, "Invalid memory ID");
    return NextResponse.json(await listLifecycleRecords(user.userId, parsed.data, 100, cursor, request.nextUrl.searchParams.get("extractionsOnly") === "true", memoryId));
  } catch (error) { return errorResponse(error, "Lifecycle records unavailable"); }
}
export async function POST(request: NextRequest) {
  const user = await requireMemoryUser(); if (user.error) return user.error;
  try {
    const parsed = schema.safeParse(await readBoundedJson(request));
    if (!parsed.success) throw new MemoryModuleError("invalid_lifecycle", 400, "Invalid lifecycle command");
    return NextResponse.json(await governRecordLifecycle({ ...parsed.data, requester: { type: "chat", userId: user.userId, id: "memory-lifecycle-owner" } }));
  } catch (error) { return errorResponse(error, "Lifecycle command unavailable"); }
}
