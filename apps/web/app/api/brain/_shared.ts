import { auth } from "@/app/(auth)/auth";
import { BrainReferenceError } from "@/lib/brain/write-errors";
import { NextResponse } from "next/server";
import type { BrainMemoryStatus, BrainMemoryType, BrainScope } from "@/lib/brain";

export async function requireBrainUser() {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { userId: session.user.id };
}

export function parseCsv(value: string | null) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseLimit(value: string | null, fallback = 100) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number)
    ? Math.min(Math.max(Math.trunc(number), 1), 500)
    : fallback;
}

export function parseScope(value: unknown): BrainScope {
  if (!value || typeof value !== "object") return { type: "global" };
  const scope = value as Record<string, unknown>;
  switch (scope.type) {
    case "workspace":
      return { type: "workspace", workspaceId: String(scope.workspaceId ?? "") };
    case "workshop":
      return { type: "workshop", workshopId: String(scope.workshopId ?? "") };
    case "work":
      return { type: "work", workId: String(scope.workId ?? "") };
    default:
      return { type: "global" };
  }
}

export function parseStatuses(value: string | null): BrainMemoryStatus[] | undefined {
  const values = parseCsv(value);
  return values.length ? (values as BrainMemoryStatus[]) : undefined;
}

export function parseMemoryTypes(value: string | null): BrainMemoryType[] | undefined {
  const values = parseCsv(value);
  return values.length ? (values as BrainMemoryType[]) : undefined;
}

export function errorResponse(error: unknown, fallback: string) {
  if (error instanceof BrainReferenceError) {
    return NextResponse.json({error:error.message,code:error.code},{status:error.status});
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}
