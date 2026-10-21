import { auth } from "@/app/(auth)/auth";
import { harnessEvolutionRepository, isWorkHarnessEvolutionEnabled, proposeMemoryPolicyCandidates } from "@/lib/harness-evolution";
import { appendWorkshopEvent, getWorkshop, listWorkshopEvents } from "@/lib/workshops/service";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  evidenceBundleId: z.string().min(1).max(256),
  evaluationSuiteId: z.string().min(1).max(256),
  developmentScenarioIds: z.array(z.string().min(1).max(256)).min(1).max(20),
}).strict();

/** An owner may generate bounded pending proposals from existing local evidence only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!(await getWorkshop(session.user.id, id))) return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    if (!isWorkHarnessEvolutionEnabled()) return NextResponse.json({ error: "Harness evidence capture is disabled" }, { status: 409 });
    const parsed = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Existing evidence, a suite and public development scenarios are required", issues: parsed.error.issues }, { status: 400 });
    const stored = await harnessEvolutionRepository.getEvidence(id, parsed.data.evidenceBundleId);
    if (!stored || stored.bundle.workId !== id || stored.bundle.userId !== session.user.id) return NextResponse.json({ error: "Memory trajectory evidence not found" }, { status: 404 });
    const bundle = stored.bundle;
    const runId = bundle.workRunId ?? bundle.loopRunId;
    if (!runId || bundle.captureStatus !== "finalized") return NextResponse.json({ error: "A finalized local run is required" }, { status: 409 });
    const [baseline, current, events] = await Promise.all([
      harnessEvolutionRepository.getResolvedSnapshot(id, bundle.harnessSnapshotId),
      harnessEvolutionRepository.getLatestSnapshot(id, "active"),
      listWorkshopEvents(id, { runId, limit: 501, order: "asc", types: ["working_memory_updated", "working_memory_rejected", "working_memory_restored", "working_memory_projected", "working_memory_usage"] }),
    ]);
    if (!baseline || !current || current.componentSetHash !== baseline.componentSetHash || current.workVersionId !== baseline.workVersionId) return NextResponse.json({ error: "The trajectory baseline differs from the active Harness" }, { status: 409 });
    if (events.length > 500) return NextResponse.json({ error: "Memory trajectory is too large for this bounded diagnosis; no partial candidate was generated" }, { status: 409 });
    const result = await proposeMemoryPolicyCandidates({ baseline, bundle, events: events.map((event: WorkshopEvent) => {
      const eventCreatedAt: unknown = event.createdAt;
      return { id: event.id, type: event.type, metadata: event.metadata ?? {},
        createdAt: eventCreatedAt instanceof Date ? eventCreatedAt.toISOString() : String(eventCreatedAt) };
    }), evaluationSuiteId: parsed.data.evaluationSuiteId, developmentScenarioIds: parsed.data.developmentScenarioIds });
    await appendWorkshopEvent({ workshopId: id, runId: bundle.workRunId ?? undefined, loopRunId: bundle.loopRunId ?? undefined,
      type: "memory_policy_candidates_proposed", title: "Memory strategy candidates prepared for owner review",
      metadata: { receiptAuthority: "runtime", evidenceBundleId: bundle.id, diagnosis: result.diagnosis,
        proposalIds: result.proposals.map((proposal) => proposal.id), maximumCandidates: 2, applied: false, modelEvaluationTriggered: false },
    });
    return NextResponse.json({ interfaceVersion: "memory-policy-candidates.v1", ...result, applied: false, modelEvaluationTriggered: false }, { status: result.proposals.length ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Memory candidate generation failed" }, { status: 409 });
  }
}
