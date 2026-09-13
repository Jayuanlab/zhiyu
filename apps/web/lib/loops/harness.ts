import type { JobExecutionResult } from "@/lib/cron/types";
import type { LoopJson, RunNativeLoopInput } from "./types";
import type { LoopModelChecker } from "./checker";
import { executeNativeLoopAgent } from "./native-executor";
import { runNativeLoopOnce, runAcceptedNativeLoopOnce } from "./runtime";
import {executeAcceptedWorkLoop,type LoopExecutionControl} from '@/lib/work-runtime/loop-execution';
import type {AcceptWorkLoopCommand} from '@/lib/work-runtime/loop-command';

export async function executeNativeLoopCommand(command:AcceptWorkLoopCommand,control?:LoopExecutionControl){
  return executeAcceptedWorkLoop(command,async abortController=>{
    const execution=await runLoopHarness({userId:command.userId,loopId:command.loopId,mode:command.mode,triggeredBy:command.triggeredBy,reason:command.triggerReason,ownedExecution:{abortController}});
    return execution.result;
  },undefined,control);
}

export type LoopRunHarnessMode = "dry_run" | "native_agent";

export interface RunLoopHarnessInput {
  userId: string;
  loopId: string;
  commandId?: string;
  expectedVersion?: number;
  mode: LoopRunHarnessMode;
  triggeredBy: RunNativeLoopInput["triggeredBy"];
  reason?: LoopJson;
  modelChecker?: LoopModelChecker | null;
  ownedExecution?: {abortController:AbortController};
}

export interface RunLoopHarnessOutput {
  result: JobExecutionResult;
  harness: {
    name: "loop-run-harness";
    mode: LoopRunHarnessMode;
    loopId: string;
    triggeredBy: RunNativeLoopInput["triggeredBy"];
  };
}

export async function runLoopHarness(
  input: RunLoopHarnessInput,
): Promise<RunLoopHarnessOutput> {
  const execute=input.ownedExecution
    ? (request:Parameters<typeof runNativeLoopOnce>[0])=>runAcceptedNativeLoopOnce(request,input.ownedExecution!.abortController)
    : runNativeLoopOnce;
  const result = await execute({
    userId: input.userId,
    loopId: input.loopId,
    commandId: input.commandId,
    expectedVersion: input.expectedVersion,
    triggeredBy: input.triggeredBy,
    reason: {
      ...(input.reason ?? {}),
      harness: "loop-run-harness",
      harnessMode: input.mode,
    },
    modelChecker: input.modelChecker,
    execute:
      input.mode === "dry_run"
        ? undefined
        : async ({ loop, previousState, loopRun, attemptContext, abortController }) => {
            return executeNativeLoopAgent({
              userId: input.userId,
              loop,
              previousState,
              runId: loopRun.id,
              attemptContext,
              abortController,
            });
          },
  });

  return {
    result,
    harness: {
      name: "loop-run-harness",
      mode: input.mode,
      loopId: input.loopId,
      triggeredBy: input.triggeredBy,
    },
  };
}
