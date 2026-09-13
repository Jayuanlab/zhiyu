import { sql } from "drizzle-orm";
import { withWorkshopEventTransaction } from "@/lib/workshops/event-write";

const workId = process.env.ZHIYU_TEST_WORK_ID!;
if (process.env.ZHIYU_TEST_MODE !== "integration" || !workId) throw new Error("Isolated fixture required");
await withWorkshopEventTransaction(async (tx, append) => {
  await tx.execute(sql`UPDATE workshops SET name='uncommitted-crash' WHERE id=${workId}::uuid`);
  await append({workshopId: workId, type: "observation", title: "uncommitted crash event"});
  process.send?.({type: "uncommitted", pid: process.pid});
  await new Promise(() => {}); // Parent kills only this isolated writer.
});
