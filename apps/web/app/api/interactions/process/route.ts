import { auth } from "@/app/(auth)/auth";
import { clearAIUserContext, setAIUserContextFromRequest } from "@/lib/ai";
import { processInteractionEvents } from "@/lib/interactions/processor";
import {
  clearInteractionWikiItems,
  listInteractionEvents,
} from "@/lib/interactions/service";
import { listInteractionSourcePolicies } from "@/lib/knowledge-pipeline/source-policies";
import { appendWorkshopEvent, getWorkshop } from "@/lib/workshops/service";
import { NextResponse, type NextRequest } from "next/server";
import pLimit from "p-limit";
import {
  isInteractionEventAllowedBySourcePolicy,
  processingModeForSourcePolicy,
  sourcePolicyMentionAliases,
  type InteractionProcessingMode,
} from "@/lib/knowledge-pipeline/source-policy-runtime";

export const dynamic = "force-dynamic";

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = typeof value === "number" ? value : Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function envConcurrency(name: string, fallback: number, max: number) {
  return boundedNumber(process.env[name], fallback, 1, max);
}

async function collectSelectedSourceEventIds(input: {
  userId: string;
  limit: number;
  perSourceLimit: number;
  since?: Date;
  userName?: string | null;
  displayName?: string | null;
}) {
  const policies = await listInteractionSourcePolicies({
    userId: input.userId,
    platform: "wechat",
  });
  const allowedPolicies = new Set(["sync", "summary", "mention_only"]);
  const sources = policies.filter(
    (policy) => policy.enabled && allowedPolicies.has(policy.policy),
  );

  const sourceLimit = pLimit(
    envConcurrency("INTERACTION_SOURCE_QUERY_CONCURRENCY", 4, 8),
  );
  const collected = await Promise.all(
    sources.map((source) =>
      sourceLimit(async () => {
        const events = await listInteractionEvents({
          userId: input.userId,
          platform: "wechat",
          conversationId: source.sourceId,
          since: input.since,
          limit: input.perSourceLimit,
        });
        const allowedEvents = events.filter((event) =>
          isInteractionEventAllowedBySourcePolicy({
            policy: source.policy,
            event,
            mentionAliases: sourcePolicyMentionAliases({
              userName: input.userName,
              displayName: input.displayName,
              metadata: source.metadata,
            }),
          }),
        );
        return {
          source: {
            sourceId: source.sourceId,
            sourceName: source.sourceName,
            eventCount: allowedEvents.length,
          },
          processingMode: processingModeForSourcePolicy(source.policy),
          eventIds: allowedEvents.map((event) => event.id),
        };
      }),
    ),
  );
  const sourceResults = collected.map((result) => result.source);
  let remaining = input.limit;
  const batches = collected
    .map((result) => {
      const eventIds = result.eventIds.slice(0, remaining);
      remaining -= eventIds.length;
      return {
        sourceId: result.source.sourceId,
        processingMode: result.processingMode,
        eventIds,
      };
    })
    .filter((batch) => batch.eventIds.length > 0);

  return {
    eventIds: [...new Set(batches.flatMap((batch) => batch.eventIds))],
    batches,
    sources: sourceResults,
  };
}

