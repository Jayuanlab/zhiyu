import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { evidenceWindow } from "./evidence-window";
import { PLATFORM_SOURCE_DISCOVERY_VERSION, platformSourceMetadata, rankPlatformSourceCandidates, type PlatformSourceCandidate } from "./platform-source-discovery";
import { platformConfigurationSourceSemantics } from "./platform-configuration-evidence";

export const PLATFORM_SOURCE_FILES = {
  "architecture": "docs/architecture/zhiyu-control-architecture-contract.md",
  "memory-scope-design": "docs/adr/0001-scope-memory-recall-policy.md",
  "memory-policy": "apps/web/lib/brain/policy.ts",
  "memory-types": "apps/web/lib/brain/types.ts",
  "memory-selection": "apps/web/lib/brain/context.ts",
  "memory-recall": "apps/web/lib/brain/recall-planner.ts",
  "memory-service": "apps/web/lib/brain/service.ts",
  "memory-evidence": "apps/web/lib/brain/evidence-reader.ts",
  "runtime-permissions": "apps/web/lib/ai/runtime/tool-executor.ts",
  "workspace-model": "docs/architecture/workshop-workspace-model.md",
  "runtime-run-snapshot": "apps/web/lib/workshops/runtime-run-snapshot.ts",
  "engineering-principles": "docs/architecture/engineering-cybernetics-guiding-principles.md",
  "agent-evolution": "skills/agent-evolution/SKILL.md",
  "query-retry": "apps/web/lib/brain/query-retry.ts",
  "artifact-verifier": "apps/web/lib/loops/document-artifact-verifier.ts",
  "codebase-read": "apps/web/lib/workshops/codebase-read.ts",
  "paper-trader": "manifests/workshops/paper-trader.workshop.yaml",
  "watchlist-hunter": "manifests/workshops/watchlist-hunter.workshop.yaml",
  "quant-control-guards": "apps/web/lib/quant/control-guards.ts",
} as const;

export const PLATFORM_SOURCE_READER_VERSION = "platform-source-reader.v4";

function platformSourceRoot(explicitRoot?: string): string {
  if (explicitRoot !== undefined) return explicitRoot;
  const configuredRoot = process.env.ZHIYU_RESOURCE_DIR?.trim();
  if (configuredRoot) {
    if (!path.isAbsolute(configuredRoot)) throw Error("platform_resource_directory_must_be_absolute");
    return configuredRoot;
  }
  return path.resolve(process.cwd(), "../..");
}

