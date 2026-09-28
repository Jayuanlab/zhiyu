import Module from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const MANIFEST_NAME = "document-markdown-cleaner";
const PREVIOUS_FORMATS = "MD、TXT、HTML、HTM、PDF、DOCX、PPTX、XLSX、CSV、TSV、JSON";
const CURRENT_FORMATS = "MD、TXT、HTML、HTM、XHTML、PDF、DOCX、ODT、PPTX、ODP、XLSX、XLS、ODS、CSV、TSV、JSON、YAML、YML、XML、EPUB";
const manifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../manifests/workshops/document-markdown-cleaner.workshop.yaml",
);

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const [{ db }, schema, manifestService, workshopService, loopService, adapters] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/db/schema"),
    import("@/lib/workshops/manifest"),
    import("@/lib/workshops/service"),
    import("@/lib/loops/service"),
    import("@/lib/db/adapters"),
  ]);
  try {
    const manifestYaml = await readFile(manifestPath, "utf8");
    const requestedUserId = option("user") ?? process.env.WORKSHOP_OWNER_USER_ID;
    const ownerRows = await db
      .select({ userId: schema.workshops.userId })
      .from(schema.workshops);
    const existingOwnerIds = [...new Set(ownerRows.map((row: any) => String(row.userId)))];
    const candidateUserIds = requestedUserId
      ? [requestedUserId]
      : existingOwnerIds.length > 0
        ? existingOwnerIds
        : (await db.select({ id: schema.user.id }).from(schema.user).limit(2))
          .map((row: any) => String(row.id));
    if (candidateUserIds.length !== 1) {
      throw new Error("Specify --user=<uuid> or WORKSHOP_OWNER_USER_ID when the owner is ambiguous.");
    }
    const userId = candidateUserIds[0];
    const ownerWorks = await manifestService.reviewWorkshopManifest({
      userId,
      manifestYaml,
      existingWorkshops: [],
    });
    if (!ownerWorks.review.ok) {
      console.error(JSON.stringify({ ok: false, review: ownerWorks.review }));
      throw new Error("Document Markdown cleaner manifest review failed.");
    }
    if (process.argv.includes("--review-only")) {
      console.log(JSON.stringify({ ok: true, reviewOnly: true, review: ownerWorks.review }));
      return;
    }
    const verifyStored = async (workshopId: string) => {
      const stored = await workshopService.getWorkshop(userId, workshopId);
      const config = asRecord(stored?.modelConfig);
      const boundary = asRecord(stored?.boundaryPolicy);
      const loops = await loopService.listLoopsForWorkshop({ userId, workshopId, limit: 10 });
      const cleanerLoop = loops.find((loop) => loop.name === "文档清洗与 Markdown 分片");
      if (!stored || stored.name !== "文档清洗专员" ||
          !stored.mission.includes("主人明确添加") || !stored.mission.includes("Markdown") ||
          stored.mission.includes("�") || stored.mission.includes("???") ||
          !cleanerLoop || !cleanerLoop.goal.includes("暂存源文件") ||
          asRecord(cleanerLoop.triggerConfig).type !== "manual" ||
          config.role !== "document_markdown_cleaner" ||
          config.agentRuntimeEngine !== "pi" || boundary.externalMessages !== "blocked" ||
          !String(boundary.customInstructions ?? "").includes(CURRENT_FORMATS) ||
          !JSON.stringify(asRecord(config.manifestSpec).control ?? {}).includes(CURRENT_FORMATS) ||
          !Array.isArray(config.allowedTools) || !config.allowedTools.includes("workshopConvertDocument")) {
        throw new Error("Stored document Markdown cleaner fields did not match the manifest.");
      }
      return { name: stored.name, chineseTextVerified: true, loopTrigger: "manual", role: config.role, runtime: config.agentRuntimeEngine };
    };
    const existing = await workshopService.listWorkshops(userId, 100, { manifestName: MANIFEST_NAME });
    if (existing.length > 0) {
      const workshopId = existing[0].id;
      const baseline = await workshopService.getWorkshopConfigurationBaseline(userId, workshopId);
      if (!baseline) throw new Error("Existing document Markdown cleaner Work disappeared.");
      const config = asRecord(baseline.workshop.modelConfig);
      const boundary = asRecord(baseline.workshop.boundaryPolicy);
      const instructions = String(boundary.customInstructions ?? "");
      const control = JSON.stringify(asRecord(config.manifestSpec).control ?? {});
      const alreadyCurrent = instructions.includes(CURRENT_FORMATS) && control.includes(CURRENT_FORMATS);
      if (!alreadyCurrent) {
        if (baseline.commandVersion !== 1) {
          throw new Error("Existing Work has owner commands since the initial seed; review those changes before applying a new manifest.");
        }
        if (baseline.workshop.name !== "文档清洗专员" ||
            config.role !== "document_markdown_cleaner" ||
            !instructions.includes(PREVIOUS_FORMATS) || !control.includes(PREVIOUS_FORMATS)) {
          throw new Error("Existing Work differs from the previously seeded manifest; review owner edits before updating it.");
        }
        await manifestService.applyWorkshopManifestToExisting({
          userId,
          workshopId,
          manifestYaml,
          commandId: randomUUID(),
          expectedVersion: baseline.commandVersion,
          source: "system",
          reason: "Expand document Markdown cleaner support to the verified 20 formats.",
        });
      }
      const stored = await verifyStored(workshopId);
      console.log(JSON.stringify({ ok: true, created: false, updated: !alreadyCurrent, workshopId, stored }));
      return;
    }
    try {
      const applied = await manifestService.applyWorkshopManifest({
        userId,
        manifestYaml,
        source: "system",
        reason: "Seed the owner document Markdown cleaner Work.",
      });
      const stored = await verifyStored(applied.workshop.id);
      console.log(JSON.stringify({
        ok: true,
        created: true,
        workshopId: applied.workshop.id,
        loopCount: applied.created.loops,
        sourceCount: applied.created.sources,
        stored,
      }));
    } catch (error) {
      const concurrent = await workshopService.listWorkshops(userId, 100, { manifestName: MANIFEST_NAME });
      if (concurrent.length === 0 || !(error instanceof Error) || error.message !== "manifest_conflict") throw error;
      const stored = await verifyStored(concurrent[0].id);
      console.log(JSON.stringify({ ok: true, created: false, workshopId: concurrent[0].id, reason: "already_exists", stored }));
    }
  } finally {
    await adapters.closeDb();
  }
}

main().catch((error) => {
  console.error("[DocumentMarkdownCleanerSeed] failed", error);
  process.exitCode = 1;
});
