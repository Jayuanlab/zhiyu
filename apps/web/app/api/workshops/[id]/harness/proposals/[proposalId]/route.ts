import { auth } from "@/app/(auth)/auth";
import {
  harnessEvolutionRepository,
  runPersistedHarnessEvaluationCampaign,
  activateMemoryPolicy,
  rollbackMemoryPolicy,
} from "@/lib/harness-evolution";
import { appendWorkshopEvent, getWorkshop } from "@/lib/workshops/service";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const ACTIONS = [
  "approve",
  "reject",
  "materialize_candidate",
  "begin_evaluation",
  "discard_candidate",
  "activate_memory_policy",
  "rollback_memory_policy",
] as const;
type ProposalAction = (typeof ACTIONS)[number];

function proposalAction(value: unknown): ProposalAction | null {
  return ACTIONS.includes(value as ProposalAction)
    ? (value as ProposalAction)
    : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; proposalId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id, proposalId } = await params;
    const workshop = await getWorkshop(session.user.id, id);
    if (!workshop) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      reason?: unknown;
      commandId?: unknown;
      expectedVersion?: unknown;
      campaignId?: unknown;
    };
    const action = proposalAction(body.action);
    if (!action) {
      return NextResponse.json(
        { error: "Invalid proposal action" },
        { status: 400 },
      );
    }
    const current = await harnessEvolutionRepository.getProposal(
      id,
      proposalId,
    );
    if (!current) {
      return NextResponse.json(
        { error: "Proposal not found" },
        { status: 404 },
      );
    }

    let proposal = current;
    let candidate = null;
    let evaluation = null;
    let memoryPolicy = null;
    if (action === 'activate_memory_policy' || action === 'rollback_memory_policy') {
      if (typeof body.commandId !== 'string' || !body.commandId.trim() || body.commandId.length > 256
        || typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0
        || action === 'activate_memory_policy' && (typeof body.campaignId !== 'string' || !body.campaignId.trim())) {
        return NextResponse.json({ error: 'Memory policy commands require commandId, expectedVersion and an activation campaignId.' }, { status: 400 });
      }
      const command = { principal: { kind: 'owner' as const, userId: session.user.id }, workshopId: id, proposalId,
        commandId: body.commandId, expectedVersion: body.expectedVersion };
      memoryPolicy = action === 'activate_memory_policy'
        ? await activateMemoryPolicy({ ...command, campaignId: body.campaignId as string })
        : await rollbackMemoryPolicy(command);
    } else if (action === "approve") {
      const snapshot = await harnessEvolutionRepository.getLatestSnapshot(id);
      if (!snapshot) throw new Error("No active Harness snapshot exists.");
      proposal = await harnessEvolutionRepository.transitionProposal({
        workshopId: id,
        proposalId,
        expectedStatus: "proposed",
        nextStatus: "approved",
        currentBase: {
          workVersionId: snapshot.workVersionId,
          harnessSnapshotId: snapshot.id,
          componentSetHash: snapshot.componentSetHash,
        },
      });
    } else if (action === "reject") {
      proposal = await harnessEvolutionRepository.transitionProposal({
        workshopId: id,
        proposalId,
        expectedStatus: current.status,
        nextStatus: "rejected",
      });
    } else if (action === "materialize_candidate") {
      const result = await harnessEvolutionRepository.materializeCandidate({
        workshopId: id,
        proposalId,
        expectedStatus: "approved",
      });
      proposal = result.proposal;
      candidate = result.snapshot;
    } else if (action === "begin_evaluation") {
      if (current.changes.some(change => Object.hasOwn(change.patch, "memoryUsageContract"))) {
        return NextResponse.json({ error: "Memory candidates require a frozen-source isolated model executor; configure and run that evaluation before activation." }, { status: 409 });
      }
      const [baseline, candidateSnapshot, suite] = await Promise.all([
        harnessEvolutionRepository.getSnapshot(
          id,
          current.baseHarnessSnapshotId,
        ),
        harnessEvolutionRepository.getLatestSnapshot(id, "candidate"),
        harnessEvolutionRepository.getEvaluationSuite(
          current.evaluationSuiteId,
        ),
      ]);
      if (!baseline || !candidateSnapshot || !suite) {
        throw new Error(
          "Proposal baseline, candidate, or evaluation suite is missing.",
        );
      }
      const candidateRevisionIds = new Set(
        candidateSnapshot.components.map((component) => component.revisionId),
      );
      if (
        current.changes.some(
          (change) =>
            !change.afterRevisionId ||
            !candidateRevisionIds.has(change.afterRevisionId),
        )
      ) {
        throw new Error(
          "The latest candidate snapshot does not belong to this proposal.",
        );
      }
      const existingCampaign = (
        await harnessEvolutionRepository.listEvaluationCampaigns(id, 50)
      ).find(
        (campaign) =>
          campaign.changeProposalId === current.id &&
          campaign.status === "pending",
      );
      const campaign =
        existingCampaign ??
        (await harnessEvolutionRepository.createEvaluationCampaign({
          workshopId: id,
          suiteId: suite.id,
          baselineWorkVersionId: baseline.workVersionId,
          candidateWorkVersionId: candidateSnapshot.workVersionId,
          baselineHarnessSnapshotId: baseline.id,
          candidateHarnessSnapshotId: candidateSnapshot.id,
          changeProposalId: current.id,
          runtimeContract: {
            shared: {
              engine: "builtin-deterministic-v1",
              platformVersion: baseline.platformVersion,
            },
          },
          budget: {
            maxRuns: 100,
            minimumSampleSize: Math.min(
              ...suite.scenarios.map((scenario) => scenario.repetitions),
            ),
            regressionBudget: {
              taskScore: 0,
              boundaryPass: 0,
              freshTop3Rate: 0,
              boundaryRecallRate: 0,
            },
          },
        }));
      evaluation = await runPersistedHarnessEvaluationCampaign({
        workshopId: id,
        campaignId: campaign.id,
      });
      proposal =
        (await harnessEvolutionRepository.getProposal(id, proposalId)) ??
        current;
    } else {
      proposal = await harnessEvolutionRepository.discardCandidate({
        workshopId: id,
        proposalId,
        expectedStatus:
          current.status === "evaluating" ||
          current.status === "confirmed" ||
          current.status === "partial"
            ? current.status
            : "canary",
        reason:
          typeof body.reason === "string"
            ? body.reason
            : "Owner discarded candidate",
      });
    }

    await appendWorkshopEvent({
      workshopId: id,
      type: `harness_change_${action}`,
      title: `Harness proposal ${action.replaceAll("_", " ")}`,
      body: typeof body.reason === "string" ? body.reason : null,
      metadata: {
        proposalId,
        status: proposal.status,
        candidateSnapshotId: candidate?.id ?? null,
        evaluationStatus: evaluation?.campaignStatus ?? null,
        memoryPolicy,
      },
    });
    return NextResponse.json({ ok: true, proposal, candidate, evaluation, memoryPolicy });
  } catch (error) {
    console.error("[HarnessProposalActionAPI] POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Proposal action failed",
      },
      { status: 409 },
    );
  }
}
