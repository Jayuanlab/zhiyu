import type { WorkshopWriteContext } from "@/lib/workshops/service";
import type { WorkCommandMeta } from "./types";
import type { CommandJson } from "./command-payload";
import type { ExecutionLease } from "./execution-lease";
import { WorkshopConfigurationConflict, WorkshopAgentChangeStaleProposalError, WorkshopProposalConflict } from "@/lib/workshops/configuration-identity";
import { acceptLocalWorkCommand, executeLocalWorkCommand, getWorkCommand, getWorkCommandVersion, prepareLocalWorkCommand, throwWorkCommandFailure, WorkCommandConflict } from "./command-ledger";

// Receipts preserve Date instances without interpreting arbitrary payload strings.
export function encodeCommandResult(value: unknown): CommandJson {
  const dates: string[][] = [];
  const ancestors = new Set<object>();
  function visit(item: unknown, path: string[]) {
    if (item instanceof Date) {
      if (!Number.isFinite(item.getTime())) throw new Error("Invalid command date");
      dates.push(path); return;
    }
    if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new Error("Cyclic command value");
      ancestors.add(item);
      for (const key of Object.keys(item)) visit((item as Record<string, unknown>)[key], [...path, key]);
      ancestors.delete(item);
    }
  }
  visit(value, []);
  dates.sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a === b ? 0 : a < b ? -1 : 1;
  });
  return {value: JSON.parse(JSON.stringify(value)), dates};
}
export function decodeCommandResult<T>(encoded: CommandJson): T {
  const {value, dates} = structuredClone(encoded) as {value: any; dates: string[][]};
  for (const path of dates) {
    if (!path.length) return new Date(value) as T;
    let parent = value;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path[path.length - 1]] = new Date(parent[path[path.length - 1]]);
  }
  return value as T;
}

/** Database-only adapter; no model, network, process or detached work here. */
async function acceptDatabaseCommand<C extends WorkCommandMeta & {userId: string; workId: string}>(command: C, type: string) {
  if (command.commandId !== undefined && (typeof command.commandId !== "string" || !command.commandId.trim() || command.commandId.length > 256)) throw new WorkCommandConflict("invalid_command");
  if (command.expectedVersion !== undefined && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0 || command.expectedVersion >= 2147483647)) throw new WorkCommandConflict("invalid_command");
  const commandId = command.commandId ?? crypto.randomUUID();
  const previous = await getWorkCommand(command.userId, commandId);
  const expectedVersion = command.expectedVersion ?? previous?.expectedVersion ?? await getWorkCommandVersion(command.userId, command.workId);
  const persisted = {...command, commandId, expectedVersion, source: command.source ?? "owner", reason: command.reason ?? null};
  await acceptLocalWorkCommand({ownerId: command.userId, workId: command.workId, commandId, type, expectedVersion, payload: encodeCommandResult(persisted)});
  return commandId;
}

export async function runDatabaseWorkCommand<C extends WorkCommandMeta & {userId: string; workId: string}, T>(
  command: C, type: string, handler: (persisted: C, context: WorkshopWriteContext) => Promise<T>,
  executionLease?: ExecutionLease,
): Promise<T> {
  const commandId = await acceptDatabaseCommand(command, type);
  const receipt = await executeLocalWorkCommand(command.userId, commandId, type, async (tx, payload, append) => {
    try { return encodeCommandResult(await handler(decodeCommandResult<C>(payload), {db: tx, append})); }
    catch (error) {
      if (error instanceof WorkshopConfigurationConflict) throw new WorkCommandConflict("manifest_identity_reserved");
      if (error instanceof WorkshopAgentChangeStaleProposalError) throw new WorkCommandConflict("WORK_VERSION_STALE");
      if (error instanceof WorkshopProposalConflict) throw new WorkCommandConflict(error.code);
      throw error;
    }
  }, executionLease);
  if (receipt.status !== "succeeded") throwWorkCommandFailure(receipt.errorCode);
  return decodeCommandResult<T>(receipt.result);
}

/** prepare is read-only; apply is database-only. Only the durable winning draft
 * reaches apply, and an explicit retry reuses it after a failed transaction. */
export async function runPreparedDatabaseWorkCommand<C extends WorkCommandMeta & {userId: string; workId: string}, P, T>(
  command: C, type: string, prepare: (persisted: C) => Promise<P>,
  apply: (persisted: C, prepared: P, context: WorkshopWriteContext) => Promise<T>,
  executionLease?: ExecutionLease,
): Promise<T> {
  const commandId = await acceptDatabaseCommand(command, type);
  const prepared = await prepareLocalWorkCommand(command.userId, commandId,
    async payload => encodeCommandResult(await prepare(decodeCommandResult<C>(payload))));
  const receipt = await executeLocalWorkCommand(command.userId, commandId, type, async (tx, payload, append) => {
    if (prepared.preparedPayload === null) throw new Error("Command preparation missing");
    return encodeCommandResult(await apply(decodeCommandResult<C>(payload), decodeCommandResult<P>(prepared.preparedPayload), {db: tx, append}));
  }, executionLease);
  if (receipt.status !== "succeeded") throwWorkCommandFailure(receipt.errorCode);
  return decodeCommandResult<T>(receipt.result);
}
