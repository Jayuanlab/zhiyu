import { NextResponse, type NextRequest } from "next/server";
import { getBrainMemoryUpdate } from "@/lib/memory/revision/proposals";
import { BrainMemoryUpdateError } from "@/lib/memory/revision/common";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { const user = await requireMemoryUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await getBrainMemoryUpdate({ userId: user.userId, proposalId: (await params).id }));
}
catch (error) {
    return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to read memory update");
} }
