import { appendWorkshopEvent } from "@/lib/workshops/service";
import { closePostgresDb } from "@/lib/db/adapters/postgres";

const workId = process.env.ZHIYU_TEST_WORK_ID!;
if (process.env.ZHIYU_TEST_MODE !== "integration" || !workId) throw new Error("Isolated fixture required");
process.send?.({type: "ready", pid: process.pid});
process.once("message", async () => {
  const failures: string[] = [];
  let written = 0;
  try {
    for (let index = 0; index < 100; index++) {
      try {
        await appendWorkshopEvent({workshopId: workId, type: "observation", title: `并发回测 ${process.pid}-${index}`, metadata: {fixture: true, index}});
        written++;
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
  } finally { await closePostgresDb(); }
  process.send?.({type: "result", pid: process.pid, written, failures});
  process.disconnect();
});
