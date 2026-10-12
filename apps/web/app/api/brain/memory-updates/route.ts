import { NextResponse, type NextRequest } from "next/server";
import { listBrainMemoryUpdates, proposeBrainMemoryUpdate } from "@/lib/brain/memory-update-proposal";
import { BrainMemoryUpdateError } from "@/lib/brain/memory-update-common";
import { errorResponse, parseLimit, requireBrainUser } from "../_shared";
export const dynamic = "force-dynamic";
function respond(error: unknown) { return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to process memory update"); }
export async function GET(request: NextRequest) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    const p = request.nextUrl.searchParams;
    return NextResponse.json({ proposals: await listBrainMemoryUpdates({ userId: user.userId, ownerType: p.get("ownerType") ?? undefined, ownerId: p.get("ownerId") ?? undefined, limit: parseLimit(p.get("limit"), 20) }) });
}
catch (error) {
    return respond(error);
} }
export async function POST(request: NextRequest) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await proposeBrainMemoryUpdate({ requester: { type: "chat", userId: user.userId, id: "brain-update-api" }, request: await request.json().catch(() => null) }));
}
catch (error) {
    return respond(error);
} }
