import { auth } from "@/app/(auth)/auth";
import { buildWechatTodoDigest } from "@/lib/interactions/workbench-context";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const params = request.nextUrl.searchParams;
    const digest = await buildWechatTodoDigest({
      userId: session.user.id,
      limit: boundedNumber(params.get("limit"), 30, 1, 100),
      cursor: String(boundedNumber(params.get("cursor"), 0, 0, 1000000)),
      sinceDays: boundedNumber(params.get("sinceDays"), 7, 0, 365),
    });
    return NextResponse.json(digest);
  } catch (error) {
    console.error("[InteractionTodoDigestAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load WeChat todo digest",
      },
      { status: 500 },
    );
  }
}
