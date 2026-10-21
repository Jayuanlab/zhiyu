import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { listBrainMemoryUpdates, proposeBrainMemoryUpdate } from "@/lib/memory/revision/proposals";
import { BrainMemoryUpdateError } from "@/lib/memory/revision/common";
import { errorResponse, parseLimit, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";
export const dynamic = "force-dynamic";
function respond(error: unknown) { return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to process memory update"); }
export async function GET(request: NextRequest) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    const p = request.nextUrl.searchParams;
    return NextResponse.json({ proposals: await listBrainMemoryUpdates({ userId: user.userId, ownerType: p.get("ownerType") ?? undefined, ownerId: p.get("ownerId") ?? undefined, limit: parseLimit(p.get("limit"), 20) }) });
}
catch (error) {
    return respond(error);
} }
export async function POST(request: NextRequest) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await proposeBrainMemoryUpdate({ requester: { type: "chat", userId: user.userId, id: "brain-update-api" }, request: await readBoundedJson(request) }));
}
catch (error) {
    return respond(error);
} }
