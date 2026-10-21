import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { MemoryReferenceError, MemoryWriteBusy, BrainMemoryUpdateError } from "@/lib/memory/kernel/reference-errors";
import { MemoryRevisionProtected } from "@/lib/memory/revision/legacy-errors";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { BrainMemoryStatus, BrainMemoryType, BrainScope } from "@/lib/memory/kernel/memory-types";

export async function requireMemoryUser() {
  if (resolveExecutionLease()) return { error: NextResponse.json({ error: "Owner context is required", code: "memory_owner_context_required" }, { status: 403 }) };
  const session = await auth();
  return session?.user?.id ? { userId: session.user.id } : { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
}
export function parseCsv(value: string | null) { return (value ?? "").split(",").map(item => item.trim()).filter(Boolean); }
export function parseLimit(value: string | null, fallback = 100) {
  const number = Number(value ?? fallback); return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), 1), 500) : fallback;
}
export function parseScope(value: unknown): BrainScope {
  if (!value || typeof value !== "object") return { type: "global" };
  const scope = value as Record<string, unknown>;
  switch (scope.type) {
    case "workspace": return { type: "workspace", workspaceId: String(scope.workspaceId ?? "") };
    case "workshop": return { type: "workshop", workshopId: String(scope.workshopId ?? "") };
    case "work": return { type: "work", workId: String(scope.workId ?? "") };
    default: return { type: "global" };
  }
}
export function parseStatuses(value: string | null): BrainMemoryStatus[] | undefined { const values = parseCsv(value); return values.length ? values as BrainMemoryStatus[] : undefined; }
export function parseMemoryTypes(value: string | null): BrainMemoryType[] | undefined { const values = parseCsv(value); return values.length ? values as BrainMemoryType[] : undefined; }
export function errorResponse(error: unknown, fallback: string) {
  if (error instanceof MemoryModuleError || error instanceof MemoryReferenceError || error instanceof MemoryRevisionProtected || error instanceof BrainMemoryUpdateError || error instanceof MemoryWriteBusy)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON", code: "invalid_memory_request" }, { status: 400 });
  // The fallback is a fixed route constant. Driver exceptions can contain SQL,
  // connection parameters and private request bodies and never cross this seam.
  return NextResponse.json({ error: fallback, code: "memory_request_unavailable" }, { status: 503 });
}
