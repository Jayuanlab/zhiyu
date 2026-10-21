import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedJson } from "../_shared";
import { errorResponse, requireMemoryUser } from "../owner-route-helpers";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { proposeLessonExtraction } from "@/lib/memory/governance/lesson-extraction";
const text = (max: number) => z.string().trim().min(1).max(max);
const command = z.object({ sourceMemoryId: z.string().uuid(), expectedVersion: z.string().regex(/^bmrv1:[a-f0-9]{64}$/), commandId: text(200),
  offset: z.number().int().nonnegative(), quote: z.string().min(10).max(2000), conclusion: text(2000), conditions: text(1200), counterexample: text(1200), recheckWhen: text(1200), validityDays: z.number().int().min(1).max(90) }).strict();
export async function POST(request: Request) {
  const user = await requireMemoryUser(); if (user.error) return user.error;
  try {
    const parsed = command.safeParse(await readBoundedJson(request)); if (!parsed.success) throw new MemoryModuleError("invalid_extraction", 400, "Invalid extraction command");
    return NextResponse.json(await proposeLessonExtraction({ ...parsed.data, requester: { type: "chat", userId: user.userId, id: "memory-lifecycle-owner" } }));
  } catch (error) { return errorResponse(error, "Lesson extraction unavailable"); }
}
