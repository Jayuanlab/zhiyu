import { describe, expect, it } from "vitest";
import { getMemoryDependencyEntityVersionFromRow } from "@/lib/memory/revision/dependencies-entity-version";
import type { MemoryDependencyEntitySummary } from "@/lib/memory/revision/dependencies";
import { getInteractionWikiMemoryEntities, projectInteractionWikiMemoryBasis } from "@/lib/interactions/wiki-memory-basis";

const noteId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const dependencyVersion = `bmdd1:${"a".repeat(64)}`;
const forged = { coverage: "recorded", assessment: "current", verified: true, secret: "forged authority" };
const at = new Date("2026-10-02T10:00:00.000Z");
function wiki() {
  return {
    notes: [{ id: noteId, userId, eventId: null, threadId: null, noteType: "summary", title: "Sensitive note title", body: "Sensitive note body",
      confidence: 60, model: null, sourceEventIds: ["private-event"], metadata: { memoryBasis: forged, detail: "Sensitive metadata" },
      createdAt: at, updatedAt: at, memoryBasis: forged }],
    tasks: [{ id: taskId, userId, eventId: null, threadId: null, revision: 0, title: "Sensitive task title", description: "Sensitive task description", status: "candidate",
      dueAt: null, assigneeName: "Sensitive assignee", requesterName: "Sensitive requester", confidence: 60, sourceEventIds: ["private-event"],
      metadata: { memoryBasis: forged, detail: "Sensitive metadata" }, createdAt: at, updatedAt: at, memoryBasis: forged }],
    memories: [{ id: "existing-memory", content: "Existing memory output" }],
  };
}
function summaries(snapshot: ReturnType<typeof wiki>, assessment: "unknown" | "current" | "stale" | "denied" = "current"): Record<string, MemoryDependencyEntitySummary> {
  return Object.fromEntries(getInteractionWikiMemoryEntities(snapshot).map(entity => [`${entity.entityKind}:${entity.entityId}`, {
    coverage: assessment === "unknown" ? "unknown" : "recorded", assessment, reasons: assessment === "unknown" ? ["dependency_coverage_unknown"] : [],
    entityVersion: entity.expectedEntityVersion, dependencyVersion: assessment === "unknown" ? "bmdd1:initial" : dependencyVersion,
  }]));
}

