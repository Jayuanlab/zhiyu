import type { EvidenceRootGroup, ResolvedEvidenceIdentity } from './types';
export type { EvidenceRootGroup, ResolvedEvidenceIdentity } from './types';

type EvidenceForGrouping = {
  id: string; status: "resolved" | "unresolved"; source: string;
  resolvedIdentity?: ResolvedEvidenceIdentity;
};

/** Groups only already authorized reader results. It never reads a missing target,
 * infers provenance from equal text, or establishes evidence independence/truth. */
export function groupResolvedEvidenceRoots(evidence: readonly EvidenceForGrouping[]) {
  const resolved = evidence.filter(item => item.status === "resolved");
  const key = (source: string, id: string) => JSON.stringify([source, id]);
  const eventsById = new Map<string, Set<string>>();
  for (const item of resolved) {
    const identity = item.resolvedIdentity;
    if (identity && ["interaction_event", "workshop_event"].includes(identity.source)) {
      const matches = eventsById.get(identity.sourceId) ?? new Set<string>();
      matches.add(key(identity.source, identity.sourceId)); eventsById.set(identity.sourceId, matches);
    }
  }
  const groups = new Map<string, EvidenceRootGroup>();
  let unresolvedSourceLinks = 0;
  for (const item of resolved) {
    const identity = item.resolvedIdentity;
    let source = identity?.source ?? item.source;
    let sourceId = identity?.sourceId ?? item.id;
    let rootKey = key(source, sourceId);
    if (identity?.source === "brain_observation" && identity.sourceEventId) {
      const targets = eventsById.get(identity.sourceEventId);
      if (targets?.size === 1) {
        rootKey = [...targets][0]; [source, sourceId] = JSON.parse(rootKey);
      } else unresolvedSourceLinks++;
    }
    const group = groups.get(rootKey) ?? { rootKey, source, sourceId, refs: [] };
    if (!group.refs.includes(item.id)) group.refs.push(item.id);
    groups.set(rootKey, group);
  }
  const grouped = [...groups.values()].map(group => ({ ...group, refs: group.refs.sort() })).sort((a, b) => a.rootKey.localeCompare(b.rootKey));
  return { groups: grouped, resolvedRootGroups: grouped.length,
    overlappingResolvedRefs: resolved.length - grouped.length, unresolvedSourceLinks,
    semantics: "resolved_source_groups_not_independent_evidence" as const };
}
