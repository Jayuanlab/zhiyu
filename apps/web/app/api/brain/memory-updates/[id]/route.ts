import { NextResponse, type NextRequest } from "next/server";
import { getBrainMemoryUpdate } from "@/lib/brain/memory-update-proposal";
import { BrainMemoryUpdateError } from "@/lib/brain/memory-update-common";
import { errorResponse, requireBrainUser } from "../../_shared";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, { params }: {
    params: Promise<{
        id: string;
    }>;
}) { const user = await requireBrainUser(); if (user.error)
    return user.error; try {
    return NextResponse.json(await getBrainMemoryUpdate({ userId: user.userId, proposalId: (await params).id }));
}
catch (error) {
    return error instanceof BrainMemoryUpdateError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to read memory update");
} }