describe("server-owned memory basis for model Wiki output", () => {
  it("keeps current registered content and replaces forged top-level or metadata authority", () => {
    const snapshot = wiki();
    const projected = projectInteractionWikiMemoryBasis(snapshot, summaries(snapshot));
    expect(projected.notes[0]).toMatchObject({ title: snapshot.notes[0].title, body: snapshot.notes[0].body,
      memoryBasis: { coverage: "recorded", assessment: "current", contentAvailable: true, verified: true, independentlyVerifiesCompleteness: false } });
    expect(projected.tasks[0]).toMatchObject({ title: snapshot.tasks[0].title, description: snapshot.tasks[0].description });
    expect(projected.notes[0].metadata).not.toHaveProperty("memoryBasis");
    expect(projected.tasks[0].metadata).not.toHaveProperty("memoryBasis");
    expect(projected.notes[0].memoryBasis).not.toHaveProperty("secret");
    expect(projected.memories).toBe(snapshot.memories);
  });
  it.each(["stale", "denied"] as const)("hides every derived fact for registered %s sources using an allowlist", assessment => {
    const snapshot = wiki();
    const projected = projectInteractionWikiMemoryBasis(snapshot, summaries(snapshot, assessment));
    for (const row of [...projected.notes, ...projected.tasks]) {
      expect(Object.keys(row).sort()).toEqual(["id", "memoryBasis", "status"]);
      expect(row.memoryBasis).toMatchObject({ coverage: "recorded", assessment, contentAvailable: false, verified: false });
      expect(JSON.stringify(row)).not.toContain("Sensitive");
      expect(JSON.stringify(row)).not.toContain("private-event");
      expect(JSON.stringify(row)).not.toContain("forged authority");
    }
    expect(projected.notes[0].status).toBe("active");
    expect(projected.tasks[0].status).toBe("candidate");
  });
  it("keeps explicit legacy unknown content with an unverified coverage declaration", () => {
    const snapshot = wiki();
    const projected = projectInteractionWikiMemoryBasis(snapshot, summaries(snapshot, "unknown"));
    expect(projected.notes[0]).toMatchObject({ body: snapshot.notes[0].body, memoryBasis: { coverage: "unknown", assessment: "unknown", verified: false } });
    expect(projected.tasks[0]).toMatchObject({ description: snapshot.tasks[0].description, memoryBasis: { dependencyVersion: "bmdd1:initial", independentlyVerifiesCompleteness: false } });
  });
  it("blocks missing summaries rather than inferring legacy unknown from matching content", () => {
    const snapshot = wiki();
    const projected = projectInteractionWikiMemoryBasis(snapshot, {});
    for (const row of [...projected.notes, ...projected.tasks]) expect(row).toMatchObject({ memoryBasis: { coverage: "unavailable", assessment: "unavailable", contentAvailable: false } });
    expect(projected.notes[0]).not.toHaveProperty("body");
    expect(projected.tasks[0]).not.toHaveProperty("description");
  });
  it.each([null, {}, { coverage: "unknown", assessment: "unknown" }, { coverage: "recorded", assessment: "current", reasons: [], entityVersion: null, dependencyVersion },
    { coverage: "unknown", assessment: "current", reasons: [], entityVersion: `bmde1:${"a".repeat(64)}`, dependencyVersion: "bmdd1:initial" },
    { coverage: "recorded", assessment: "current", reasons: [42], entityVersion: `bmde1:${"a".repeat(64)}`, dependencyVersion }])("blocks malformed summaries (%j)", malformed => {
    const snapshot = wiki();
    const projected = projectInteractionWikiMemoryBasis(snapshot, { [`wiki_note:${noteId}`]: malformed });
    expect(projected.notes[0].memoryBasis.assessment).toBe("unavailable");
    expect(projected.notes[0]).not.toHaveProperty("body");
    expect(projected.notes[0]).not.toHaveProperty("metadata");
  });
  it.each(["notes", "tasks"] as const)("hides the loaded %s content when a later backend version belongs to different content", field => {
    const snapshot = wiki();
    const later = wiki();
    if (field === "notes") later.notes[0].body = "Edited after Wiki load";
    else later.tasks[0].description = "Edited after Wiki load";
    const projected = projectInteractionWikiMemoryBasis(snapshot, summaries(later));
    expect(projected[field][0].memoryBasis).toMatchObject({ assessment: "stale", contentAvailable: false, reasons: ["entity_version_changed"] });
    expect(projected[field][0]).not.toHaveProperty(field === "notes" ? "body" : "description");
    expect(projected[field][0]).not.toHaveProperty("title");
  });
  it("keeps denied authoritative when the loaded content also changed", () => {
    const snapshot = wiki();
    const later = wiki(); later.notes[0].body = "Changed and denied";
    const projected = projectInteractionWikiMemoryBasis(snapshot, summaries(later, "denied"));
    expect(projected.notes[0].memoryBasis).toMatchObject({ assessment: "denied", contentAvailable: false, verified: false, reasons: ["entity_version_changed"] });
    expect(projected.notes[0]).not.toHaveProperty("body");
  });
  it("keeps an explicit denied summary with a hidden target version denied rather than trusted unknown", () => {
    const snapshot = wiki(); const exact = summaries(snapshot, "denied");
    exact[`wiki_note:${noteId}`].entityVersion = null;
    expect(projectInteractionWikiMemoryBasis(snapshot, exact).notes[0].memoryBasis).toMatchObject({ assessment: "denied", contentAvailable: false, entityVersion: null });
  });
  it("shares the exact row hash and does not create dependencies or mutate original rows", () => {
    const snapshot = wiki();
    const before = JSON.stringify(snapshot);
    const entities = getInteractionWikiMemoryEntities(snapshot);
    expect(entities).toEqual([
      { entityKind: "wiki_note", entityId: noteId, expectedEntityVersion: getMemoryDependencyEntityVersionFromRow("wiki_note", snapshot.notes[0]) },
      { entityKind: "interaction_task", entityId: taskId, expectedEntityVersion: getMemoryDependencyEntityVersionFromRow("interaction_task", snapshot.tasks[0]) },
    ]);
    projectInteractionWikiMemoryBasis(snapshot, summaries(snapshot));
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(snapshot.notes[0].metadata.memoryBasis).toBe(forged);
  });
  it("does not accept inherited summaries or copy unexpected summary payloads", () => {
    const snapshot = wiki();
    const exact = summaries(snapshot);
    const inherited = Object.create(exact) as Record<string, unknown>;
    expect(projectInteractionWikiMemoryBasis(snapshot, inherited).notes[0].memoryBasis.assessment).toBe("unavailable");
    const key = `wiki_note:${noteId}`;
    const withUnexpectedBody = { ...exact, [key]: { ...exact[key], body: "Injected summary body" } };
    expect(projectInteractionWikiMemoryBasis(snapshot, withUnexpectedBody).notes[0].memoryBasis).not.toHaveProperty("body");
  });
});
