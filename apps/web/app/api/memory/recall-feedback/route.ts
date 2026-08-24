import { auth } from "@/app/(auth)/auth";
import { saveFeedback } from "@/lib/db/queries";
import { AppError } from "@openzhiyu/shared/errors";
import type { NextRequest } from "next/server";

const OUTCOMES = new Set([
  "used",
  "irrelevant",
  "missing",
  "too_broad",
  "too_narrow",
  "missed_boundary",
  "wrong_scope",
  "stale_state",
  "stale",
  "incorrect",
  "conflicting",
]);

function stringArray(value: unknown, max = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function shortString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return new AppError("unauthorized:auth").toResponse();
  }

  try {
    const body = await request.json();
    const outcome = shortString(body.outcome, 80);
    if (!OUTCOMES.has(outcome)) {
      return new AppError(
        "bad_request:api",
        "Invalid recall feedback outcome.",
      ).toResponse();
    }

    const query = shortString(body.query, 500);
    if (!query) {
      return new AppError(
        "bad_request:api",
        "Recall query is required.",
      ).toResponse();
    }

    const reason =
      shortString(body.reason, 1_000) || `Unified memory recall ${outcome}`;
    const memoryIds = stringArray(body.memoryIds);
    const selectedMemoryIds = stringArray(body.selectedMemoryIds, 50);
    const omittedMemoryIds = stringArray(body.omittedMemoryIds, 50);
    const deniedMemoryIds = stringArray(body.deniedMemoryIds, 50);
    const sources = stringArray(body.sources, 10);
    const contextLogId = shortString(body.contextLogId, 120) || null;

    const feedback = await saveFeedback({
      userId: session.user.id,
      contactEmail: session.user.email ?? null,
      content: reason,
      type: "improvement",
      title: `Memory recall ${outcome}`,
      description: reason,
      status: "open",
      priority:
        outcome === "missed_boundary" || outcome === "wrong_scope"
          ? "high"
          : "medium",
      source: "memory_recall",
      systemInfo: {
        kind: "memory_recall_feedback",
        query,
        outcome,
        contextLogId,
        memoryIds,
        selectedMemoryIds,
        omittedMemoryIds,
        deniedMemoryIds,
        sources,
        automaticPolicyChange: false,
      },
      updatedAt: new Date(),
    } as any);

    return Response.json(
      {
        ok: true,
        feedbackId: feedback.id,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[MemoryRecallFeedback] Failed to save feedback:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new AppError("bad_request:api", message).toResponse();
  }
}
