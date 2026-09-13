import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { updateInsightTab, deleteInsightTab } from "@/lib/db/insight-queries";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tabId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { tabId } = await params;
  try {
    const body = await request.json();
    const tab = await updateInsightTab({
      userId: session.user.id,
      tabId,
      payload: body,
    });

    if (!tab) {
      return NextResponse.json({ error: "Tab not found" }, { status: 404 });
    }

    return NextResponse.json({ tab });
  } catch (error) {
    console.error("Failed to update insight tab:", error);
    return NextResponse.json(
      { error: "Failed to update tab" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tabId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { tabId } = await params;
  try {
    const deleted = await deleteInsightTab({
      userId: session.user.id,
      tabId,
    });

    if (!deleted) {
      return NextResponse.json({ error: "Tab not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete insight tab:", error);
    return NextResponse.json(
      { error: "Failed to delete tab" },
      { status: 500 },
    );
  }
}