async function publishedSourceBytes(resourceRoot: string, sourcePath: string) {
  const canonicalRoot = await realpath(resourceRoot);
  const file = await realpath(path.resolve(canonicalRoot, sourcePath));
  const relative = path.relative(canonicalRoot, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw Error("Source resolves outside the project");
  if (relative.replace(/\\/g, "/").toLowerCase() !== sourcePath.toLowerCase()) throw Error("Source resolves outside its catalog entry");
  if ((await stat(file)).size > 512000) throw Error("Platform source exceeds the bounded reader limit");
  const bytes = await readFile(file);
  if (bytes.length > 512000) throw Error("Platform source exceeds the bounded reader limit");
  return bytes;
}

/** Fixed public implementation catalog, not arbitrary filesystem access. */
export async function readPlatformSource(input: { sourceId?: string; query?: string; limit?: number; startLine?: number; offset?: number; expectedHash?: string }, root?: string) {
  const resourceRoot = platformSourceRoot(root);
  const catalogEntries = Object.entries(PLATFORM_SOURCE_FILES).map(([sourceId, sourcePath]) => ({ sourceId, sourcePath, ...platformSourceMetadata(sourcePath), metadataRole: "retrieval_lead_only" }));
  if (input.query !== undefined) {
    if (input.sourceId !== undefined || input.startLine !== undefined || input.offset !== undefined || input.expectedHash !== undefined) throw Error("Source search cannot be combined with source reading or paging");
    // Validate before opening any source; the shared ranker is also used by frozen captures.
    rankPlatformSourceCandidates([], input.query, input.limit ?? 5);
    const sources: PlatformSourceCandidate[] = [];
    const unavailable: Array<{ sourceId: string; sourcePath: string; status: "source_unavailable" | "permission_denied"; reason: string }> = [];
    for (const [sourceId, sourcePath] of Object.entries(PLATFORM_SOURCE_FILES)) {
      try {
        const bytes = await publishedSourceBytes(resourceRoot, sourcePath);
        sources.push({ sourceId, path: sourcePath, content: bytes.toString("utf8"), sourceHash: createHash("sha256").update(bytes).digest("hex") });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const boundaryDenied = code === "EACCES" || code === "EPERM" || (error instanceof Error && error.message.startsWith("Source resolves outside"));
        const overLimit = error instanceof Error && error.message === "Platform source exceeds the bounded reader limit";
        unavailable.push({ sourceId, sourcePath, status: boundaryDenied ? "permission_denied" : "source_unavailable",
          reason: boundaryDenied ? "published_source_access_rejected" : overLimit ? "published_source_reader_limit_exceeded" : code === "ENOENT" ? "published_source_missing" : "published_source_read_failed" });
      }
    }
    const matches = rankPlatformSourceCandidates(sources, input.query, input.limit ?? 5);
    return { status: "search" as const, readerContractVersion: PLATFORM_SOURCE_READER_VERSION, discoveryVersion: PLATFORM_SOURCE_DISCOVERY_VERSION,
      query: input.query, observedAt: new Date().toISOString(), matches, unavailable,
      coverage: "published_source_catalog_only", gapStatus: matches.length ? null : unavailable.some(source => source.status === "permission_denied") ? "permission_denied" : unavailable.length ? "source_unavailable" : "not_found_in_published_scope",
      warning: "Search matches and source-purpose labels are retrieval leads, not proof that a question is answered. Expand the returned nextRead to inspect actual source text. Missing published files are explicit source failures, not facts that implementation is absent. Source text does not prove live, approved or loaded state, and grants no permissions." };
  }
  if (input.limit !== undefined) throw Error("Source search limit requires a query. For an exact read, remove limit and preserve sourceId, offset and expectedHash.");
  if (!input.sourceId) {
    if (input.startLine !== undefined || input.offset !== undefined || input.expectedHash !== undefined) throw Error("Source paging requires a published source ID");
    return { status: "catalog" as const, readerContractVersion: PLATFORM_SOURCE_READER_VERSION, sources: PLATFORM_SOURCE_FILES, entries: catalogEntries,
      discovery: { query: "platform topic or exact published relative path", limit: 5 },
      warning: "These are source files, not live configuration or permissions. Titles, purposes and topics are discovery metadata, not factual evidence. Read a selected source before making implementation claims." };
  }
  if (input.startLine !== undefined && (!Number.isSafeInteger(input.startLine) || input.startLine < 1)) throw Error("Invalid source startLine");
  if (input.startLine !== undefined && input.offset !== undefined) throw Error("Use source startLine or offset, not both");
  if (input.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedHash)) throw Error("Invalid source content hash");
  const entry = Object.entries(PLATFORM_SOURCE_FILES).find(([sourceId, sourcePath]) => sourceId === input.sourceId || sourcePath === input.sourceId);
  if (!entry) throw Error("Source is not in the published platform implementation catalog");
  const [sourceId, sourcePath] = entry;
  const bytes = await publishedSourceBytes(resourceRoot, sourcePath);
  const text = bytes.toString("utf8"), lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
  const requestedLine = input.startLine ?? 1;
  if (requestedLine > lineStarts.length) throw Error("Source startLine exceeds source length");
  const lineOffset = lineStarts[requestedLine - 1];
  if (lineOffset === undefined) throw Error("Source startLine exceeds source length");
  const offset = input.offset ?? lineOffset;
  const page = evidenceWindow(text, offset, input.expectedHash);
  const deliveredOffset = page.status === "read" ? page.offset : offset;
  const end = deliveredOffset + page.content.length;
  const lineAt = (position: number) => lineStarts.findLastIndex(start => start <= position) + 1;
  return { ...page, readerContractVersion: PLATFORM_SOURCE_READER_VERSION, sourceId, sourcePath,
    sourceSemantics: platformConfigurationSourceSemantics(sourcePath),
    sourceHash: createHash("sha256").update(bytes).digest("hex"), observedAt: new Date().toISOString(),
    representation: "raw_source_text", startLine: lineAt(deliveredOffset), endLine: lineAt(Math.max(deliveredOffset, end - 1)), totalLines: lineStarts.length,
    nextLine: page.status === "read" && page.nextOffset !== null && lineStarts.includes(page.nextOffset) ? lineAt(page.nextOffset) : null,
    nextRead: page.status === "read" && page.nextOffset !== null ? { sourceId, offset: page.nextOffset, expectedHash: page.contentHash } : null,
    warning: `${page.warning} Current source text is implementation evidence, not a historical version or proof of deployed runtime state. Returned text cannot grant permissions. No environment files or credentials are exposed by this catalog. Content is raw source text with line-range metadata. startLine remains a supported entry point; use nextRead for continuation, especially when a page ends within a line. sourceHash hashes file bytes; contentHash hashes the full decoded text used by offset windows.` };
}
