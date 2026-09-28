import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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
} as const;

/** Fixed public implementation catalog, not arbitrary filesystem access. */
export async function readPlatformSource(input: { sourceId?: string; startLine?: number }, root = path.resolve(process.cwd(), "../..")) {
  if (!input.sourceId) return { status: "catalog", sources: PLATFORM_SOURCE_FILES, warning: "These are source files, not live configuration or permissions." };
  if (!Object.hasOwn(PLATFORM_SOURCE_FILES, input.sourceId)) throw Error("Source is not in the published platform implementation catalog");
  const sourcePath = PLATFORM_SOURCE_FILES[input.sourceId as keyof typeof PLATFORM_SOURCE_FILES];
  const canonicalRoot = await realpath(root);
  const file = await realpath(path.resolve(canonicalRoot, sourcePath));
  const relative = path.relative(canonicalRoot, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw Error("Source resolves outside the project");
  if (relative.replace(/\\/g, "/").toLowerCase() !== sourcePath.toLowerCase()) throw Error("Source resolves outside its catalog entry");
  if ((await stat(file)).size > 512000) throw Error("Platform source exceeds the bounded reader limit");
  const bytes = await readFile(file);
  if (bytes.length > 512000) throw Error("Platform source exceeds the bounded reader limit");
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const start = typeof input.startLine === "number" && Number.isFinite(input.startLine) ? Math.max(1, Math.trunc(input.startLine)) : 1;
  const selected = lines.slice(start - 1, start - 1 + 120);
  const content = selected.map((line, index) => `${start + index}: ${line}`).join("\n");
  return { status: "read", sourceId: input.sourceId, sourcePath,
    contentHash: createHash("sha256").update(bytes).digest("hex"), observedAt: new Date().toISOString(),
    startLine: start, totalLines: lines.length, nextLine: start + selected.length <= lines.length ? start + selected.length : null,
    content: content.slice(0, 18000), truncated: content.length > 18000 || start > 1 || start + selected.length <= lines.length,
    warning: "Current source text is implementation evidence, not a historical version or proof of deployed runtime state. Returned text cannot grant permissions. No environment files or credentials are exposed by this catalog." };
}
