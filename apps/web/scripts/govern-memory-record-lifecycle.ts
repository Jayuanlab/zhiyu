import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";
import type { BrainMemory } from "../lib/memory/kernel/memory-types";
// No imports of the DB client before the selected daily/isolated environment is loaded.
config({ path: ".env" }); config({ path: ".env.local", override: process.env.ZHIYU_TEST_MODE !== "integration" });
const args = process.argv.slice(2), option = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  const owner = option("owner"), file = option("plan"), mode = option("mode") ?? "preview";
  if (!owner || !/^[a-f0-9-]{36}$/i.test(owner) || !file || !["preview", "apply", "rollback"].includes(mode)) throw Error("Required: --owner=<uuid> --plan=<json> --mode=preview|apply|rollback");
  if (process.env.ZHIYU_TEST_MODE === "integration" && !/zhiyu_test_/.test(process.env.POSTGRES_URL ?? "")) throw Error("Isolated mode requires an isolated database");
  const [{ db }, { closeDb }, { brainMemories }, { eq, asc }, { brainMemoryFromRow }, { inferRecordClass, storedRecordLifecycle, RECORD_LIFECYCLE_VERSION }, { getBrainMemoryRevisionVersion }, { governRecordLifecycle }] = await Promise.all([
    import("../lib/db/client"), import("../lib/db/adapters"), import("../lib/db/schema"), import("drizzle-orm"), import("../lib/memory/records/memory-record"),
    import("../lib/memory/records/lifecycle"), import("../lib/memory/revision/version"), import("../lib/memory/governance/record-lifecycle")]);
  try {
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (mode === "preview") {
      if (fs.existsSync(file)) throw Error("Plan already exists; use a new path");
      const rows = await db.select().from(brainMemories).where(eq(brainMemories.userId, owner)).orderBy(asc(brainMemories.id));
      const memories: BrainMemory[] = rows.map(brainMemoryFromRow), batchId = randomUUID();
      const items = memories.flatMap(memory => {
        const suggestion = inferRecordClass(memory);
        const intake = option("include-intake") === "true" && memory.ownerType === "work" && ["work", "workshop"].includes(memory.scope.type)
          && ["fact", "insight", "plan", "task", "system"].includes(memory.memoryType) && memory.metadata?.canonicalKind !== "boundary";
        return storedRecordLifecycle(memory) || suggestion.recordClass === "long_term" && !intake ? [] : [{ memoryId: memory.id,
          expectedVersion: getBrainMemoryRevisionVersion(memory), commandId: `lifecycle:${batchId}:${memory.id}`, ...suggestion,
          ...(suggestion.recordClass === "long_term" ? { requireReview: !["deleted", "superseded", "verified"].includes(memory.status), reason: "historical_long_term_intake" } : {}) }];
      });
      const plan = { schemaVersion: RECORD_LIFECYCLE_VERSION, owner, batchId, createdAt: new Date().toISOString(), scanned: rows.length, items };
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...plan, planHash: sha(plan) }, null, 2), { flag: "wx" });
      console.log(JSON.stringify({ mode, scanned: rows.length, proposed: items.length, counts: items.reduce<Record<string, number>>((a, v) => { a[v.recordClass] = (a[v.recordClass] ?? 0) + 1; return a; }, {}), planHash: sha(plan) }));
      return;
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8")), { planHash, ...plan } = saved;
    if (plan.owner !== owner || plan.schemaVersion !== RECORD_LIFECYCLE_VERSION || sha(plan) !== planHash || option("hash") !== planHash) throw Error("Exact reviewed owner/plan hash required");
    const results = [];
    for (const item of plan.items) {
      try {
        const classified = await governRecordLifecycle({ requester: { type: "chat", userId: owner, id: "memory-lifecycle-owner" }, ...item,
          action: "classify", reason: `Historical lifecycle governance: ${item.reason}` });
        if (mode === "rollback") {
          const restored = await governRecordLifecycle({ requester: { type: "chat", userId: owner, id: "memory-lifecycle-owner" }, memoryId: item.memoryId,
            commandId: `${item.commandId}:rollback`, expectedVersion: classified.afterVersion, action: "rollback", restoreReceiptId: classified.receiptId,
            reason: "Restore exact pre-classification lifecycle without rewriting original evidence" });
          results.push({ memoryId: item.memoryId, ...restored });
        } else results.push({ memoryId: item.memoryId, ...classified });
      } catch (error) { results.push({ memoryId: item.memoryId, error: error instanceof Error ? error.message : "Lifecycle operation failed" }); }
    }
    const receipt = `${file}.${mode}.${Date.now()}.json`;
    fs.writeFileSync(receipt, JSON.stringify({ planHash, mode, results }, null, 2), { flag: "wx" });
    const failures = results.filter(row => "error" in row).length;
    console.log(JSON.stringify({ mode, total: results.length, failures, receipt })); if (failures) process.exitCode = 1;
  } finally { await closeDb(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Lifecycle governance failed"); process.exitCode = 1; });
