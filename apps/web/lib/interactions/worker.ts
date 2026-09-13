import pLimit from "p-limit";
import type { InteractionProcessingMode } from "@/lib/knowledge-pipeline/source-policy-runtime";
import { processInteractionEvents } from "./processor";
import { listRunnableInteractionProcessingJobs } from "./processing-jobs";

function normalizeProcessingMode(value: string): InteractionProcessingMode {
  return value === "summary_only" ? "summary_only" : "full";
}

export async function runPendingInteractionProcessingJobs(input: {
  userId?: string;
  limit?: number;
  concurrency?: number;
  signal?: AbortSignal;
  runtimeInstanceId?: string;
}) {
  if (!input.userId || input.signal?.aborted) return { completed: 0, failed: 0, skipped: 0 };
  const jobs = await listRunnableInteractionProcessingJobs({
    userId: input.userId,
    limit: input.limit ?? 20,
  });
  const concurrency = Math.min(Math.max(input.concurrency ?? 2, 1), 4);
  const limiter = pLimit(concurrency);
  const results = await Promise.all(
    jobs.map((job) =>
      limiter(async () => {
        if (input.signal?.aborted || job.eventIds.length === 0) return "skipped" as const;
        try {
          const result = await processInteractionEvents({
            userId: input.userId as string,
            eventIds: job.eventIds,
            processingMode: normalizeProcessingMode(job.processingMode),
            processingJobId: job.id,
            ...(input.runtimeInstanceId ? {runtimeInstanceId:input.runtimeInstanceId} : {}),
            fallbackToSummary: true,
            ...(input.signal ? {signal:input.signal} : {}),
          });
          if(result.mode==='skipped')return 'skipped' as const;
          if(result.mode==='fallback_summary')return 'degraded' as const;
          return "completed" as const;
        } catch {
          return "failed" as const;
        }
      }),
    ),
  );
  return {
    completed: results.filter((result) => result === "completed" || result === 'degraded').length,
    ...(results.includes('degraded')?{degraded:results.filter(result=>result==='degraded').length}:{}),
    failed: results.filter((result) => result === "failed").length,
    skipped: results.filter((result) => result === "skipped").length,
  };
}
