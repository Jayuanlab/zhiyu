import { auth } from "@/app/(auth)/auth";
import {
  harnessEvolutionRepository,
  isWorkHarnessEvolutionEnabled,
  resolveCurrentWorkHarness,
} from "@/lib/harness-evolution";
import { getWorkshop, getWorkshopConfigurationBaseline } from "@/lib/workshops/service";
import { resolveWorkingMemoryActivation } from "@/lib/workshops/working-memory-strategy";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const workshop = await getWorkshop(session.user.id, id);
    if (!workshop) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }

    const enabled = isWorkHarnessEvolutionEnabled();
    const summaryOnly = request.nextUrl.searchParams.get("view") === "summary";
    if (summaryOnly) {
      const summary = await harnessEvolutionRepository.getSummary(id);
      return NextResponse.json({
        enabled,
        summary,
        interfaceVersion: "work-harness-summary.v1",
      });
    }

    const refresh = request.nextUrl.searchParams.get("refresh") !== "false";
    const resolved =
      enabled && refresh
        ? await resolveCurrentWorkHarness({
            userId: session.user.id,
            workId: id,
          })
        : null;
    const snapshot =
      resolved?.snapshot ??
      (await harnessEvolutionRepository.getLatestSnapshot(id, "active"));
    const [candidateSnapshot, summary, baseline] = await Promise.all([
      harnessEvolutionRepository.getLatestSnapshot(id, "candidate"),
      harnessEvolutionRepository.getSummary(id),
      getWorkshopConfigurationBaseline(session.user.id, id),
    ]);
    if (!baseline) return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    const memoryPolicy = resolveWorkingMemoryActivation(baseline.workshop.modelConfig, id);
    return NextResponse.json({
      enabled,
      snapshot,
      candidateSnapshot,
      summary,
      commandVersion: baseline.commandVersion,
      memoryPolicy: {
        identity: memoryPolicy.identity, bindingStatus: memoryPolicy.bindingStatus,
        issues: memoryPolicy.issues,
        binding: baseline.workshop.modelConfig?.memoryPolicyBinding ?? null,
      },
      interfaceVersion: "work-harness-api.v1",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[WorkHarnessAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Work Harness",
      },
      { status: 500 },
    );
  }
}
