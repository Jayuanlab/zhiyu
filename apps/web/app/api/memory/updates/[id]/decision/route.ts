import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { decideBrainMemoryUpdate } from "@/lib/memory/revision/proposals";
import { BrainMemoryUpdateError } from "@/lib/memory/revision/common";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await decideBrainMemoryUpdate({ requester: { type: "chat", userId: user.userId, id: "brain-update-decision-api" }, proposalId: (await params).id, request: await readBoundedJson(request) }));
}
catch (error) {
    return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to decide memory update");
} }
