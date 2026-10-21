import Module from "node:module";
import { eq, inArray } from "drizzle-orm";

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only" || request.includes("server-only")) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const args = new Set(process.argv.slice(2));
const explicitUserId =
  process.env.USER_ID ??
  process.argv
    .slice(2)
    .find((arg) => !arg.startsWith("--") && arg.trim().length > 0);

async function listUserIds() {
  const [{ db }, { interactionEvents }] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/db/schema"),
  ]);
  const rows = (await db
    .select({ userId: interactionEvents.userId })
    .from(interactionEvents)) as Array<{ userId: string | null }>;
  return [
    ...new Set(
      rows
        .map((row) => row.userId)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
}

async function backfillUser(userId: string) {
  const [
    {
      emptyBrainBackfillReport,
      interactionMemoryRowToBrainBackfill,
      trackBackfilledMemory,
      workshopMemoryRowToBrainBackfill,
    },
    { createObservation: createBrainObservation },
    { upsertBrainMemory },
  ] = await Promise.all([
    import("@/lib/memory/governance/backfill"),
    import("@/lib/memory/ingestion/observations"),
    import("@/lib/memory/revision/legacy-storage"),
  ]);
  const report = emptyBrainBackfillReport();
  const [{ db }, schema] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/db/schema"),
  ]);

  const [interactionMemoryRows, eventRows, workshopRows] = await Promise.all([
    db
      .select()
      .from(schema.interactionMemories)
      .where(eq(schema.interactionMemories.userId, userId)),
    db
      .select()
      .from(schema.interactionEvents)
      .where(eq(schema.interactionEvents.userId, userId)),
    db
      .select()
      .from(schema.workshops)
      .where(eq(schema.workshops.userId, userId)),
  ]);

  for (const row of interactionMemoryRows as any[]) {
    try {
      const memory = interactionMemoryRowToBrainBackfill(row);
      trackBackfilledMemory(report, memory);
      if (memory) await upsertBrainMemory(memory);
    } catch (error) {
      report.errors.push({
        id: String(row.id ?? "unknown"),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const workshops = new Map<string, { id: string; userId: string }>(
    (workshopRows as any[]).map((workshop) => [
      String(workshop.id),
      { id: String(workshop.id), userId: String(workshop.userId) },
    ]),
  );
  if (workshops.size > 0) {
    const workshopMemoryRows = await db
      .select()
      .from(schema.workshopMemories)
      .where(inArray(schema.workshopMemories.workshopId, [...workshops.keys()]));
    for (const row of workshopMemoryRows as any[]) {
      try {
        const workshop = workshops.get(String(row.workshopId));
        if (!workshop) {
          report.skipped += 1;
          continue;
        }
        const memory = workshopMemoryRowToBrainBackfill({ workshop, memory: row });
        trackBackfilledMemory(report, memory);
        await upsertBrainMemory(memory);
      } catch (error) {
        report.errors.push({
          id: String(row.id ?? "unknown"),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (const event of eventRows as any[]) {
    try {
      report.scanned += 1;
      await createBrainObservation({
        userId,
        sourceType: "interaction_event",
        sourceId: String(event.id),
        sourceEventId: String(event.id),
        observedAt: event.messageTime,
        content: String(event.content ?? event.contentPreview ?? ""),
        metadata: {
          platform: event.platform,
          source: event.source,
          conversationId: event.conversationId,
          conversationName: event.conversationName,
          senderName: event.senderName,
          direction: event.direction,
          dedupeKey: event.dedupeKey,
        },
      });
      report.observations += 1;
    } catch (error) {
      report.errors.push({
        id: String(event.id ?? "unknown"),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function main() {
  if(args.has('--dry-run'))throw Error('Use --canonical-dry-run for read-only canonical preview; legacy import dry-run is not implemented');
  const modes=['--canonical-prepare','--canonical-status','--canonical-approve','--canonical-pause','--canonical-resume','--canonical-apply','--canonical-rollback'];
  const selected=modes.filter(mode=>args.has(mode));
  if([...args].some(arg=>arg.startsWith('--canonical-')&&arg!=='--canonical-dry-run'&&!modes.includes(arg)))throw Error('Unknown canonical mode');
  if(selected.length>1||(selected.length&&args.has('--canonical-dry-run')))throw Error('Choose one canonical mode');
  if(selected.length){
    if(!explicitUserId||args.has('--all'))throw Error('Canonical batches require one explicit USER_ID');
    const option=(name:string)=>[...args].find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
    const batchId=option('batch-id');if(!batchId)throw Error('A stable --batch-id=<uuid> is required');
    const service=await import('@/lib/memory/governance/canonical-backfill');
    const mode=selected[0];const base={userId:explicitUserId,batchId};
    let result:unknown;
    if(mode==='--canonical-prepare')result=await service.prepareCanonicalBatch({...base,cursor:option('cursor'),limit:option('limit')?Number(option('limit')):undefined});
    else if(mode==='--canonical-status')result=await service.readCanonicalBatch(explicitUserId,batchId);
    else {
      const planHash=option('plan-hash');if(!planHash)throw Error('The reviewed --plan-hash=<hash> is required');
      if(mode==='--canonical-apply'||mode==='--canonical-rollback'){
        const commandId=option('command-id');
        if(!commandId)throw Error('Provide --command-id=<uuid>; reuse it only to retry the same operation');
        result=await (mode==='--canonical-apply'?service.applyCanonicalBatchPage:service.rollbackCanonicalBatchPage)({...base,planHash,commandId,limit:option('limit')?Number(option('limit')):undefined});
      }
      else {
        const commandId=option('command-id'),expectedVersion=option('expected-version');
        if(!commandId||!expectedVersion)throw Error('Provide --command-id=<uuid> and --expected-version=<version from canonical-status>; preserve both when retrying');
        result=await service.controlCanonicalBatch({...base,planHash,commandId,expectedVersion,action:mode.slice('--canonical-'.length) as 'approve'|'pause'|'resume'});
      }
    }
    console.log(JSON.stringify(result));
    const {closePostgresDb}=await import('@/lib/db/adapters/postgres');await closePostgresDb();return;
  }
  if(args.has('--canonical-dry-run')) {
    if(!explicitUserId||args.has('--all'))throw Error('Canonical preview requires one explicit USER_ID');
    const {previewCanonicalBackfill}=await import('@/lib/memory/governance/canonical-backfill-preview');
    let cursor:string|undefined;
    do {
      const page=await previewCanonicalBackfill({userId:explicitUserId,cursor});
      console.log(JSON.stringify(page));
      cursor=page.nextCursor??undefined;
    } while(cursor);
    const {closePostgresDb}=await import('@/lib/db/adapters/postgres');
    await closePostgresDb();
    return;
  }
  const userIds = args.has("--all")
    ? await listUserIds()
    : explicitUserId
      ? [explicitUserId]
      : [];
  if (userIds.length === 0) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/backfill-brain-memory.ts --all or USER_ID=<id> pnpm exec tsx scripts/backfill-brain-memory.ts",
    );
  }

  for (const userId of userIds) {
    const report = await backfillUser(userId);
    console.log(`[BrainBackfill] user=${userId} ${JSON.stringify(report)}`);
  }
}

main().catch((error) => {
  console.error("[BrainBackfill] failed", error);
  process.exit(1);
});
