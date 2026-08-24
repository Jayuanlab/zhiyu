import { auth } from "@/app/(auth)/auth";
import { getUxSmokeDashboard } from "@/lib/ux-smoke/report";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const windowParam = request.nextUrl.searchParams.get("window");
    const window = windowParam ? Number(windowParam) : null;

    return NextResponse.json(await getUxSmokeDashboard({ window }));
  } catch (error) {
    console.error("[UxPerformanceAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load UX performance dashboard",
      },
      { status: 500 },
    );
  }
}