async function processInChunks(input: {
  userId: string;
  batches: Array<{
    eventIds: string[];
    processingMode: InteractionProcessingMode;
  }>;
  chunkSize: number;
  fallbackToSummary: boolean;
}) {
  const chunks: Array<{
    eventIds: string[];
    processingMode: InteractionProcessingMode;
  }> = [];
  for (const batch of input.batches) {
    for (let index = 0; index < batch.eventIds.length; index += input.chunkSize) {
      chunks.push({
        eventIds: batch.eventIds.slice(index, index + input.chunkSize),
        processingMode: batch.processingMode,
      });
    }
  }

  const chunkLimit = pLimit(
    envConcurrency("INTERACTION_PROCESSOR_CONCURRENCY", 2, 4),
  );
  const results = await Promise.all(
    chunks.map((chunk) =>
      chunkLimit(() =>
        processInteractionEvents({
          userId: input.userId,
          eventIds: chunk.eventIds,
          fallbackToSummary: input.fallbackToSummary,
          processingMode: chunk.processingMode,
        }),
      ),
    ),
  );

  return {
    mode: results.some((result) => result.mode === "llm")
      ? "llm"
      : (results[0]?.mode ?? "skipped"),
    model: results.find((result) => result.model)?.model,
    processedEventIds: results.flatMap((result) => result.processedEventIds),
    notes: results.flatMap((result) => result.notes),
    tasks: results.flatMap((result) => result.tasks),
    memories: results.flatMap((result) => result.memories),
    scenarioSnapshots: {
      createdCount: results.reduce(
        (sum, result) => sum + (result.scenarioSnapshots?.createdCount ?? 0),
        0,
      ),
      scenarioKeys: [
        ...new Set(
          results.flatMap(
            (result) => result.scenarioSnapshots?.scenarioKeys ?? [],
          ),
        ),
      ],
    },
    chunks: results,
    error: results
      .map((result) => result.error)
      .filter(Boolean)
      .join("\n"),
  };
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    await setAIUserContextFromRequest({
      userId: session.user.id,
      email: session.user.email ?? "",
      name: session.user.name ?? session.user.displayName ?? null,
      userType: session.user.type,
      request,
      body: {
        ...body,
        cloudAuthToken: body.cloudAuthToken ?? session.cloudAuthToken,
      },
    });
    const requestMode = String(body.mode ?? "").trim();
    if (requestMode === "selected_sources") {
      const sinceDays = boundedNumber(body.sinceDays, 0, 0, 365);
      const since =
        sinceDays > 0
          ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
          : undefined;
      const selected = await collectSelectedSourceEventIds({
        userId: session.user.id,
        limit: boundedNumber(body.limit, 500, 1, 1000),
        perSourceLimit: boundedNumber(body.perSourceLimit, 200, 1, 500),
        since,
        userName: session.user.name,
        displayName: session.user.displayName,
      });

      if (selected.eventIds.length === 0) {
        return NextResponse.json({
          mode: "skipped",
          processedEventIds: [],
          notes: [],
          tasks: [],
          memories: [],
          sources: selected.sources,
          error:
            sinceDays > 0
              ? `No stored events found for enabled sources in the last ${sinceDays} day(s).`
              : "No stored events found for enabled sources.",
        });
      }

      const clearExisting = body.clearExisting !== false;
      const result = await processInChunks({
        userId: session.user.id,
        batches: selected.batches,
        chunkSize: boundedNumber(body.chunkSize, 40, 1, 80),
        fallbackToSummary: body.fallbackToSummary !== false,
      });
      const cleared = clearExisting
        ? await clearInteractionWikiItems({
            userId: session.user.id,
            reason: "user_regenerated_wiki",
            preserve: {
              noteIds: result.notes.map((item) => item.id),
              taskIds: result.tasks.map((item) => item.id),
              memoryIds: result.memories.map((item) => item.id),
            },
          })
        : null;

      return NextResponse.json({
        ...result,
        mode: "reprocess_existing",
        sources: selected.sources,
        sinceDays,
        since: since?.toISOString() ?? null,
        cleared,
      });
    }

    const eventIds = stringArray(body.eventIds);
    if (eventIds.length === 0) {
      return NextResponse.json(
        { error: "eventIds are required" },
        { status: 400 },
      );
    }

    const result = await processInteractionEvents({
      userId: session.user.id,
      eventIds,
      fallbackToSummary: body.fallbackToSummary !== false,
    });

    const workshopId =
      typeof body.workshopId === "string" && body.workshopId.trim()
        ? body.workshopId.trim()
        : undefined;
    if (workshopId) {
      const workshop = await getWorkshop(session.user.id, workshopId);
      if (workshop) {
        await appendWorkshopEvent({
          workshopId,
          type: "interaction_processor_completed",
          title: "Interaction processor completed",
          body: `${result.mode}: ${result.notes.length} note(s), ${result.tasks.length} task(s), ${result.memories.length} memory candidate(s).`,
          metadata: {
            mode: result.mode,
            model: result.model,
            processedEventIds: result.processedEventIds,
            noteCount: result.notes.length,
            taskCount: result.tasks.length,
            memoryCount: result.memories.length,
            error: result.error,
          },
        });
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[InteractionProcessAPI] POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process interaction events",
      },
      { status: 500 },
    );
  } finally {
    clearAIUserContext();
  }
}
