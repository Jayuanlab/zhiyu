import { sql } from "drizzle-orm";
import { acceptLocalWorkCommand, executeLocalWorkCommand } from "@/lib/work-runtime/command-ledger";
import { closePostgresDb } from "@/lib/db/adapters/postgres";
if (process.env.ZHIYU_TEST_MODE !== "integration") throw new Error("Isolated fixture required");
const ownerId = process.env.ZHIYU_TEST_OWNER_ID!, workId = process.env.ZHIYU_TEST_WORK_ID!, commandId = process.env.ZHIYU_TEST_COMMAND_ID!;
process.send?.({type: "ready", pid: process.pid});
process.once("message", async () => {
  try {
    await acceptLocalWorkCommand({ownerId, workId, commandId, type: "fixture.increment", expectedVersion: Number(process.env.ZHIYU_TEST_VERSION ?? 0), payload: {increment: 1}});
    const result = await executeLocalWorkCommand(ownerId, commandId, "fixture.increment", async (tx) => {
      const rows = await tx.execute(sql`UPDATE workshops SET name=(name::int+1)::text WHERE id=${workId}::uuid RETURNING name`);
      if (process.env.ZHIYU_TEST_CRASH === "true") {
        process.send?.({type: "uncommitted", pid: process.pid});
        await new Promise(() => {});
      }
      return {count: Number(rows[0].name)};
    });
    process.send?.({type: "result", pid: process.pid, result});
  } catch (error) { process.send?.({type: "failure", message: String(error)}); process.exitCode = 1; }
  finally { await closePostgresDb(); process.disconnect(); }
});
