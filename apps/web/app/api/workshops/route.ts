import { auth } from "@/app/(auth)/auth";
import {
  createWork,
} from "@/lib/work-runtime";
import { WORK_RUNTIME_INTERFACE_VERSION } from "@/lib/work-runtime/types";
import { listWorkshops } from "@/lib/workshops/service";
import {
  applyWorkshopManifest,
  reviewWorkshopManifest,
} from "@/lib/workshops/manifest";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workshops = await listWorkshops(session.user.id);
    return NextResponse.json({
      workshops,
      workSummaries: [],
      interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[WorkshopsAPI] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load workshops" },
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
    const manifestYaml =
      typeof body.manifestYaml === "string" ? body.manifestYaml.trim() : "";
    if (manifestYaml) {
      const reviewResult = await reviewWorkshopManifest({
        userId: session.user.id,
        manifestYaml,
      });

      if (body.dryRun === true || body.apply === false) {
        return NextResponse.json(
          {
            review: reviewResult.review,
            manifest: reviewResult.manifest,
          },
          { status: 200 },
        );
      }

      const result = await applyWorkshopManifest({
        userId: session.user.id,
        manifestYaml,
      });
      return NextResponse.json(result, { status: 201 });
    }

    const name = String(body.name ?? "").trim();
    const mission = String(body.mission ?? "").trim();

    if (!name || !mission) {
      return NextResponse.json(
        { error: "name and mission are required" },
        { status: 400 },
      );
    }

    const workshop = await createWork({
      source: "owner",
      reason: "Created from workshop API.",
      input: {
        userId: session.user.id,
        name,
        mission,
        autonomyLevel: body.autonomyLevel,
        boundaryPolicy: body.boundaryPolicy,
        modelConfig: body.modelConfig ?? {},
      },
    });

    return NextResponse.json({ workshop }, { status: 201 });
  } catch (error) {
    console.error("[WorkshopsAPI] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create workshop" },
      { status: 500 },
    );
  }
}
