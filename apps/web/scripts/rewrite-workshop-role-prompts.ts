import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// No model calls or business tools. Writes use the same versioned command as Web.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const apply = process.argv.includes("--apply");
const anchorId = "3153b95e-df02-4d31-9949-04f19e4eb8d4";
const sourcePath = fileURLToPath(
  new URL("./data/workshop-role-prompts-2026-09-15.json", import.meta.url),
);
const draft = JSON.parse(readFileSync(sourcePath, "utf8")) as {
  version: string;
  workshops: Array<{ id: string; name: string; mission: string }>;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const clean = (text: string) => !text.includes("???") && !text.includes("\uFFFD");

async function main() {
  if (
    !draft.version || draft.workshops.length !== 7 ||
    new Set(draft.workshops.map((item) => item.id)).size !== 7 ||
    draft.workshops.some((item) => !item.name || !item.mission.trim() || !clean(item.mission))
  ) throw new Error("Invalid or corrupted role prompt draft");

  const [{ db }, { sql }, { closeDb }] = await Promise.all([
    import("@/lib/db/client"),
    import("drizzle-orm"),
    import("@/lib/db/adapters"),
  ]);
  try {
    const owners = await db.execute(sql`SELECT user_id FROM workshops WHERE id=${anchorId}::uuid`);
    const userId = owners[0]?.user_id as string | undefined;
    if (!userId) throw new Error("Workshop owner not found");
    const { getWorkshop, getWorkshopConfigurationBaseline, createWorkshopWorkVersionSnapshot } = await import("@/lib/workshops/service");

    // Validate every target before any writes, and capture optimistic baselines.
    const targets = [];
    for (const item of draft.workshops) {
      const captured = await getWorkshopConfigurationBaseline(userId, item.id);
      if (!captured || captured.workshop.name !== item.name) throw new Error(`Target mismatch: ${item.id}`);
      const { workshop: baseline, commandVersion } = captured;
      targets.push({ item, baseline, commandVersion });
    }

    const results = [];
    for (const { item, baseline, commandVersion } of targets) {
      const unchanged = baseline.mission === item.mission;
      const commandId = `role-prompts:${draft.version}:${item.id}:${commandVersion}:${hash(item.mission).slice(0, 12)}`;
      if (apply && !unchanged) {
        await createWorkshopWorkVersionSnapshot({
          workshop: baseline,
          source: "owner_requested_role_prompt_baseline",
          createdBy: "owner",
        });
        const { updateWork } = await import("@/lib/work-runtime/commands");
        await updateWork({
          userId,
          workId: item.id,
          expectedVersion: commandVersion,
          commandId,
          source: "owner",
          reason: "按用户要求重写车间角色提示词，供项目、车间、Loop 三层装载使用；保留现有任务与权限。",
          patch: { mission: item.mission },
        });
        const saved = await getWorkshop(userId, item.id);
        if (!saved || saved.mission !== item.mission || !clean(saved.mission)) {
          throw new Error(`Prompt readback mismatch: ${item.id}`);
        }
        if (saved.status !== baseline.status || saved.autonomyLevel !== baseline.autonomyLevel ||
            JSON.stringify(saved.boundaryPolicy) !== JSON.stringify(baseline.boundaryPolicy)) {
          throw new Error(`Unexpected boundary/status change: ${item.id}`);
        }
      }
      results.push({
        id: item.id, name: item.name,
        status: unchanged ? "already_applied" : apply ? "applied" : "preview",
        previousChars: baseline.mission.length, chars: item.mission.length,
        previousHash: hash(baseline.mission), hash: hash(item.mission),
        ...(apply && !unchanged ? { commandId } : {}),
      });
    }
    console.log(JSON.stringify({ version: draft.version, mode: apply ? "apply" : "read_only", results }, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
