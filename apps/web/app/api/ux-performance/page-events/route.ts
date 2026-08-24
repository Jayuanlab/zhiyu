import { auth } from "@/app/(auth)/auth";
import {
  appendUxPageMetricEvents,
  normalizeUxPageMetricBatch,
} from "@/lib/ux-smoke/page-events";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json().catch(() => null);
    const events = normalizeUxPageMetricBatch(payload);
    const accepted = appendUxPageMetricEvents({
      userId: session.user.id,
      events,
    });

    return NextResponse.json({ ok: true, accepted });
  } catch (error) {
    console.error("[UxPageEventsAPI] POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to record UX page events",
      },
      { status: 500 },
    );
  }
}
