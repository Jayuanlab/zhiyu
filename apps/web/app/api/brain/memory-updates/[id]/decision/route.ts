import { NextResponse, type NextRequest } from "next/server";
import { decideBrainMemoryUpdate } from "@/lib/brain/memory-update-proposal";
import { BrainMemoryUpdateError } from "@/lib/brain/memory-update-common";
import { errorResponse, requireBrainUser } from "../../../_shared";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await decideBrainMemoryUpdate({ requester: { type: "chat", userId: user.userId, id: "brain-update-decision-api" }, proposalId: (await params).id, request: await request.json().catch(() => null) }));
}
catch (error) {
    return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to decide memory update");
} }
