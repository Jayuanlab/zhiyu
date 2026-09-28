import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { Loop, Workshop } from "@/lib/db/schema";
import type { WorkshopRunSkill } from "@/lib/workshops/run-prompt";

// Read-only configuration probe: no run admission, Brain recall, model or tool execution.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const saved = process.argv.includes("--saved");
const draft = JSON.parse(readFileSync(fileURLToPath(
  new URL("./data/workshop-role-prompts-2026-09-15.json", import.meta.url),
), "utf8")) as { version: string; workshops: Array<{ id: string; name: string; mission: string }> };
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

async function main() {
  assert.equal(draft.workshops.length, 7, "expected_seven_workshops");
  assert.equal(new Set(draft.workshops.map(item => item.id)).size, 7, "duplicate_workshop_target");
  // Suppress internal setup/loader diagnostics so stdout contains no raw config or prompts.
  const output = console.log;
  const diagnostics = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = () => undefined;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const [client, adapters, drizzle, service, loopService, composition, skillsModule,
      snapshots, context, profiles, boundary, native, workshopContext, toolProfile,
      toolAccess, executorTools, piTools, specModule] = await Promise.all([
      import("@/lib/db/client"), import("@/lib/db/adapters"), import("drizzle-orm"),
      import("@/lib/workshops/service"), import("@/lib/loops/service"),
      import("@/lib/workshops/run-prompt"), import("@/lib/workshops/run-prompt-skills"),
      import("@/lib/ai/runtime/run-snapshot"), import("@/lib/loops/context-window"),
      import("@/lib/ai/context-profile"), import("@/lib/workshops/boundary-policy"),
      import("@/lib/loops/native-executor"), import("@/lib/workshops/context-window"),
      import("@/lib/workshops/tool-profile"), import("@/lib/workshops/tool-access"),
      import("@/lib/workshops/executor-tools"), import("@/lib/workshops/pi-domain-tools"),
      import("@/lib/loops/spec"),
    ]);
    closeDb = adapters.closeDb;
    const owners = await client.db.execute(drizzle.sql`SELECT user_id FROM workshops WHERE id=${draft.workshops[0].id}::uuid`);
    const userId = owners[0]?.user_id as string | undefined;
    assert.ok(userId, "owner_not_found");
    const loopInventory = await client.db.execute(drizzle.sql`
      SELECT COUNT(*)::int AS count FROM loops
      WHERE user_id=${userId}::uuid AND status <> 'archived'
        AND workshop_id IN (${drizzle.sql.join(draft.workshops.map(item => drizzle.sql`${item.id}::uuid`), drizzle.sql`, `)})
    `);
    const expectedLoopCount = Number(loopInventory[0]?.count);
    assert.ok(Number.isInteger(expectedLoopCount), "loop_inventory_count_unavailable");
    const results: Array<Record<string, unknown>> = [];
    let loopCount = 0;
    let requiredSkillLoads = 0;
    let optionalSkillIndexes = 0;

    function verify(workshop: Workshop, taskPrompt: string, allowedTools: string[], skills: WorkshopRunSkill[], loop?: Loop, policies?: { actionPolicy: unknown; approvalPolicy: unknown }) {
      const assembly = composition.composeWorkshopRunPrompt({
        workshop, prompt: taskPrompt, allowedTools, skills,
        ...(loop ? { loop: { id: loop.id, name: loop.name } } : {}), ...policies,
      });
      assert.ok(workshop.mission.trim(), "mission_empty");
      assert.equal(assembly.systemPrompt.split(workshop.mission).length - 1, 1, "mission_system_occurrence");
      assert.ok(!assembly.prompt.includes(workshop.mission), "mission_leaked_into_task");
      assert.ok(!assembly.prompt.includes(JSON.stringify(workshop.mission).slice(1, -1)), "encoded_mission_leaked_into_task");
      assert.equal(assembly.manifest.systemPromptHash, snapshots.sha256Hex(assembly.systemPrompt), "system_hash_mismatch");
      assert.equal(assembly.manifest.taskPromptHash, snapshots.sha256Hex(taskPrompt), "task_hash_mismatch");
      for (const skill of skills) {
        const entry = assembly.manifest.selectedSkills.find(item => item.name === skill.name);
        assert.ok(entry, "selected_skill_missing_from_manifest");
        const full = skill.source ? readFileSync(skill.source, "utf8") : null;
        if (skill.required) {
          requiredSkillLoads += 1;
          assert.ok(full, "mapped_skill_missing");
          assert.ok(full.trim(), "mapped_skill_empty");
          assert.equal(skill.content, full, "mapped_skill_not_loaded_in_full");
          assert.equal(assembly.systemPrompt.split(full).length - 1, 1, "mapped_skill_missing_or_duplicated");
          assert.equal(entry.contentHash, snapshots.sha256Hex(full), "mapped_skill_hash_mismatch");
          assert.ok(!assembly.prompt.includes(full), "mapped_skill_body_leaked_into_task");
        } else {
          optionalSkillIndexes += 1;
          assert.equal(skill.content, null, "optional_skill_body_preloaded");
          assert.equal(entry.contentHash, null, "optional_skill_claims_loaded_hash");
          if (full?.trim()) assert.ok(!assembly.systemPrompt.includes(full), "optional_skill_body_in_system");
        }
      }
      const snapshotInput = {
        runtime: { engine: "pi" as const, adapter: "pi-agent-harness", version: "0.85.1" },
        runtimeSelection: { engine: "pi" as const, source: "config" as const },
        model: { model: "read-only-prompt-probe", source: "user" as const, tier: "probe" },
        prompt: assembly.prompt, systemPrompt: assembly.systemPrompt, allowedTools,
      };
      const snapshot = snapshots.buildAgentRuntimeRunSnapshot(snapshotInput);
      assert.equal(snapshot.systemPromptHash, assembly.manifest.systemPromptHash, "snapshot_system_hash_mismatch");
      assert.equal(snapshot.promptHash, assembly.manifest.taskPromptHash, "snapshot_task_hash_mismatch");
      assert.notEqual(snapshot.runtimeHash, snapshots.buildAgentRuntimeRunSnapshot({
        ...snapshotInput, systemPrompt: `${assembly.systemPrompt}\nProbe-only instruction change.`,
      }).runtimeHash, "runtime_hash_ignores_system");
      return {
        status: "passed", systemChars: assembly.systemPrompt.length, taskChars: assembly.prompt.length,
        systemHash: assembly.manifest.systemPromptHash, taskHash: assembly.manifest.taskPromptHash,
        selectedSkills: assembly.manifest.selectedSkills,
      };
    }

    function toolNames(workshop: Workshop, profile: Parameters<typeof toolProfile.buildWorkshopToolProfile>[0]["contextProfile"], loop?: Loop, spec?: ReturnType<typeof specModule.parseLoopSpec>) {
      const requestedTools = spec ? [...spec.actions.allowed, ...spec.actions.requiresApproval, ...spec.verification.requiredSources] : [];
      const selected = toolProfile.buildWorkshopToolProfile({
        workshop, contextProfile: profile,
        baseTools: loop ? executorTools.LOOP_WORKSHOP_ALLOWED_TOOLS : executorTools.WORKSHOP_ALLOWED_TOOLS,
        requestedTools,
      });
      // Register schemas only; no tool execute/handler is invoked by this probe.
      return piTools.createWorkshopPiTools({
        workshop, workshopId: workshop.id,
        allowedTools: toolAccess.resolveWorkshopSdkAllowedTools(workshop, selected.tools),
      }).map(tool => tool.name);
    }

    for (const item of draft.workshops) {
      const stored = await service.getWorkshop(userId, item.id);
      assert.ok(stored && stored.name === item.name, "same_owner_target_mismatch");
      if (saved) assert.equal(stored.mission, item.mission, "saved_mission_does_not_match_reviewed_draft");
      const workshop = saved ? stored : { ...stored, mission: item.mission };
      const workshopPrompt = workshopContext.buildWorkshopPrompt({
        workshop, sources: [], memories: [], directives: [], events: [], outbox: [],
        maxToolCalls: 40, separateSystemPrompt: true,
      });
      const workResult = verify(workshop, workshopPrompt,
        toolNames(workshop, profiles.resolveWorkshopContextProfile(workshop)), skillsModule.loadWorkshopRunSkills(workshop));
      const loops = (await loopService.listLoopsForWorkshop({ userId, workshopId: workshop.id, limit: 1000 }))
        .filter(loop => loop.status !== "archived");
      const loopResults = [];
      for (const loop of loops) {
        const state = await loopService.getLoopState(loop.id);
        const fromState = specModule.safeParseLoopSpec(record(state?.stateJson).loopSpec);
        const contextMetadata = record(record(loop.contextConfig).metadata);
        const baseSpec = fromState.success ? fromState.data : specModule.parseLoopSpec({
          version: 1, goal: loop.goal, trigger: loop.triggerConfig, context: loop.contextConfig,
          actions: loop.actionPolicy, verification: loop.verificationConfig,
          retry: loop.retryPolicy, approval: loop.approvalPolicy, escalation: loop.escalationPolicy,
          metadata: contextMetadata,
        });
        const policies = boundary.workshopBoundaryToLoopPolicies({ workshop, actionPolicy: loop.actionPolicy, approvalPolicy: loop.approvalPolicy });
        const effectiveSpec = specModule.parseLoopSpec({
          ...baseSpec, actions: policies.actionPolicy, approval: policies.approvalPolicy,
          metadata: { ...contextMetadata, ...baseSpec.metadata,
            delivery: record(baseSpec.metadata.delivery).platform ? baseSpec.metadata.delivery : contextMetadata.delivery,
            createOutboxDraftsFromSuggestedActions: baseSpec.metadata.createOutboxDraftsFromSuggestedActions ?? contextMetadata.createOutboxDraftsFromSuggestedActions,
            workshopBoundary: policies.metadata,
          },
        });
        const profile = profiles.resolveLoopContextProfile(loop, workshop);
        const taskPrompt = native.buildNativeLoopPrompt({
          loop, loopSpec: effectiveSpec,
          contextWindow: context.prepareLoopContextWindow({ state: null, loopSpec: effectiveSpec, contextProfile: profile }),
          workshopContext: context.prepareLoopWorkshopContext({
            workshop, sources: [], memories: [], directives: [], events: [],
            taskIntent: [loop.name, loop.goal].join("\n"), contextProfile: profile,
          }),
          sessionDir: "read-only-prompt-probe/no-session-created", language: "zh-CN", maxToolCalls: 40,
          workshopRole: composition.resolveWorkshopRunRole(workshop), separateSystemPrompt: true,
        });
        loopResults.push({
          id: loop.id, name: loop.name, savedStatus: loop.status, specSource: fromState.success ? "loop_state_spec" : "loop_config",
          ...verify(workshop, taskPrompt, toolNames(workshop, profile, loop, effectiveSpec),
            skillsModule.loadWorkshopRunSkills(workshop, loop.name), loop,
            { actionPolicy: effectiveSpec.actions, approvalPolicy: effectiveSpec.approval }),
        });
        loopCount += 1;
      }
      results.push({ id: workshop.id, name: workshop.name, savedStatus: workshop.status, ...workResult, loops: loopResults });
    }
    const report = JSON.stringify({
      mode: saved ? "saved_read_only" : "draft_overlay_read_only", draftVersion: draft.version,
      scope: "Real saved Work/Loop configs and prompt builders; empty observations/state; no model, tool execution, or production run.",
      counts: { workshops: results.length, loops: loopCount, expectedLoopsFromDatabase: expectedLoopCount, assembliesPassed: results.length + loopCount, requiredSkillLoads, optionalSkillIndexes },
      results,
    }, null, 2);
    const outputArgument = process.argv.find(value => value.startsWith("--output="));
    if (outputArgument) {
      const outputPath = resolve(outputArgument.slice("--output=".length));
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${report}\n`, "utf8");
    }
    output(report);
    assert.equal(loopCount, expectedLoopCount, "not_all_nonarchived_loops_verified");
  } finally {
    try { await closeDb?.(); } finally { Object.assign(console, diagnostics); }
  }
}

main().catch((error: unknown) => {
  // Assertion codes are controlled strings; omit arbitrary errors/configuration values.
  console.error(JSON.stringify({ status: "failed", code: error instanceof assert.AssertionError ? error.message.split("\n")[0] : "prompt_probe_failed", errorType: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
});
