import { getMemoryDependencyEntityVersionFromRow, type MemoryDependencyEntityRow } from "@/lib/brain/memory-dependencies-entity-version";
import type { InteractionWikiSnapshot } from "./service";

type WikiRows = Pick<InteractionWikiSnapshot, "notes" | "tasks">;
type WikiEntityKind = "wiki_note" | "interaction_task";
type Row = MemoryDependencyEntityRow & Record<string, any>;
type Summary = {
  coverage: "unknown" | "recorded";
  assessment: "unknown" | "current" | "stale" | "denied";
  reasons: string[];
  entityVersion: string | null;
  dependencyVersion: string;
};
export type InteractionWikiMemoryBasis = {
  coverage: "unknown" | "recorded" | "unavailable";
  assessment: "unknown" | "current" | "stale" | "denied" | "unavailable";
  reasons: string[];
  entityVersion: string | null;
  dependencyVersion: string | null;
  contentAvailable: boolean;
  independentlyVerifiesCompleteness: false;
  verified: boolean;
};

const entityVersion = /^bmde1:[a-f0-9]{64}$/;
const dependencyVersion = /^bmdd1:(?:initial|[a-f0-9]{64})$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function parseSummary(value: unknown): Summary | null {
  if (!object(value) || typeof value.coverage !== "string" || !["unknown", "recorded"].includes(value.coverage) ||
      typeof value.assessment !== "string" || !["unknown", "current", "stale", "denied"].includes(value.assessment) ||
      !(typeof value.entityVersion === "string" && entityVersion.test(value.entityVersion) || value.entityVersion === null && value.assessment === "denied") ||
      typeof value.dependencyVersion !== "string" || !dependencyVersion.test(value.dependencyVersion) ||
      !Array.isArray(value.reasons) || value.reasons.some(reason => typeof reason !== "string") ||
      value.coverage === "unknown" && (value.assessment === "current" || value.dependencyVersion !== "bmdd1:initial") ||
      value.coverage === "recorded" && (value.assessment === "unknown" || value.dependencyVersion === "bmdd1:initial")) return null;
  return { coverage: value.coverage as Summary["coverage"], assessment: value.assessment as Summary["assessment"],
    reasons: [...value.reasons], entityVersion: value.entityVersion, dependencyVersion: value.dependencyVersion };
}

function unavailableBasis(): InteractionWikiMemoryBasis {
  return { coverage: "unavailable", assessment: "unavailable", reasons: ["dependency_summary_unavailable"],
    entityVersion: null, dependencyVersion: null, contentAvailable: false, independentlyVerifiesCompleteness: false, verified: false };
}

function projectRow(kind: WikiEntityKind, row: Row, summaries: Readonly<Record<string, unknown>>): Record<string, unknown> & { id: string; memoryBasis: InteractionWikiMemoryBasis } {
  const key = `${kind}:${row.id}`;
  const summary = Object.hasOwn(summaries, key) ? parseSummary(summaries[key]) : null;
  let memoryBasis = unavailableBasis();
  if (summary) {
    let version: string | null = null;
    try { version = getMemoryDependencyEntityVersionFromRow(kind, row); } catch { /* An incomplete row is unavailable, never legacy unknown. */ }
    if (version || summary.assessment === "denied") {
      const changed = !!version && summary.entityVersion !== null && version !== summary.entityVersion;
      const assessment = summary.assessment === "denied" ? "denied" : changed ? "stale" : summary.assessment;
      memoryBasis = { coverage: summary.coverage, assessment,
        reasons: changed ? [...new Set([...summary.reasons, "entity_version_changed"])] : [...summary.reasons],
        entityVersion: summary.entityVersion, dependencyVersion: summary.dependencyVersion,
        contentAvailable: assessment === "current" || summary.coverage === "unknown" && assessment === "unknown",
        independentlyVerifiesCompleteness: false, verified: summary.coverage === "recorded" && assessment === "current" && !changed };
    }
  }
  if (!memoryBasis.contentAvailable) {
    const metadata = object(row.metadata) ? row.metadata : {};
    const status = kind === "interaction_task" ? row.status : typeof metadata.deletedAt === "string" || metadata.status === "deleted" ? "deleted" : "active";
    // An allowlist prevents facts being copied from a title, metadata, assignee or other derived fields.
    return { id: row.id, status, memoryBasis };
  }
  const metadata = object(row.metadata) ? { ...row.metadata } : {};
  delete metadata.memoryBasis;
  return { ...row, metadata, memoryBasis };
}

/** Server-owned version assessments replace any row/metadata claim. No inference, writes or automatic registration. */
export function projectInteractionWikiMemoryBasis<T extends WikiRows>(wiki: T, summaries: Readonly<Record<string, unknown>>) {
  return { ...wiki,
    notes: wiki.notes.map(note => projectRow("wiki_note", note as Row, summaries)),
    tasks: wiki.tasks.map(task => projectRow("interaction_task", task as Row, summaries)),
  };
}

export function getInteractionWikiMemoryEntities(wiki: WikiRows) {
  return [
    ...wiki.notes.map(note => ({ entityKind: "wiki_note" as const, entityId: note.id, expectedEntityVersion: getMemoryDependencyEntityVersionFromRow("wiki_note", note) })),
    ...wiki.tasks.map(task => ({ entityKind: "interaction_task" as const, entityId: task.id, expectedEntityVersion: getMemoryDependencyEntityVersionFromRow("interaction_task", task) })),
  ];
}
