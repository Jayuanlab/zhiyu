import {
  resolveWorkshopAgentChangeProposal,
  type WorkshopAgentChangeAction,
} from "@/lib/workshops/agent-change-proposals";
import {
  resolveWatchlistProposal,
  type WatchlistProposalAction,
} from "@/lib/workshops/watchlist-proposals";
import { getWorkshop } from "@/lib/workshops/service";
import type { WorkCommandMeta } from "./types";
import {runDatabaseWorkCommand} from "./database-command";
import type {WorkshopWriteContext} from "@/lib/workshops/service";
import {WorkCommandConflict} from "./command-ledger";

function commandMetadata(meta: WorkCommandMeta) {
  return {
    commandId: meta.commandId ?? crypto.randomUUID(),
    source: meta.source ?? "owner",
    reason: meta.reason ?? null,
  };
}

async function requireWork(userId: string, workId: string) {
  const workshop = await getWorkshop(userId, workId);
  if (!workshop) {
    throw new Error("Workshop not found");
  }
  return workshop;
}

export async function resolveWorkAgentChangeProposal(
  input: {
    userId: string;
    workId: string;
    proposalEventId: string;
    action: WorkshopAgentChangeAction;
  } & WorkCommandMeta,
) {
  if (!["apply", "reject", "recreate"].includes(input.action)) throw new WorkCommandConflict("invalid_command");
  return runDatabaseWorkCommand(input, "resolveWorkAgentChangeProposal", applyWorkAgentChangeProposal);
}

async function applyWorkAgentChangeProposal(input: Parameters<typeof resolveWorkAgentChangeProposal>[0], context: WorkshopWriteContext) {
  const meta = commandMetadata(input);
  const result = await resolveWorkshopAgentChangeProposal({
    userId: input.userId,
    workshopId: input.workId,
    proposalEventId: input.proposalEventId,
    action: input.action,
    reason: meta.reason,
  }, context);
  return { ...result, command: meta };
}

export async function resolveWorkWatchlistProposal(
  input: {
    userId: string;
    workId: string;
    proposalEventId: string;
    action: WatchlistProposalAction;
    note?: string | null;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  await requireWork(input.userId, input.workId);
  const result = await resolveWatchlistProposal({
    workshopId: input.workId,
    eventId: input.proposalEventId,
    action: input.action,
    note: input.note ?? meta.reason,
  });
  return { ...result, command: meta };
}
