import { z } from "zod";
import { readBoundedJson } from "./_shared";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
const scope = z.discriminatedUnion("type", [z.object({ type: z.literal("global") }).strict(),
  z.object({ type: z.literal("work"), workId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("workshop"), workshopId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("workspace"), workspaceId: z.string().min(1).max(200) }).strict()]);
const memoryType = z.enum(["fact", "preference", "plan", "boundary", "relationship", "task", "insight", "system"]);
const metadata = z.record(z.string(), z.unknown());
const strings = z.array(z.string().max(4096)).max(256);
const schemas = {
  review: z.object({ decision: z.enum(["confirmed", "dismissed", "rejected", "active", "weakened"]),
    reason: z.string().max(8192).optional(), expectedVersion: z.string().max(256).optional(), evidenceConfirmed: z.boolean().optional() }).strict(),
  memory: z.object({ scope: scope.optional(), ownerType: z.enum(["chat", "work", "system"]).default("chat"), ownerId: z.string().min(1).max(200).optional(),
    memoryType: memoryType.default("fact"), subject: z.string().max(8192).optional(), content: z.string().max(262144).default(""),
    status: z.enum(["candidate", "active", "verified", "weakened", "superseded", "deleted"]).default("active"), confidence: z.coerce.number().min(0).max(100).default(50),
    evidenceRefs: strings.default([]), tags: strings.default([]), expiresAt: z.string().max(100).optional() }).strict(),
  observation: z.object({ sourceType: z.string().max(200).optional(), sourceId: z.string().max(2048).optional(), sourceEventId: z.string().max(200).optional(),
    observedAt: z.string().max(100).optional(), content: z.string().max(262144).default(""), trustLevel: z.string().max(100).optional(), metadata: metadata.optional() }).strict(),
  snapshot: z.object({ scope: scope.optional(), snapshotType: z.string().max(200).optional(), content: metadata.default({}), sourceMemoryIds: strings.default([]), metadata: metadata.default({}) }).strict(),
  grant: z.object({ subjectType: z.enum(["chat", "work", "loop", "tool", "system"]).default("work"), subjectId: z.string().min(1).max(200).optional(), scope: scope.optional(),
    permissions: z.array(z.enum(["read", "reference", "write", "review"])).max(4).default(["reference"]), memoryTypes: z.array(memoryType).max(8).optional(),
    reason: z.string().max(8192).optional(), expiresAt: z.string().max(100).optional() }).strict(),
};
export async function readOwnerMutation<K extends keyof typeof schemas>(request: Request, kind: K): Promise<z.infer<(typeof schemas)[K]>> {
  const parsed = schemas[kind].safeParse(await readBoundedJson(request));
  if (!parsed.success) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid memory command fields");
  return parsed.data as z.infer<(typeof schemas)[K]>;
}
