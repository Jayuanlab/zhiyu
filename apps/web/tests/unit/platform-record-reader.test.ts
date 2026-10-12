import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readPlatformRecordsForOwner, readPlatformRecordForOwner, projectPlatformRecords, platformRecordIds } from "@/lib/ai/platform-record-reader";
import { platformRecordFieldAvailability, platformRecordRelatedReads, platformRecordSemantics } from "@/lib/ai/platform-record-semantics";
import { PlatformReadHandleRegistry } from "@/lib/ai/platform-read-handle-registry";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";

const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
const parent = "44861dfc-916f-431f-899b-364ca54f0aa1";
describe("controlled message chat-title read", () => {
  it("reads the independently owned chat title and rechecks the message relation under the same budget", async () => {
    const identity = { ownerId: "owner", requester: { kind: "chat" as const, id: "desktop" }, turnId: "turn-title" };
    const registry = new PlatformReadHandleRegistry(identity), budget = createMemoryReadBudget();
    const fields = { id, chatId: parent, role: "assistant", parts: [{ type: "text", text: "x".repeat(20000) }] };
    const chat = { id: parent, title: "New Chat", visibility: "public", createdAt: "2026-10-02T06:01:46.768Z" };
    const query = vi.fn(async (source: readonly string[], ids: string[], owner: string) => {
      expect(owner).toBe("owner");
      expect(ids).toEqual([source[0] === "chat" ? parent : id]);
      return source[0] === "chat" ? [chat] : [fields];
    });
    const raw = JSON.stringify({ source: "message", id, fields });
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "message", id,
      relatedChatTitle: { originalQuestion: `消息记录 ${id} 的角色、正文和所属聊天标题是什么？`, identity, registry, budget } }, query);
    expect(page).toMatchObject({ status: "read", content: raw.slice(0, 8000), contentHash: createHash("sha256").update(raw).digest("hex"),
      relatedChatTitle: { status: "read", reads: [{ stage: "chat_title", status: "read", attemptCharged: true }, { stage: "parent_recheck", status: "read", attemptCharged: true }] },
      fieldRead: { source: "chat", id: parent, status: "read", parentContentHash: createHash("sha256").update(JSON.stringify({ source: "chat", id: parent, fields: chat })).digest("hex"),
        fields: [{ fieldKey: "title", value: "New Chat", complete: true }], coverage: { fieldComplete: true, rawRecordComplete: false } } });
    expect(query.mock.calls.map(call => call[0][0])).toEqual(["message", "chat", "message"]);
    expect(budget.snapshot()).toMatchObject({ attempts: 2, inFlight: 0, maximumAttempts: 10, maximumSingleCharacters: 24000, maximumTotalCharacters: 64000 });
  });
});
describe("initial partial record published identity facts", () => {
  it("constructs v2 whole trigger/result facts from the owner-checked row even when their bytes are outside the raw first page", async () => {
    const triggerReason = { reason: { type: "native_scheduler" }, triggeredBy: "scheduler" }, outputSummary = "Recorded checkpoint with no actionable increment.";
    const fields = { id, loopId: parent, status: "success", verificationResult: "x".repeat(20000), triggerReason, outputSummary, error: null };
    const before = JSON.stringify(fields), raw = JSON.stringify({ source: "loopRuns", id, fields });
    const query = vi.fn(async (_source, _ids, owner) => owner === "owner" ? [fields] : []);
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "loopRuns", id }, query);
    expect(page).toMatchObject({ status: "read", content: raw.slice(0, 8000), contentHash: createHash("sha256").update(raw).digest("hex"), truncated: true });
    if (page.status !== "read") throw Error("Expected owner-checked initial record page");
    expect(page.content).not.toContain("native_scheduler");
    expect(page.content).not.toContain(outputSummary);
    if (!("publishedFacts" in page) || !page.publishedFacts) throw Error("Expected v2 row facts");
    expect(page.publishedFacts).toMatchObject({ schemaVersion: "platform-published-record-facts.v2", parentContentHash: createHash("sha256").update(raw).digest("hex"), rawRecordComplete: false });
    for (const [fieldKey, value] of [["triggerReason", triggerReason], ["outputSummary", outputSummary]] as const) {
      expect(page.publishedFacts.fields.find(f=>f.fieldKey===fieldKey)).toMatchObject({ value, valueHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"), complete: true });
    }
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][2]).toBe("owner");
    expect(JSON.stringify(fields)).toBe(before);
    const other = await readPlatformRecordForOwner({ userId: "other", source: "loopRuns", id }, query);
    expect(other).toMatchObject({ status: "not_found_in_scope" });
    expect(other).not.toHaveProperty("publishedFacts");
  });

  it("delivers whole role/chat identity independently of unread long text, without changing parent raw/hash", async () => {
    const fields = { id, chatId: parent, role: "assistant", parts: [{ type: "text", text: "x".repeat(20000) }], createdAt: "2026-10-02T06:01:46.768Z" };
    const query = vi.fn(async (_source, _ids, owner) => owner === "owner" ? [fields] : []);
    const raw = JSON.stringify({ source: "message", id, fields });
    const first = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, query);
    expect(first).toMatchObject({ status: "read", truncated: true, content: raw.slice(0, 8000), contentHash: createHash("sha256").update(raw).digest("hex") });
    expect(first).toHaveProperty("publishedFacts");
    const facts = (first as typeof first & { publishedFacts: { source: string; id: string; parentContentHash: string; fields: Array<{ fieldKey: string; value?: unknown; complete: boolean }> } }).publishedFacts;
    expect(facts).toMatchObject({ source: "message", id, parentContentHash: createHash("sha256").update(raw).digest("hex") });
    expect(facts.fields.find(f => f.fieldKey === "role")).toMatchObject({ value: "assistant", complete: true });
    expect(facts.fields.find(f => f.fieldKey === "chatId")).toMatchObject({ value: parent, complete: true });
    expect(facts.fields.some(f => f.fieldKey === "parts")).toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });

  it("does not attach new facts to changed versions, continuation pages, missing rows or missing owner scope", async () => {
    const fields = { id, loopId: parent, status: "running", error: null, outputSummary: "x".repeat(20000) };
    const query = vi.fn(async (_source, _ids, owner) => owner === "other" ? [] : [fields]);
    const raw = JSON.stringify({ source: "loopRuns", id, fields });
    for (const input of [
      { userId: "owner", offset: 8000 }, { userId: "owner", expectedHash: "0".repeat(64) },
      { userId: "other" }, { userId: "" },
    ]) {
      const page = await readPlatformRecordForOwner({ source: "loopRuns", id, ...input }, query);
      expect(page).not.toHaveProperty("publishedFacts");
    }
    const first = await readPlatformRecordForOwner({ userId: "owner", source: "loopRuns", id }, query);
    expect(first).toHaveProperty("publishedFacts.parentContentHash", createHash("sha256").update(raw).digest("hex"));
  });

  it("does not certify an ambiguous parent identity even though legacy raw behavior stays unchanged", async () => {
    const fields = { id, role: "assistant", chatId: parent };
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [fields, { ...fields, role: "user" }]));
    expect(page).toMatchObject({ status: "read", content: JSON.stringify({ source: "message", id, fields }) });
    expect(page).not.toHaveProperty("publishedFacts");
  });
});
describe("bounded linked entity identities on initial exact relation reads", () => {
  const subject = "bdde680e-6dc0-4902-822c-7f4c6d00ca87";
  const object = "ffe86e53-66e4-4988-98b7-6c5850e9cdd6";
  const relation = { id, subjectEntityId: subject, objectEntityId: object, claim: "A recorded relation" };
  const entity = (target: string) => ({ id: target, name: target === subject ? "Subject" : "Object",
    entityType: "person", description: "Private description", createdAt: "2026-10-02T06:01:46.768Z" });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const linkedIdentity = (page: Awaited<ReturnType<typeof readPlatformRecordForOwner>>) => {
    if (!("linkedEntities" in page) || !page.linkedEntities) throw Error("Expected declared identity projection");
    return page.linkedEntities;
  };

  it("checks the same owner for at most two fixed entity IDs and retains independent parent and child hashes", async () => {
    const query = vi.fn(async (source: readonly string[], ids: string[], owner: string) => {
      expect(owner).toBe("owner");
      if (source[0] === "memoryGraphRelations") return [relation];
      expect(source).toEqual(["memoryGraphEntities", "owner", "id", "id name entityType description createdAt"]);
      expect(ids).toHaveLength(1);
      return [entity(ids[0])];
    });
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
    const raw = JSON.stringify({ source: "memoryGraphRelations", id, fields: relation });
    expect(page).toMatchObject({ status: "read", content: raw, contentHash: digest(raw), nextOffset: null });
    if (page.status !== "read") throw Error("Expected parent source page");
    const linked = linkedIdentity(page);
    expect(linked).toMatchObject({ status: "read", ownershipCheck: "repeated_for_each_entity" });
    expect(linked.entities.map(value => value.fields.name)).toEqual(["Subject", "Object"]);
    expect(query.mock.calls.map(call => call[1])).toEqual([[id], [subject], [object]]);
    for (const child of linked.entities) {
      const childRaw = JSON.stringify({ source: "memoryGraphEntities", id: child.id, fields: entity(child.id) });
      expect(child.contentHash).toBe(digest(childRaw));
      expect(child.contentHash).not.toBe(page.contentHash);
      expect(child.rawRead).toEqual({ source: "memoryGraphEntities", id: child.id, offset: 0, expectedHash: child.contentHash });
      expect(child.fields).not.toHaveProperty("description");
      expect(child.fieldAvailability.description).toBe("present_unread");
      expect(child.rawRecordComplete).toBe(false);
    }
    expect(JSON.stringify(linked).length).toBeLessThanOrEqual(3000);
    expect(linked.doesNotEstablish).toContain("claim_truth");
    expect(linked.doesNotEstablish).toContain("original_observation_read");
  });

  it("skips every child query on missing parent, wrong hash, continuation and unrelated exact sources", async () => {
    for (const variant of ["missing", "wrong_hash", "continuation", "unrelated", "no_owner"]) {
      const fields = variant === "continuation" ? { ...relation, claim: "x".repeat(20000) } : relation;
      const query = vi.fn(async (source: readonly string[]) => {
        expect(source[0]).toBe(variant === "unrelated" ? "memoryGraphEvidence" : "memoryGraphRelations");
        return variant === "missing" ? [] : [fields];
      });
      const page = await readPlatformRecordForOwner({ userId: variant === "no_owner" ? "" : "owner", source: variant === "unrelated" ? "memoryGraphEvidence" : "memoryGraphRelations", id,
        ...(variant === "wrong_hash" ? { expectedHash: "0".repeat(64) } : {}),
        ...(variant === "continuation" ? { offset: 8000 } : {}) }, query);
      expect(page).not.toHaveProperty("linkedEntities");
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves valid parent data when an owner-scoped child is missing, mismatched or fails", async () => {
    for (const failure of ["missing", "mismatch", "error"]) {
      const query = vi.fn(async (source: readonly string[], ids: string[], owner: string) => {
        expect(owner).toBe("owner");
        if (source[0] === "memoryGraphRelations") return [relation];
        if (ids[0] === object) return [entity(object)];
        if (failure === "error") throw Error("Private endpoint and credentials must not be returned");
        return failure === "missing" ? [] : [entity(object)];
      });
      const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
      expect(page.status).toBe("read");
      const linked = linkedIdentity(page);
      expect(linked.status).toBe("partial");
      expect(linked.entities.map(value => value.id)).toEqual([object]);
      expect(linked.gaps).toContainEqual(expect.objectContaining({ id: subject,
        status: failure === "missing" ? "not_found_in_scope" : failure === "error" ? "query_error" : "identity_mismatch" }));
      expect(JSON.stringify(linked)).not.toContain("Private endpoint");
      expect(JSON.stringify(linked)).not.toContain("credentials");
    }
  });

  it("uses only strict scalar relation links and exposes invalid or conflicting roles without trying them", async () => {
    for (const fields of [
      { ...relation, subjectEntityId: [subject] },
      { ...relation, subject_entity_id: object },
      { ...relation, subjectEntityId: null },
    ]) {
      const query = vi.fn(async (source: readonly string[], ids: string[]) => source[0] === "memoryGraphRelations" ? [fields] : [entity(ids[0])]);
      const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
      const linked = linkedIdentity(page);
      expect(linked.status).toBe("partial");
      expect(linked.entities.map(value => value.id)).toEqual([object]);
      expect(linked.gaps).toContainEqual(expect.objectContaining({ via: "subjectEntityId" }));
      expect(query.mock.calls.map(call => call[1])).toEqual([[id], [object]]);
    }
  });

  it("deduplicates a shared entity and withholds overlong whole identity fields or descriptions", async () => {
    const fields = { ...relation, objectEntityId: subject.toUpperCase() };
    const large = { ...entity(subject), name: "secret-name".repeat(1000), description: "unread-description".repeat(2000) };
    const query = vi.fn(async (source: readonly string[]) => source[0] === "memoryGraphRelations" ? [fields] : [large]);
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
    const linked = linkedIdentity(page);
    expect(query).toHaveBeenCalledTimes(2);
    expect(linked.entities).toHaveLength(1);
    expect(linked.entities[0].fields).not.toHaveProperty("name");
    expect(linked.entities[0].fieldAvailability).toMatchObject({ name: "present_unread", description: "present_unread" });
    expect(linked.gaps).toContainEqual(expect.objectContaining({ id: subject, field: "name", status: "oversize" }));
    expect(JSON.stringify(linked)).not.toContain("secret-name");
    expect(JSON.stringify(linked)).not.toContain("unread-description");
    expect(JSON.stringify(linked).length).toBeLessThanOrEqual(3000);
  });

  it("preserves missing and NULL identity fields without claiming a complete child raw read", async () => {
    const fields = { ...relation, objectEntityId: null };
    const child = { id: subject, name: null, description: null };
    const query = vi.fn(async (source: readonly string[]) => source[0] === "memoryGraphRelations" ? [fields] : [child]);
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
    const linked = linkedIdentity(page);
    expect(linked.entities[0].fields.name).toBeNull();
    expect(linked.entities[0].fields).not.toHaveProperty("entityType");
    expect(linked.entities[0].fieldAvailability).toMatchObject({ name: "not_recorded", entityType: "missing", description: "not_recorded" });
    expect(linked.entities[0].rawRecordComplete).toBe(false);
  });

  it("rejects a forged internal capture scope or owner before any read", async () => {
    for (const context of [
      { scope: "arbitrary_scope", ownerId: "owner" },
      { scope: "frozen_owner_linked_capture", ownerId: "other-owner" },
    ]) {
      const query = vi.fn(async () => [relation]);
      const forged = ({ ...context, captureMetadata: (target: string) => ({ id: target, ownerId: "owner" }) }) as unknown as NonNullable<Parameters<typeof readPlatformRecordForOwner>[2]>;
      await expect(readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query, forged))
        .rejects.toThrow("Invalid linked capture context");
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("withholds foreign-owner or mismatched captured metadata instead of mixing it with a native child", async () => {
    for (const metadata of [
      { ownerId: "other-owner", id: subject },
      { ownerId: "owner", id: object },
    ]) {
      const fields = { ...relation, objectEntityId: null };
      const query = vi.fn(async (source: readonly string[]) => source[0] === "memoryGraphRelations" ? [fields] : [entity(subject)]);
      const context = ({ scope: "frozen_owner_linked_capture", ownerId: "owner",
        captureMetadata: () => ({ ...metadata, sourceHash: "b".repeat(64), evidenceId: "FOREIGN_SOURCE_METADATA" }) }) as unknown as NonNullable<Parameters<typeof readPlatformRecordForOwner>[2]>;
      const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query, context);
      expect(page.status).toBe("read");
      const linked = linkedIdentity(page);
      expect(linked.entities.map(child => child.fields.name)).toEqual(["Subject"]);
      expect(linked.gaps).toContainEqual(expect.objectContaining({ id: subject, status: "capture_metadata_not_bound" }));
      expect(JSON.stringify(linked)).not.toContain("FOREIGN_SOURCE_METADATA");
      expect(JSON.stringify(linked)).not.toContain("b".repeat(64));
    }
  });

  it("does not allow surplus capture metadata to override the owner-checked row or its independent hash", async () => {
    const fields = { ...relation, objectEntityId: null };
    const query = vi.fn(async (source: readonly string[]) => source[0] === "memoryGraphRelations" ? [fields] : [entity(subject)]);
    const context = ({ scope: "frozen_owner_linked_capture", ownerId: "owner", captureMetadata: () => ({
      ownerId: "owner", id: subject, fields: { ...entity(subject), name: "FOREIGN_ROW_OVERRIDE" },
      sourceHash: "a".repeat(64), evidenceId: "owned-capture",
    }) }) as unknown as NonNullable<Parameters<typeof readPlatformRecordForOwner>[2]>;
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query, context);
    const linked = linkedIdentity(page);
    expect(linked.entities[0].fields.name).toBe("Subject");
    expect(linked.entities[0].contentHash).toBe(digest(JSON.stringify({ source: "memoryGraphEntities", id: subject, fields: entity(subject) })));
    expect(JSON.stringify(linked)).not.toContain("FOREIGN_ROW_OVERRIDE");
  });

  it("does not silently choose a duplicate owner-visible child row", async () => {
    const query = vi.fn(async (source: readonly string[], ids: string[]) => source[0] === "memoryGraphRelations"
      ? [relation] : ids[0] === subject ? [entity(subject), { ...entity(subject), name: "Conflicting duplicate" }] : [entity(object)]);
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
    const linked = linkedIdentity(page);
    expect(linked.entities.map(child => child.id)).toEqual([object]);
    expect(linked.gaps).toContainEqual(expect.objectContaining({ id: subject, status: "duplicate_rows" }));
    expect(JSON.stringify(linked)).not.toContain("Conflicting duplicate");
  });
});
describe("strict unread graph entity references", () => {
  const subject = "bdde680e-6dc0-4902-822c-7f4c6d00ca87";
  const object = "ffe86e53-66e4-4988-98b7-6c5850e9cdd6";
  const reference = (target: string, via: string) => ({ source: "memoryGraphEntities", id: target, via });

  it("exposes only the published relation's subject and object IDs in their field order", () => {
    for (const [source, fields, via] of [
      ["memoryGraphRelations", { subjectEntityId: subject, objectEntityId: object }, ["subjectEntityId", "objectEntityId"]],
      ["memory_graph_relations", { subject_entity_id: subject, object_entity_id: object }, ["subject_entity_id", "object_entity_id"]],
    ] as const) {
      expect(platformRecordRelatedReads(source, fields)).toEqual({
        status: "unread", ownershipCheck: "required_on_read", hasMoreRefs: false,
        refs: [reference(subject, via[0]), reference(object, via[1])],
      });
    }
  });

  it("accepts agreeing aliases case-insensitively and deduplicates the same entity", () => {
    expect(platformRecordRelatedReads("memoryGraphRelations", {
      subjectEntityId: subject.toUpperCase(), subject_entity_id: subject,
      objectEntityId: object, object_entity_id: object.toUpperCase(),
    }).refs).toEqual([reference(subject, "subjectEntityId"), reference(object, "objectEntityId")]);
    expect(platformRecordRelatedReads("memory_graph_relations", {
      subject_entity_id: subject, object_entity_id: subject.toUpperCase(),
    }).refs).toEqual([reference(subject, "subject_entity_id")]);
  });

  it("withholds ambiguous aliases without dropping the other independent valid field", () => {
    for (const conflicting of [object, null, undefined, "", [subject], { id: subject }]) {
      expect(platformRecordRelatedReads("memoryGraphRelations", {
        subjectEntityId: subject, subject_entity_id: conflicting, objectEntityId: object,
      }).refs).toEqual([reference(object, "objectEntityId")]);
    }
  });

  it("does not invent scalar references from missing, NULL, malformed, array, object or inherited values", () => {
    for (const value of [null, undefined, "", "not-a-uuid", 0, true, [subject], [subject, object], { id: subject }]) {
      expect(platformRecordRelatedReads("memoryGraphRelations", { subjectEntityId: value, objectEntityId: object }).refs)
        .toEqual([reference(object, "objectEntityId")]);
    }
    expect(platformRecordRelatedReads("memoryGraphRelations", {}).refs).toEqual([]);
    expect(platformRecordRelatedReads("memoryGraphRelations", Object.create({ subjectEntityId: subject })).refs).toEqual([]);
    expect(platformRecordRelatedReads("memoryGraphRelations", { claim: subject, metadata: { objectEntityId: object } }).refs).toEqual([]);
    expect(platformRecordRelatedReads("arbitrary_source", { subjectEntityId: subject, objectEntityId: object }).refs).toEqual([]);
  });

  it("retains existing array provenance and the existing bound for other sources", () => {
    const eventIds = Array.from({ length: 10 }, (_, index) => "10000000-0000-4000-8000-" + String(index).padStart(12, "0"));
    const result = platformRecordRelatedReads("interactionTasks", { sourceEventIds: eventIds });
    expect(result).toMatchObject({ status: "unread", ownershipCheck: "required_on_read", hasMoreRefs: true });
    expect(result.refs).toEqual(eventIds.slice(0, 8).map(target => ({ source: "interactionEvents", id: target, via: "sourceEventIds" })));
    expect(platformRecordRelatedReads("memoryGraphEvidence", { relationId: parent }).refs)
      .toEqual([{ source: "memoryGraphRelations", id: parent, via: "relationId" }]);
    expect(platformRecordRelatedReads("loopRuns", { loopId: parent }).refs)
      .toEqual([{ source: "loops", id: parent, via: "loopId" }]);
  });

  it("keeps parent raw/hash and paging while the declared initial identity projection repeats owner reads", async () => {
    const fields = { id, subjectEntityId: subject, objectEntityId: object, claim: "stored claim ".repeat(1700) };
    const query = vi.fn(async (source, ids, owner) => {
      expect(owner).toBe("owner");
      if (source[0] === "memoryGraphEntities") {
        expect(ids).toHaveLength(1);
        expect([subject, object]).toContain(ids[0]);
        return [];
      }
      expect(source[0]).toBe("memoryGraphRelations");
      expect(ids).toEqual([id]);
      return [fields];
    });
    const raw = JSON.stringify({ source: "memoryGraphRelations", id, fields });
    const first = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id }, query);
    if (first.status !== "read" || first.nextOffset === null) throw Error("Expected bounded parent page");
    expect(first.content).toBe(raw.slice(0, 8000));
    expect(first.contentHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(first.relatedReads).toEqual({
      status: "unread", ownershipCheck: "required_on_read", hasMoreRefs: false,
      refs: [reference(subject, "subjectEntityId"), reference(object, "objectEntityId")],
    });
    expect(first.fieldReadCoverage).toBe("character_window");
    expect(first.relatedReads?.refs.every(ref => !("expectedHash" in ref))).toBe(true);
    const next = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id,
      offset: first.nextOffset, expectedHash: first.contentHash }, query);
    expect(next).toMatchObject({ status: "read", content: raw.slice(8000, 16000), contentHash: first.contentHash });
    const changed = await readPlatformRecordForOwner({ userId: "owner", source: "memoryGraphRelations", id,
      expectedHash: "0".repeat(64) }, query);
    expect(changed).toMatchObject({ status: "version_changed", content: "" });
    expect(changed).not.toHaveProperty("relatedReads");
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("reads an entity only explicitly, repeats owner scope and binds its independent version hash", async () => {
    const entity = { id: subject, name: "Recorded entity", entityType: "person", description: "x".repeat(17000) };
    const query = vi.fn(async (source, ids, owner) => {
      expect(source[0]).toBe("memoryGraphEntities");
      expect(ids).toEqual([subject]);
      return owner === "owner" ? [entity] : [];
    });
    const ref = platformRecordRelatedReads("memoryGraphRelations", { subjectEntityId: subject }).refs[0];
    expect(query).not.toHaveBeenCalled();
    const denied = await readPlatformRecordForOwner({ userId: "other-owner", ...ref }, query);
    expect(denied).toMatchObject({ status: "not_found_in_scope" });
    expect(denied).not.toHaveProperty("content");
    const first = await readPlatformRecordForOwner({ userId: "owner", ...ref }, query);
    if (first.status !== "read" || first.nextOffset === null) throw Error("Expected independent entity continuation");
    const raw = JSON.stringify({ source: ref.source, id: ref.id, fields: entity });
    expect(first.contentHash).toBe(createHash("sha256").update(raw).digest("hex"));
    const next = await readPlatformRecordForOwner({ userId: "owner", ...ref,
      offset: first.nextOffset, expectedHash: first.contentHash }, query);
    expect(next).toMatchObject({ status: "read", contentHash: first.contentHash });
    const mismatch = await readPlatformRecordForOwner({ userId: "owner", ...ref,
      expectedHash: createHash("sha256").update("parent relation raw").digest("hex") }, query);
    expect(mismatch).toMatchObject({ status: "version_changed", content: "" });
  });
});

