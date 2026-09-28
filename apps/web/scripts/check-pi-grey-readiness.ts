import Module from "node:module";
import type { Workshop } from "@/lib/db/schema.pg";

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only" || request.includes("server-only")) return {};
  return originalLoad.call(this, request, parent, isMain);
};

const argv = process.argv.slice(2);

function option(name: string) {
  const prefix = `--${name}=`;
  return argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function compactTools(values: readonly string[], limit = 12) {
  return {
    count: values.length,
    items: values.slice(0, limit),
    omitted: Math.max(0, values.length - limit),
  };
}

async function main() {
  const userId = option("user") ?? process.env.USER_ID;
  const workId = option("work");
  const limit = Number(option("limit") ?? "100");

  if (!userId) {
    throw new Error(
      "Usage: pnpm --filter web exec tsx scripts/check-pi-grey-readiness.ts --user=<userId> [--work=<workshopId>] [--limit=100]",
    );
  }

  const [{ closeDb }] = await Promise.all([import("@/lib/db/adapters")]);

  try {
    const [
      { resolveWorkshopContextProfile },
      { resolveWorkshopAgentRuntime },
      { WORKSHOP_ALLOWED_TOOLS },
      { buildWorkshopToolProfile },
      { resolveWorkshopSdkAllowedTools },
      { evaluateWorkshopPiRuntimeGreyReadiness },
      { getWorkshop, listWorkshops },
    ] = await Promise.all([
      import("@/lib/ai/context-profile"),
      import("@/lib/ai/model-policy"),
      import("@/lib/workshops/executor-tools"),
      import("@/lib/workshops/tool-profile"),
      import("@/lib/workshops/tool-access"),
      import("@/lib/workshops/pi-runtime-readiness"),
      import("@/lib/workshops/service"),
    ]);

    const workshops: Array<Workshop | null> = workId
      ? [await getWorkshop(userId, workId)]
      : await listWorkshops(userId, Number.isFinite(limit) ? limit : 100);
    const rows = workshops.filter(
      (workshop): workshop is Workshop => Boolean(workshop),
    );

    const results = rows.map((workshop: Workshop) => {
      const runtime = resolveWorkshopAgentRuntime({ workshop });
      const contextProfile = resolveWorkshopContextProfile(workshop);
      const toolProfile = buildWorkshopToolProfile({
        workshop,
        contextProfile,
        baseTools: WORKSHOP_ALLOWED_TOOLS,
      });
      const allowedTools = resolveWorkshopSdkAllowedTools(
        workshop,
        toolProfile.tools,
      );
      const readiness = evaluateWorkshopPiRuntimeGreyReadiness({
        requested: runtime.engine === "pi",
        tools: allowedTools,
      });
      return {
        id: workshop.id,
        name: workshop.name,
        status: workshop.status,
        autonomyLevel: workshop.autonomyLevel,
        runtime,
        contextProfile,
        toolProfile: {
          name: toolProfile.name,
          removedToolCount: toolProfile.removedToolCount,
        },
        readiness: {
          status: readiness.status,
          eligible: readiness.eligible,
          reasons: readiness.reasons,
          allowedReadTools: compactTools(readiness.allowedTools),
          migratedWriteTools: compactTools(readiness.migratedWriteTools),
          policyScopedMigratedWriteTools: compactTools(
            readiness.policyScopedMigratedWriteTools,
          ),
          needsMigrationTools: readiness.needsMigrationTools.map((tool) => ({
            toolName: tool.toolName,
            risk: tool.risk,
          })),
          blockedTools: readiness.blockedTools.map((tool) => ({
            toolName: tool.toolName,
            risk: tool.risk,
          })),
          nextSteps: readiness.nextSteps,
        },
      };
    });

    type ReadinessResult = (typeof results)[number];
    const totals = {
      works: results.length,
      eligible: results.filter(
        (item: ReadinessResult) => item.readiness.status === "eligible",
      ).length,
      notRequested: results.filter(
        (item: ReadinessResult) => item.readiness.status === "not_requested",
      ).length,
      needsToolMigration: results.filter(
        (item: ReadinessResult) =>
          item.readiness.status === "needs_tool_migration",
      ).length,
      blocked: results.filter(
        (item: ReadinessResult) => item.readiness.status === "blocked",
      ).length,
    };

    console.log(
      JSON.stringify(
        {
          schemaVersion: "pi-grey-readiness-check.v1",
          generatedAt: new Date().toISOString(),
          userId,
          workId: workId ?? null,
          mode: "read_only",
          totals,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
