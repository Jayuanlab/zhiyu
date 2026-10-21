import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { getBrainMemoryAutoUpdatePolicy, updateBrainMemoryAutoUpdatePolicy } from "@/lib/memory/revision/auto-update-policy";
import { BrainMemoryUpdateError } from "@/lib/memory/revision/common";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";
export const dynamic = "force-dynamic";
function respond(error: unknown) { return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to process automatic memory policy"); }
export async function GET(_request: NextRequest) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await getBrainMemoryAutoUpdatePolicy({ userId: user.userId }));
}
catch (error) {
    return respond(error);
} }
export async function POST(request: NextRequest) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await updateBrainMemoryAutoUpdatePolicy({ requester: { type: "chat", userId: user.userId, id: "brain-update-policy-api" }, request: await readBoundedJson(request) }));
}
catch (error) {
    return respond(error);
} }