describe("owner platform records", () => {
  it("keeps oversized exact records discoverable and expands a matching version with owner scope", async () => {
    const fields = { id, loopId: parent, status: "failed", error: "context limit", triggerReason: { text: "x".repeat(24000) } };
    const query = vi.fn(async (source, ids, userId) => {
      expect(userId).toBe("owner");
      return source[0] === "loopRuns" && ids.includes(id) ? [fields] : [];
    });
    const discovered = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    const compact = projectPlatformRecords(discovered);
    const record = compact.records.find(row => row.source === "loopRuns")! as any;
    expect(JSON.stringify(compact).length).toBeLessThan(8000);
    expect(record.fields).toMatchObject({ id, status: "failed", error: "context limit" });
    expect(record.fields).not.toHaveProperty("triggerReason");
    expect(record.fieldAvailability).toMatchObject({ triggerReason: "present_unread", status: "shown" });
    expect(compact.pendingExactReads).toEqual([expect.objectContaining({ source: "loopRuns", id, expectedHash: record.contentHash })]);
    const first = await readPlatformRecordForOwner({ userId: "owner", ...record.read }, query);
    expect(first).toMatchObject({ status: "read", contentHash: record.contentHash, nextOffset: 8000 });
    const next = await readPlatformRecordForOwner({ userId: "owner", ...record.read, offset: 8000 }, query);
    expect(next).toMatchObject({ status: "read", contentHash: record.contentHash });
    const changed = await readPlatformRecordForOwner({ userId: "owner", ...record.read }, vi.fn(async () => [{ ...fields, status: "updated" }]));
    expect(changed).toMatchObject({ status: "version_changed", content: "" });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopRuns"]), [id], "owner");
  });
  it("never lets a cursor or source name escape the fixed owner-checked catalog", async () => {
    const query = vi.fn(async () => []);
    await expect(readPlatformRecordForOwner({ userId: "owner", source: "unknown", id }, query)).rejects.toThrow("Unsupported");
    expect(query).not.toHaveBeenCalled();
    expect(await readPlatformRecordForOwner({ userId: "owner", source: "loopRuns", id }, query)).toMatchObject({ status: "not_found_in_scope" });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopRuns"]), [id], "owner");
  });
  it("keeps persisted-state time semantics on an exact loopStates read", async () => {
    const updatedAt = new Date("2026-09-19T02:02:18.594Z");
    const query = vi.fn(async () => [{ loopId: id, currentPhase: "error", updatedAt }] as Record<string, unknown>[]);
    const result = await readPlatformRecordForOwner({ userId: "owner", source: "loopStates", id }, query);
    expect(result).toMatchObject({ status: "read", temporalScope: { kind: "last_persisted_state",
      lastRecordedAt: updatedAt, currentRuntimeVerified: false } });
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopStates"]), [id], "owner");
  });
  it("supports named entities without requiring users to know record IDs", async () => {
    const query = vi.fn(async (source, ids, userId, names) => source[0] === "loops" && names.includes("Daily review")
      ? [{ id, name: "Daily review", status: "paused" }] : []);
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: 'Is "Daily review" running?' }, query);
    expect(result.records).toHaveLength(1);
    expect(result.requestedNames).toEqual(["Daily review"]);
  });
  it("reads exact records outside list windows and expands owner-checked provenance", async () => {
    const query = vi.fn(async (source, ids, userId) => {
      expect(userId).toBe("owner");
      if (source[0] === "loops" && ids.includes(id)) return [{ id, workshopId: parent, status: "paused", triggerConfig: { cron: "10 16 * * 1-5" } }];
      if (source[0] === "loopStates" && ids.includes(id)) return [{ loopId: id, currentPhase: "error", blockedReason: "context limit", openQuestions: [], nextAction: null }];
      if (source[0] === "workshops" && ids.includes(parent)) return [{ id: parent, mission: "Research" }];
      return [];
    });
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    expect(result.missingIds).toEqual([]);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "loopStates", fields: expect.objectContaining({ currentPhase: "error", nextAction: null, openQuestions: [] }) }),
      expect.objectContaining({ source: "workshops", id: parent }),
    ]));
    expect(result.failedSources).toEqual([]);
    const state = projectPlatformRecords(result).records.find(record => record.source === "loopStates") as any;
    expect(state.temporalScope).toMatchObject({ kind: "last_persisted_state", currentRuntimeVerified: false });
  });
  it("distinguishes source failure from absent records and never queries without identifiers", async () => {
    const query = vi.fn(async () => { throw Error("unavailable"); });
    expect((await readPlatformRecordsForOwner({ userId: "owner", question: "general architecture" }, query)).records).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    const result = await readPlatformRecordsForOwner({ userId: "owner", question: id }, query);
    expect(result.failedSources).toContain("loops");
    expect(result.missingIds).toEqual([id]);
    expect(platformRecordIds(`${id} ${id}`)).toEqual([id]);
  });
  it("does not promote quote-shaped note content into verified original text", async () => {
    const fields = { id, noteType: "summary", body: '2026-09-20 Alice: "confirmed"',
      confidence: 100, sourceEventIds: [parent], model: null };
    const query = vi.fn(async (source, ids, owner) => {
      expect(owner).toBe("owner");
      return source[0] === "interactionNotes" && ids.includes(id) ? [fields] : [];
    });
    const discovered = projectPlatformRecords(await readPlatformRecordsForOwner({ userId: "owner", question: id }, query));
    const note = discovered.records.find(record => record.source === "interactionNotes")!;
    expect(note).toMatchObject({ fields, semantics: { layer: "derived_interpretation", verification: "not_assessed",
      doesNotEstablish: ["verbatim_original_text"] }, fieldAvailability: { body: "shown", model: "not_recorded" } });
    const exact = await readPlatformRecordForOwner({ userId: "owner", source: "interactionNotes", id }, query);
    if (exact.status !== "read") throw Error("Expected an exact note read");
    expect(JSON.parse(exact.content)).toEqual({ source: "interactionNotes", id, fields });
    expect(exact).toMatchObject({ fieldReadCoverage: "complete_record", semantics: { verification: "not_assessed" } });
    expect(platformRecordSemantics("interaction_notes")).toEqual(note.semantics);
  });
  it("retains whole policies, empty requirements and scalar types when another field is oversized", async () => {
    const fields = { id, workshopId: parent, status: "active", name: "Preparation", goal: "x".repeat(12000),
      triggerConfig: { type: "cron", cron: "0 9 * * 1-5" },
      actionPolicy: { allowed: ["prepare_report"], denied: ["external_write"] },
      approvalPolicy: { required: [], enabled: false } };
    const discovered = await readPlatformRecordsForOwner({ userId: "owner", question: id },
      vi.fn(async source => source[0] === "loops" ? [fields] : []));
    const record = projectPlatformRecords(discovered).records.find(record => record.source === "loops")! as any;
    expect(record.fields).toMatchObject({ triggerConfig: fields.triggerConfig, actionPolicy: fields.actionPolicy,
      approvalPolicy: fields.approvalPolicy });
    expect(record.fields).not.toHaveProperty("goal");
    expect(record.fieldAvailability).toMatchObject({ goal: "present_unread", actionPolicy: "shown", approvalPolicy: "shown" });
    expect(record.semantics).toMatchObject({ layer: "configuration", statusScope: "loop_configuration_state", verification: "not_assessed" });
    expect(JSON.stringify(record.fields).length).toBeLessThanOrEqual(1800);
  });
  it("withholds an oversized policy intact and preserves its exact expansion hash", async () => {
    const fields = { id, status: "active", actionPolicy: { allowed: ["read"], denied: ["x".repeat(12000)] }, approvalPolicy: {} };
    const query = vi.fn(async source => source[0] === "loops" ? [fields] : []);
    const discovered = projectPlatformRecords(await readPlatformRecordsForOwner({ userId: "owner", question: id }, query));
    const record = discovered.records.find(record => record.source === "loops")! as any;
    expect(record.fields).not.toHaveProperty("actionPolicy");
    expect(record.fieldAvailability.actionPolicy).toBe("present_unread");
    expect(record.fieldAvailability.approvalPolicy).toBe("empty_object");
    const first = await readPlatformRecordForOwner({ userId: "owner", ...record.read }, query);
    expect(first).toMatchObject({ status: "read", contentHash: record.contentHash, fieldReadCoverage: "character_window",
      fieldAvailability: { actionPolicy: "present_unread", status: "present_unread" } });
    if (first.status !== "read" || first.nextOffset === null) throw Error("Expected a continuation page");
    const next = await readPlatformRecordForOwner({ userId: "owner", ...record.read, offset: first.nextOffset }, query);
    if (next.status !== "read") throw Error("Expected a continuation read");
    expect(JSON.parse(first.content + next.content).fields.actionPolicy).toEqual(fields.actionPolicy);
  });
  it("distinguishes recorded queue status from delivery verification even for sent rows", async () => {
    const fields = { id, workshopId: parent, status: "sent", sentAt: "2026-09-20T00:00:00.000Z",
      message: "x".repeat(12000), sourceEventIds: [], boundaryResult: { decision: "allowed" } };
    const query = vi.fn(async source => source[0] === "workshopOutbox" ? [fields] : []);
    const projected = projectPlatformRecords(await readPlatformRecordsForOwner({ userId: "owner", question: id }, query));
    const record = projected.records.find(row => row.source === "workshopOutbox")! as any;
    expect(record.fields).toMatchObject({ status: "sent", sentAt: fields.sentAt, sourceEventIds: [], boundaryResult: fields.boundaryResult });
    expect(record.semantics).toMatchObject({ statusScope: "recorded_message_queue_state", verification: "not_assessed",
      doesNotEstablish: ["provider_confirmed_delivery", "recipient_received_message"] });
    expect(record.fieldAvailability).toMatchObject({ sourceEventIds: "empty_array", message: "present_unread" });
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "workshopOutbox", id }, query);
    if (page.status !== "read") throw Error("Expected an exact outbox read");
    expect(page.semantics).toEqual(record.semantics);
    expect(projected.recordCoverage).toMatchObject({ populationCount: "not_computed", scope: "bounded_identifier_lookup" });
  });
  it("keeps configuration approval, saved versions and runtime binding as distinct evidence", async () => {
    const fixtures = {
      workshopReviewItems: { id, status: "dismissed", resolvedAt: null },
      workshopWorkVersions: { id, version: "v5", changeEventId: null },
      workshopRuntimeSnapshots: { id, runId: parent, runtimeHash: "runtime", policyHash: "policy", allowedToolCount: 0 },
    };
    for (const [source, fields] of Object.entries(fixtures)) {
      const page = await readPlatformRecordForOwner({ userId: "owner", source, id }, vi.fn(async () => [fields]));
      if (page.status !== "read") throw Error("Expected an exact configuration read");
      expect(page.semantics.verification).toBe("not_assessed");
      expect(JSON.parse(page.content).fields).toEqual(fields);
    }
    expect(platformRecordSemantics("workshop_review_items").doesNotEstablish).toContain("configuration_approved");
    expect(platformRecordSemantics("workshopWorkVersions").doesNotEstablish).toContain("configuration_loaded_by_a_run");
    expect(platformRecordSemantics("workshop_runtime_snapshots").layer).toBe("runtime_binding");
  });
  it("makes unrecorded, withheld, empty, zero and false values distinguishable", () => {
    const fields = { nullValue: null, missing: undefined, withheld: { large: "known but unread" },
      emptyList: [], emptyObject: {}, emptyString: "", zero: 0, disabled: false };
    const { withheld, ...delivered } = fields;
    expect(platformRecordFieldAvailability(fields, delivered)).toEqual({ nullValue: "not_recorded", missing: "missing",
      withheld: "present_unread", emptyList: "empty_array", emptyObject: "empty_object", emptyString: "empty_string",
      zero: "shown", disabled: "shown" });
  });
  it("classifies aggregate dimensions without asserting counts or action outcomes", () => {
    expect(platformRecordSemantics("workshopOutbox.status")).toEqual(platformRecordSemantics("workshop_outbox"));
    expect(platformRecordSemantics("workCommands.status").doesNotEstablish).toContain("external_action_success");
    expect(platformRecordSemantics("paper_orders.status").doesNotEstablish).toContain("actual_fill");
    expect(platformRecordSemantics("work_run_evidence_bundles.capture_status").doesNotEstablish).toContain("business_acceptance");
    expect(platformRecordSemantics("new_unclassified_source")).toMatchObject({ layer: "unclassified", verification: "not_assessed" });
  });
  it("publishes unread parent refs without substituting a run payload for its Loop goal", async () => {
    const fields = { id, loopId: parent, status: "completed", outputSummary: "derived run output" };
    const query = vi.fn(async () => [fields]);
    const page = await readPlatformRecordForOwner({ userId: "owner", source: "loopRuns", id }, query);
    expect(page).toMatchObject({ relatedReads: { status: "unread", ownershipCheck: "required_on_read",
      refs: [{ source: "loops", id: parent, via: "loopId" }], hasMoreRefs: false } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.arrayContaining(["loopRuns"]), [id], "owner");
    expect(platformRecordRelatedReads("loop_runs", { loop_id: parent })).toMatchObject({
      refs: [{ source: "loops", id: parent, via: "loop_id" }] });
  });
  it("deduplicates and bounds real original-message refs without guessing arbitrary foreign keys", () => {
    const many = Array.from({ length: 12 }, (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`);
    const related = platformRecordRelatedReads("interaction_notes", { event_id: parent,
      source_event_ids: [parent, ...many, "not-a-uuid"], content: id, run_id: id });
    expect(related).toMatchObject({ status: "unread", ownershipCheck: "required_on_read", hasMoreRefs: true });
    expect(related.refs).toHaveLength(8);
    expect(related.refs.every(ref => ref.source === "interactionEvents")).toBe(true);
    expect(related.refs.filter(ref => ref.id === parent)).toHaveLength(1);
    expect(related.refs).not.toContainEqual(expect.objectContaining({ id }));
    expect(platformRecordRelatedReads("unknown_source", { loopId: parent }).refs).toEqual([]);
  });
  it("keeps workshop and Loop run foreign keys in their actual source families", () => {
    expect(platformRecordRelatedReads("workshop_events", { run_id: id, loop_run_id: parent }).refs).toEqual([
      { source: "workshopRuns", id, via: "run_id" }, { source: "loopRuns", id: parent, via: "loop_run_id" },
    ]);
    expect(platformRecordRelatedReads("workshop_review_items", { source_event_id: parent }).refs).toEqual([
      { source: "workshopEvents", id: parent, via: "source_event_id" },
    ]);
    expect(platformRecordRelatedReads("workshop_outbox", { source_event_ids: [parent] }).refs).toEqual([]);
  });
  it("exposes graph relation and message chat navigation without reading or authorizing the target", async () => {
    for (const [source, fields, target, via] of [
      ["memoryGraphEvidence", { id, relationId: parent, quote: "source quote" }, "memoryGraphRelations", "relationId"],
      ["message", { id, chatId: parent, role: "assistant", parts: [] }, "chat", "chatId"],
    ] as const) {
      const query = vi.fn(async () => [fields]);
      const page = await readPlatformRecordForOwner({ userId: "owner", source, id }, query);
      expect(page).toMatchObject({ relatedReads: { status: "unread", ownershipCheck: "required_on_read",
        refs: [{ source: target, id: parent, via }] } });
      expect(query).toHaveBeenCalledTimes(1);
    }
    expect(platformRecordRelatedReads("memory_graph_evidence", { relation_id: parent }).refs).toEqual([
      { source: "memoryGraphRelations", id: parent, via: "relation_id" },
    ]);
    expect(platformRecordRelatedReads("Message_v2", { chatId: parent }).refs).toEqual([
      { source: "chat", id: parent, via: "chatId" },
    ]);
    expect(platformRecordRelatedReads("chatMessages", { chat_id: parent }).refs).toEqual([
      { source: "chat", id: parent, via: "chat_id" },
    ]);
    expect(platformRecordRelatedReads("unknown_table", { relation_id: parent, chatId: parent }).refs).toEqual([]);
  });
  it("projects real message structure and whole text independently of large unread tool payloads", async () => {
    const fields = { id, chatId: parent, role: "assistant", parts: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "I inspected the workshop; this is the assistant's account." },
      { type: "tool-native", toolName: "platformRecall", toolOutput: "large nested output ".repeat(4000) },
      { type: "text", text: "Final response from the assistant." },
    ] };
    const query = vi.fn(async source => source[0] === "message" ? [fields] : []);
    const discovered = projectPlatformRecords(await readPlatformRecordsForOwner({ userId: "owner", question: id }, query));
    const message = discovered.records.find(record => record.source === "message")! as any;
    expect(message.fields).toMatchObject({ chatId: parent, role: "assistant" });
    expect(message.fieldAvailability.parts).toBe("present_unread");
    expect(message.messageStructure).toMatchObject({ role: "assistant", chatId: parent, partCount: 4,
      parts: [{ index: 0, type: "reasoning", payloadStatus: "present_unread" },
        { index: 1, type: "text", textStatus: "shown", text: fields.parts[1].text },
        { index: 2, type: "tool-native", toolName: "platformRecall", payloadStatus: "present_unread" },
        { index: 3, type: "text", textStatus: "shown", text: fields.parts[3].text }],
      rawRecordComplete: false, hasMoreParts: false, knownTextPartsComplete: true,
      rawRead: { source: "message", id, offset: 0, expectedHash: message.contentHash } });
    expect(JSON.stringify(message.messageStructure)).not.toContain("private reasoning");
    expect(JSON.stringify(message.messageStructure)).not.toContain("large nested output");
    const first = await readPlatformRecordForOwner({ userId: "owner", ...message.read }, query) as any;
    expect(first.messageStructure).toEqual(message.messageStructure);
    expect(first.nextOffset).toBe(8000);
    expect(first.contentHash).toBe(createHash("sha256").update(JSON.stringify({ source: "message", id, fields })).digest("hex"));
    expect(first.content).toBe(JSON.stringify({ source: "message", id, fields }).slice(0, 8000));
    const next = await readPlatformRecordForOwner({ userId: "owner", ...message.read, offset: 8000 }, query) as any;
    expect(next.messageStructure).toBeUndefined();
    expect(next.contentHash).toBe(first.contentHash);
  });
  it("withholds long message text whole and labels unknown parts instead of silently trimming them", async () => {
    const fields = { id, chatId: parent, role: "user", parts: [
      { type: "text", text: "x".repeat(22000) },
      { type: "future-media", text: "unknown part payload", binary: "unknown hidden bytes" },
      null,
    ] };
    const result = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [fields])) as any;
    expect(result.messageStructure).toMatchObject({ rawRecordComplete: false, knownTextPartsComplete: false,
      parts: [{ index: 0, type: "text", textStatus: "present_unread", textCharacters: 22000 },
        { index: 1, type: "future-media", payloadStatus: "present_unread" },
        { index: 2, type: null, payloadStatus: "invalid_part" }] });
    expect(result.messageStructure.parts[0]).not.toHaveProperty("text");
    expect(JSON.stringify(result.messageStructure)).not.toContain("unknown part payload");
    expect(result.content.length).toBe(8000);
  });
  it("bounds parts metadata and returns raw continuation instead of claiming all parts were shown", async () => {
    const fields = { id, chatId: parent, role: "user", parts: Array.from({ length: 80 }, (_, index) => ({ type: "text", text: `part ${index}` })) };
    const result = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [fields])) as any;
    expect(result.messageStructure).toMatchObject({ partCount: 80, hasMoreParts: true, knownTextPartsComplete: false, rawRecordComplete: false });
    expect(result.messageStructure.parts.length).toBeLessThanOrEqual(32);
    expect(result.messageStructure.omittedPartCount).toBe(80 - result.messageStructure.parts.length);
    expect(JSON.stringify(result.messageStructure).length).toBeLessThanOrEqual(7000);
  });
  it("keeps absent, empty and invalid parts distinct and exposes no new projection on version mismatch", async () => {
    for (const [fields, partsStatus] of [[{ id, role: "assistant" }, "missing"],
      [{ id, parts: null }, "not_recorded"], [{ id, parts: [] }, "empty_array"], [{ id, parts: "invalid" }, "invalid"]] as const) {
      const result = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [fields])) as any;
      expect(result.messageStructure.partsStatus).toBe(partsStatus);
    }
    const nullChat = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [{ id, chatId: null, parts: [] }])) as any;
    expect(nullChat.messageStructure.chatIdStatus).toBe("not_recorded");
    const query = vi.fn(async () => [{ id, role: "assistant", parts: [{ type: "text", text: "new version" }] }]);
    const mismatch = await readPlatformRecordForOwner({ userId: "owner", source: "message", id, expectedHash: "0".repeat(64) }, query) as any;
    expect(mismatch).toMatchObject({ status: "version_changed", content: "" });
    expect(mismatch.messageStructure).toBeUndefined();
    const unrelated = await readPlatformRecordForOwner({ userId: "owner", source: "interactionNotes", id }, query) as any;
    expect(unrelated.messageStructure).toBeUndefined();
  });
  it("does not leak a foreign chat or relation through an owner-visible navigation ref", async () => {
    const query = vi.fn(async (source, ids, owner) => {
      expect(owner).toBe("owner");
      if (source[0] === "message" && ids.includes(id)) return [{ id, chatId: parent, role: "assistant", parts: [] }];
      if (source[0] === "memoryGraphEvidence" && ids.includes(id)) return [{ id, relationId: parent, quote: "visible quote" }];
      return [];
    });
    for (const source of ["message", "memoryGraphEvidence"]) {
      const result = await readPlatformRecordForOwner({ userId: "owner", source, id }, query) as any;
      const ref = result.relatedReads.refs[0];
      expect(ref).toBeDefined();
      expect(await readPlatformRecordForOwner({ userId: "owner", source: ref.source, id: ref.id }, query)).toMatchObject({ status: "not_found_in_scope" });
    }
    expect(JSON.stringify(query.mock.results)).not.toContain("foreign content");
  });
  it("keeps oversized header and part labels out of the bounded message view and leaves fields unchanged", async () => {
    const fields = { id, chatId: "untrusted chat label ".repeat(2000), role: "r".repeat(20000), parts: [
      { type: "unknown ".repeat(2000), toolName: "large tool label ".repeat(2000), text: "unread content" },
      ...Array.from({ length: 30 }, () => ({ type: "text", text: "x".repeat(1800) })),
    ] };
    const before = JSON.stringify(fields);
    const result = await readPlatformRecordForOwner({ userId: "owner", source: "message", id }, vi.fn(async () => [fields])) as any;
    expect(result.messageStructure.chatIdStatus).toBe("invalid");
    expect(result.messageStructure).not.toHaveProperty("chatId");
    expect(result.messageStructure).not.toHaveProperty("role");
    expect(JSON.stringify(result.messageStructure).length).toBeLessThanOrEqual(7000);
    expect(result.messageStructure.parts.some((part: Record<string, unknown>) => part.textStatus === "present_unread")).toBe(true);
    expect(result.messageStructure.knownTextPartsComplete).toBe(false);
    expect(JSON.stringify(fields)).toBe(before);
  });
});
