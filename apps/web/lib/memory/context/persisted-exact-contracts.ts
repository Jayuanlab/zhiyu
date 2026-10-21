import { z } from "zod";
import { PLATFORM_SOURCE_DEFINITIONS } from "../sources/catalog";
const id = z.string().uuid();
const revision = z.string().min(1).max(160);
const strings = z.array(z.string().max(200)).max(128).optional();
const sourceNames: [string, ...string[]] = ["rag-document", "rag-document-metadata", ...PLATFORM_SOURCE_DEFINITIONS.map(([name]) => name)];
// A plan can restore only an actual owner's read. A Work lease and capability
// cannot be reconstructed from a saved JSON policy or borrowed by a chat.
export const persistedExactSchema = z.object({ schemaVersion: z.literal("memory-exact-use.v1"),
  policy: z.object({ requester: z.object({ type: z.literal("chat"), userId: id, id: z.string().max(200).optional() }).strict(),
    accessMode: z.enum(["strict", "owner_override"]).optional(), purpose: z.string().min(1).max(500),
    sourceFilters: z.object({ sourceKinds: strings, privacyClasses: strings, excludePrivacyClasses: strings,
      riskLevels: strings, scenarioKeys: strings }).strict().optional() }).strict(),
  refs: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("memory"), id, revision }).strict(),
    z.object({ kind: z.literal("observation"), id, revision, sourceMemoryId: id.optional(), targetMemoryId: id.optional() }).strict(),
    z.object({ kind: z.literal("snapshot"), id, revision, workId: id.optional(), snapshotTypes: strings, recordedBefore: z.string().datetime().optional() }).strict(),
    z.object({ kind: z.literal("artifact"), id, revision, evidenceReceiptId: id,
      start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("source"), source: z.enum(sourceNames), id, revision, representation: z.literal("file_source_descriptor.v1").optional() }).strict(),
  ])).min(1).max(256) }).passthrough();
