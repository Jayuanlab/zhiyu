import { NextResponse, type NextRequest } from "next/server";
import { getBrainMemoryAutoUpdatePolicy, updateBrainMemoryAutoUpdatePolicy } from "@/lib/brain/memory-update-policy";
import { BrainMemoryUpdateError } from "@/lib/brain/memory-update-common";
import { errorResponse, requireBrainUser } from "../../_shared";
export const dynamic = "force-dynamic";
function respond(error: unknown) { return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to process automatic memory policy"); }
export async function GET(_request: NextRequest) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await getBrainMemoryAutoUpdatePolicy({ userId: user.userId }));
}
catch (error) {
    return respond(error);
} }
export async function POST(request: NextRequest) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await updateBrainMemoryAutoUpdatePolicy({ requester: { type: "chat", userId: user.userId, id: "brain-update-policy-api" }, request: await request.json().catch(() => null) }));
}
catch (error) {
    return respond(error);
} }
