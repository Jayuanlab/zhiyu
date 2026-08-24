import { auth } from "@/app/(auth)/auth";
import { getWorkshopDashboard } from "@/lib/workshops/dashboard";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const dashboard = await getWorkshopDashboard({
      userId: session.user.id,
      workshopId: id,
    });

    if (!dashboard) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(dashboard);
  } catch (error) {
    console.error("[WorkshopDashboardAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load workshop dashboard",
      },
      { status: 500 },
    );
  }
}
