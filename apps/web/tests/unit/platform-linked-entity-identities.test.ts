import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { platformLinkedEntityIdentities } from "@/lib/ai/platform-linked-entity-identities";

const subject = "bdde680e-6dc0-4902-822c-7f4c6d00ca87";
const object = "ffe86e53-66e4-4988-98b7-6c5850e9cdd6";
const scope = "authenticated_owner_exact_source" as const;
const fields = (id: string) => ({ id, name: id === subject ? "Subject" : "Object", entityType: "person",
  description: "Never publish this description", createdAt: "2026-10-02T06:01:46.768Z" });

describe("declared bounded entity identity projection", () => {
  it("accepts exact relation source aliases only and does not follow nested or inherited references", async () => {
    const read = vi.fn(async (id: string) => ({ fields: fields(id) }));
    for (const source of ["memoryGraphEvidence", "memoryGraphRelations.status", "MEMORYGRAPHRELATIONS", "arbitrary"])
      expect(await platformLinkedEntityIdentities(source, { subjectEntityId: subject }, read, scope)).toBeUndefined();
    const inherited = await platformLinkedEntityIdentities("memoryGraphRelations", Object.create({ subjectEntityId: subject }), read, scope);
    expect(inherited?.entities).toEqual([]);
    expect(inherited?.gaps).toContainEqual({ via: "subjectEntityId", status: "missing_link" });
    expect(read).not.toHaveBeenCalled();
  });

  it("matches camel and snake role IDs, agrees aliases and deduplicates shared IDs without recursion", async () => {
    const read = vi.fn(async (id: string) => ({ fields: { ...fields(id), sourceEventId: object, secret: "Hidden arbitrary metadata" } }));
    const result = await platformLinkedEntityIdentities("memory_graph_relations", {
      subject_entity_id: subject.toUpperCase(), subjectEntityId: subject, object_entity_id: subject,
    }, read, "frozen_owner_linked_capture");
    expect(read.mock.calls).toEqual([[subject]]);
    expect(result?.status).toBe("read");
    expect(result?.entities).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Hidden arbitrary metadata");
    expect(result?.entities[0].fields).not.toHaveProperty("sourceEventId");
    expect(result?.entities[0].contentHash).toBe(createHash("sha256").update(JSON.stringify({
      source: "memoryGraphEntities", id: subject, fields: fields(subject),
    })).digest("hex"));
  });

  it("exposes invalid, conflicting, missing and NULL links while preserving the independent valid role", async () => {
    for (const [parent, expected] of [
      [{ subjectEntityId: null }, "not_recorded_link"],
      [{ subjectEntityId: null, subject_entity_id: null }, "not_recorded_link"],
      [{ subjectEntityId: [subject] }, "invalid_link"],
      [{ subjectEntityId: subject, subject_entity_id: object }, "conflicting_aliases"],
      [{}, "missing_link"],
    ] as const) {
      const read = vi.fn(async (id: string) => ({ fields: fields(id) }));
      const result = await platformLinkedEntityIdentities("memoryGraphRelations", { ...parent, objectEntityId: object }, read, scope);
      expect(result?.gaps).toContainEqual({ via: "subjectEntityId", status: expected });
      expect(read.mock.calls).toEqual([[object]]);
      expect(result?.entities[0].id).toBe(object);
    }
  });

  it("does not leak a mismatched row or an exception string and marks both failures", async () => {
    const read = vi.fn(async (id: string) => {
      if (id === subject) return { fields: { ...fields(object), name: "Other owner's private name" } };
      throw Error("http://private.invalid Authorization: bearer secret");
    });
    const result = await platformLinkedEntityIdentities("memoryGraphRelations", { subjectEntityId: subject, objectEntityId: object }, read, scope);
    expect(result?.entities).toEqual([]);
    expect(result?.gaps.map(gap => gap.status)).toEqual(["identity_mismatch", "query_error"]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("bearer");
  });

  it("preserves empty, NULL and missing values and rejects invalid date or non-scalar identity values", async () => {
    const result = await platformLinkedEntityIdentities("memoryGraphRelations", { subjectEntityId: subject }, async () => ({
      fields: { id: subject, name: "", entityType: null, createdAt: new Date("invalid"), description: null },
    }), scope);
    expect(result?.entities[0].fields).toEqual({ id: subject, name: "", entityType: null });
    expect(result?.entities[0].fieldAvailability).toMatchObject({ name: "empty_string", entityType: "not_recorded",
      description: "not_recorded", createdAt: "present_unread" });
    expect(result?.gaps).toContainEqual(expect.objectContaining({ field: "createdAt", status: "invalid_field" }));
    expect(result?.entities[0].rawRecordComplete).toBe(false);
  });

  it("keeps the independent raw hash/ref when whole identity fields are oversized", async () => {
    const long = { ...fields(subject), name: "full name".repeat(2000), description: "full description".repeat(10000) };
    const result = await platformLinkedEntityIdentities("memoryGraphRelations", { subjectEntityId: subject, objectEntityId: null },
      async () => ({ fields: long }), scope);
    const child = result?.entities[0];
    expect(child?.fields).not.toHaveProperty("name");
    expect(child?.fieldAvailability).toMatchObject({ name: "present_unread", description: "present_unread" });
    expect(child?.contentHash).toBe(createHash("sha256").update(JSON.stringify({
      source: "memoryGraphEntities", id: subject, fields: long,
    })).digest("hex"));
    expect(child?.rawRead.expectedHash).toBe(child?.contentHash);
    expect(JSON.stringify(result)).not.toContain("full name");
    expect(JSON.stringify(result)).not.toContain("full description");
  });

  it("bounds the total added projection even with maximum whole fields and captured metadata", async () => {
    const result = await platformLinkedEntityIdentities("memoryGraphRelations", { subjectEntityId: subject, objectEntityId: object }, async id => ({
      fields: { id, name: "n".repeat(254), entityType: "t".repeat(126), description: "d".repeat(20000), createdAt: "c".repeat(98) },
      sourceHash: "a".repeat(64), evidenceId: "e".repeat(200),
    }), "frozen_owner_linked_capture");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3000);
    expect(result?.entities).toHaveLength(2);
    expect(result?.entities.every(child => child.rawRecordComplete === false)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("d".repeat(200));
  });

  it("bounds escaped captured metadata by serialized characters rather than string length", async () => {
    const result = await platformLinkedEntityIdentities("memoryGraphRelations", { subjectEntityId: subject, objectEntityId: object },
      async id => ({ fields: fields(id), sourceHash: "a".repeat(64), evidenceId: "\u0000".repeat(200) }), "frozen_owner_linked_capture");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(3000);
    expect(result?.entities.every(child => !("evidenceId" in child))).toBe(true);
    expect(result?.gaps).toContainEqual(expect.objectContaining({ field: "evidenceId", status: "oversize" }));
  });
});
