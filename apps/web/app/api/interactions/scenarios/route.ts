import { auth } from "@/app/(auth)/auth";
import { listBrainSnapshots } from "@/lib/brain/service";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function boundedLimit(value: unknown, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scenarioKey(snapshot: Awaited<ReturnType<typeof listBrainSnapshots>>[number]) {
  const content = asRecord(snapshot.content);
  const metadata = asRecord(snapshot.metadata);
  const type = String(content.scenarioType ?? metadata.scenarioType ?? "");
  const key = String(content.scenarioKey ?? metadata.scenarioKey ?? "");
  return type && key ? `${type}:${key}` : "";
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = request.nextUrl.searchParams;
    const snapshots = await listBrainSnapshots({
      userId: session.user.id,
      snapshotTypes: ["wechat_scenario_state"],
      limit: boundedLimit(params.get("limit"), 100),
    });
    const requestedType = params.get("type")?.trim();
    const requestedKey = params.get("key")?.trim();
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      const key = scenarioKey(snapshot);
      if (!key || latest.has(key)) continue;
      const content = asRecord(snapshot.content);
      if (requestedType && content.scenarioType !== requestedType) continue;
      if (requestedKey && content.scenarioKey !== requestedKey) continue;
      latest.set(key, snapshot);
    }

    return NextResponse.json({
      scenarios: [...latest.values()],
      count: latest.size,
    });
  } catch (error) {
    console.error("[InteractionScenariosAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load interaction scenarios",
      },
      { status: 500 },
    );
  }
}
