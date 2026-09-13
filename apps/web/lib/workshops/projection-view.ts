type ProjectionView = {
  status: string;
  counts: unknown;
  projection?: { asOf: string };
  nextWork?: unknown;
  contextCost?: unknown;
  recentFinding?: unknown;
  latestEvent?: unknown;
  latestConclusion?: unknown;
};

export function isOlderProjection(current: ProjectionView | null, incoming: ProjectionView) {
  const currentTime = Date.parse(current?.projection?.asOf ?? "");
  const nextTime = Date.parse(incoming.projection?.asOf ?? "");
  return Number.isFinite(currentTime) && (!Number.isFinite(nextTime) || nextTime < currentTime);
}

/** Update aggregate facts without replacing lazily loaded detail lists. */
export function mergeDashboardSummary<T extends ProjectionView>(current: T | null, incoming: T | null): T | null {
  if (!incoming || isOlderProjection(current, incoming)) return current;
  if (!current) return incoming;
  return { ...current, status: incoming.status, counts: incoming.counts,
    projection: incoming.projection, nextWork: incoming.nextWork, contextCost: incoming.contextCost,
    recentFinding: incoming.recentFinding, latestEvent: incoming.latestEvent,
    latestConclusion: incoming.latestConclusion };
}
