import { and, desc, eq, gt } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import { resolveExecutionLease } from '@/lib/work-runtime/execution-context';
import { withExecutionBusinessWrite } from '@/lib/work-runtime/execution-lease';
import {
  encryptToken,
  decryptToken,
} from '@openzhiyu/security/token-encryption';
import {
  dailyAccounts,
  dailyDays,
  dailySources,
  dailyEvents,
  dailyCommands,
  dailyFeedback,
} from './schema';
import {
  DayError,
  type Snapshot,
  type Account,
  type DayState,
  type Source,
} from './contracts';
const encode = (value: unknown) => encryptToken(JSON.stringify(value));
const decode = <T>(value: string): T => JSON.parse(decryptToken(value));
const whereOwner = (table: { ownerId: any }, owner: string) =>
  eq(table.ownerId, owner);
export async function readDaySnapshot(
  owner: string,
  store: any = db,
  all = false,
): Promise<Snapshot> {
  const [account] = await store
    .select()
    .from(dailyAccounts)
    .where(whereOwner(dailyAccounts, owner));
  if (!account)
    return {
      revision: 0,
      account: { profile: null, foods: [] },
      days: {},
      sources: [],
      observations: [],
      events: [],
    };
  const [days, sources, events] = await Promise.all([
    store
      .select()
      .from(dailyDays)
      .where(whereOwner(dailyDays, owner))
      .orderBy(desc(dailyDays.date))
      .limit(all ? 100000 : 60),
    store.select().from(dailySources).where(whereOwner(dailySources, owner)),
    store
      .select()
      .from(dailyEvents)
      .where(whereOwner(dailyEvents, owner))
      .orderBy(desc(dailyEvents.createdAt))
      .limit(all ? 100000 : 1000),
  ]);
  if (all && (events.length >= 100000 || days.length >= 100000))
    throw new DayError('export_limit_reached', 413);
  const decodedEvents = events.map((row: any) => ({
    id: row.id,
    kind: row.kind,
    at: row.createdAt.toISOString(),
    payload: decode<any>(row.encrypted),
  }));
  return {
    revision: account.revision,
    account: decode<Account>(account.encrypted),
    days: Object.fromEntries(
      days.map((row: any) => [row.date, decode<DayState>(row.encrypted)]),
    ),
    sources: sources.map((row: any) => decode<Source>(row.encrypted)),
    observations: decodedEvents.flatMap((e: any) =>
      e.kind === 'feedback_processed'
        ? (e.payload.observations ?? [])
        : ['observation', 'execution'].includes(e.kind) && e.payload.observation
          ? [e.payload.observation]
          : [],
    ),
    events: decodedEvents,
  };
}
export type DayWrite = {
  account?: Account;
  days?: Record<string, DayState>;
  sources?: Source[];
  event?: { kind: string; payload: unknown };
  result?: unknown;
  erase?: boolean;
};
export type StoreCommand = {
  commandId: string;
  expectedRevision: number;
  operation: string;
};
/** Owner lock serializes snapshot mutations; model/network work stays outside. */
export async function dayTransaction<T extends StoreCommand>(
  owner: string,
  command: T,
  work: (snapshot: Snapshot, store: any) => Promise<DayWrite> | DayWrite,
  options: {
    reserve?: boolean;
    finish?: boolean;
    expectedRevision?: number;
  } = {},
) {
  const hash = createHash('sha256')
    .update(JSON.stringify(command))
    .digest('hex');
  const mutate = async (store: any) => {
    await store
      .insert(dailyAccounts)
      .values({
        ownerId: owner,
        encrypted: encode({ profile: null, foods: [] }),
      })
      .onConflictDoNothing();
    const [account] = await store
      .select()
      .from(dailyAccounts)
      .where(whereOwner(dailyAccounts, owner))
      .for('update');
    const [prior] = await store
      .select()
      .from(dailyCommands)
      .where(
        and(
          whereOwner(dailyCommands, owner),
          eq(dailyCommands.id, command.commandId),
        ),
      );
    if (prior) {
      if (prior.requestHash !== hash)
        throw new DayError('command_conflict', 409);
      if (prior.state === 'completed')
        return {
          replayed: true,
          result: prior.encrypted ? decode<any>(prior.encrypted) : null,
        };
      if (prior.state === 'failed') throw new DayError('command_failed', 409);
      if (!options.finish)
        throw new DayError(
          prior.state === 'pending' ? 'command_pending' : 'command_failed',
          409,
          command.commandId,
        );
    } else if (options.finish) throw new DayError('command_not_found', 404);
    if (
      account.revision !==
      (options.expectedRevision ?? command.expectedRevision)
    )
      throw new DayError('version_conflict', 409);
    if (!prior && options.reserve) {
      const [pending] = await store
        .select()
        .from(dailyCommands)
        .where(
          and(
            whereOwner(dailyCommands, owner),
            eq(dailyCommands.state, 'pending'),
          ),
        )
        .limit(1);
      if (pending)
        throw new DayError('another_command_pending', 409, pending.id);
    }
    if (!prior)
      await store.insert(dailyCommands).values({
        ownerId: owner,
        id: command.commandId,
        requestHash: hash,
        state: 'pending',
      });
    const snapshot = await readDaySnapshot(owner, store),
      write = await work(snapshot, store);
    if (options.reserve && !write.days && !write.account && !write.event)
      return { replayed: false, result: write.result };
    if (write.erase) {
      for (const table of [
        dailyFeedback,
        dailyEvents,
        dailyCommands,
        dailySources,
        dailyDays,
        dailyAccounts,
      ])
        await store.delete(table).where(whereOwner(table, owner));
      return { replayed: false, result: { erased: true } };
    }
    if (write.account)
      await store
        .update(dailyAccounts)
        .set({ encrypted: encode(write.account) })
        .where(whereOwner(dailyAccounts, owner));
    for (const [date, value] of Object.entries(write.days ?? {}))
      await store
        .insert(dailyDays)
        .values({ ownerId: owner, date, encrypted: encode(value) })
        .onConflictDoUpdate({
          target: [dailyDays.ownerId, dailyDays.date],
          set: { encrypted: encode(value) },
        });
    for (const source of write.sources ?? [])
      await store
        .insert(dailySources)
        .values({ ownerId: owner, id: source.id, encrypted: encode(source) })
        .onConflictDoUpdate({
          target: [dailySources.ownerId, dailySources.id],
          set: { encrypted: encode(source) },
        });
    if (write.event)
      await store.insert(dailyEvents).values({
        id: randomUUID(),
        ownerId: owner,
        commandId: command.commandId,
        kind: write.event.kind,
        encrypted: encode(write.event.payload),
      });
    await store
      .update(dailyAccounts)
      .set({ revision: account.revision + 1, updatedAt: new Date() })
      .where(whereOwner(dailyAccounts, owner));
    if (options.reserve) return { replayed: false, result: write.result };
    const result = write.result ?? { revision: account.revision + 1 };
    await store
      .update(dailyCommands)
      .set({ state: 'completed', encrypted: encode(result) })
      .where(
        and(
          whereOwner(dailyCommands, owner),
          eq(dailyCommands.id, command.commandId),
        ),
      );
    return { replayed: false, result };
  };
  const lease = resolveExecutionLease();
  if (lease) {
    if (lease.userId !== owner) throw new DayError('owner_mismatch', 403);
    return withExecutionBusinessWrite({ ...lease }, (context) =>
      mutate(context.db),
    );
  }
  return db.transaction(mutate);
}
export async function failDayCommand(owner: string, id: string, code: string) {
  const write = async (store: any) =>
    store
      .update(dailyCommands)
      .set({ state: 'failed', encrypted: encode({ error: code }) })
      .where(
        and(
          whereOwner(dailyCommands, owner),
          eq(dailyCommands.id, id),
          eq(dailyCommands.state, 'pending'),
        ),
      );
  const lease = resolveExecutionLease();
  if (lease) {
    if (lease.userId !== owner) throw new DayError('owner_mismatch', 403);
    await withExecutionBusinessWrite({ ...lease }, (context) =>
      write(context.db),
    );
  } else await write(db);
}
export async function dayCommandStatus(owner: string, id: string) {
  const [record] = await db
    .select()
    .from(dailyCommands)
    .where(and(whereOwner(dailyCommands, owner), eq(dailyCommands.id, id)));
  if (!record) throw new DayError('command_not_found', 404);
  return {
    id,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.encrypted ? { result: decode(record.encrypted) } : {}),
  };
}
export async function pendingDayCommands(owner: string) {
  const records = await db
    .select({ id: dailyCommands.id, createdAt: dailyCommands.createdAt })
    .from(dailyCommands)
    .where(
      and(whereOwner(dailyCommands, owner), eq(dailyCommands.state, 'pending')),
    )
    .limit(10);
  return records.map((record: { id: string; createdAt: Date }) => ({
    ...record,
    stale: Date.now() - record.createdAt.getTime() > 120000,
  }));
}
export async function releasePendingDayCommand(
  owner: string,
  id: string,
  store: any,
) {
  const [record] = await store
    .select()
    .from(dailyCommands)
    .where(and(whereOwner(dailyCommands, owner), eq(dailyCommands.id, id)))
    .for('update');
  if (!record || record.state !== 'pending')
    throw new DayError('command_not_pending', 409);
  if (Date.now() - record.createdAt.getTime() < 120000)
    throw new DayError('command_still_running', 409);
  await store
    .update(dailyCommands)
    .set({
      state: 'failed',
      encrypted: encode({ error: 'interrupted_command_released' }),
    })
    .where(and(whereOwner(dailyCommands, owner), eq(dailyCommands.id, id)));
}
