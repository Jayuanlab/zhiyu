import { updateLoop } from "@/lib/loops";
import { summarizeLoopTask } from "@/lib/ai/loop-task-read-tools";

type LoopTaskControlResult = {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
};

export type LoopTaskStatusControl = "active" | "paused" | "archived";

function jsonResult(value: Record<string, unknown>, isError = false) {
  return {
    ok: !isError,
    text: JSON.stringify(value, null, 2),
    data: value,
    isError,
  } satisfies LoopTaskControlResult;
}

export function normalizeLoopTaskStatusControl(
  value: unknown,
): LoopTaskStatusControl | null {
  return value === "active" || value === "paused" || value === "archived"
    ? value
    : null;
}

export async function setLoopTaskStatusForUser(input: {
  userId: string;
  loopId: string;
  status: LoopTaskStatusControl;
  updateLoopRow?: typeof updateLoop;
}): Promise<LoopTaskControlResult> {
  const updateLoopRow = input.updateLoopRow ?? updateLoop;
  try {
    const loop = await updateLoopRow(input.userId, input.loopId, {
      status: input.status,
    });
    if (!loop) {
      return jsonResult(
        {
          success: false,
          message: `Loop not found: ${input.loopId}`,
        },
        true,
      );
    }
    return jsonResult({
      success: true,
      message: `Loop task is now ${input.status}.`,
      loop: summarizeLoopTask(loop),
    });
  } catch (error) {
    return jsonResult(
      {
        success: false,
        message: `Failed to update loop task: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      true,
    );
  }
}
