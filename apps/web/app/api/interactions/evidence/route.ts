import { auth } from "@/app/(auth)/auth";
import { getWechatMemoryEvidence } from "@/lib/interactions/workbench-context";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function stringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function boundedLimit(value: unknown) {
  const parsed = Number(value ?? 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const params = request.nextUrl.searchParams;
    const evidence = await getWechatMemoryEvidence({
      userId: session.user.id,
      memoryId: params.get("memoryId") ?? undefined,
      eventIds: stringArray(params.get("eventIds")),
      maxEvents: boundedLimit(params.get("maxEvents")),
    });
    return NextResponse.json(evidence);
  } catch (error) {
    console.error("[InteractionEvidenceAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load WeChat memory evidence",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json();
    const evidence = await getWechatMemoryEvidence({
      userId: session.user.id,
      memoryId: typeof body.memoryId === "string" ? body.memoryId : undefined,
      eventIds: stringArray(body.eventIds),
      maxEvents: boundedLimit(body.maxEvents),
    });
    return NextResponse.json(evidence);
  } catch (error) {
    console.error("[InteractionEvidenceAPI] POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load WeChat memory evidence",
      },
      { status: 500 },
    );
  }
}
