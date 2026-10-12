/** Group page windows by the actual source/version, preserving other event groups. */
export function workshopEvidenceGroupKey(event: {
  id: string; type: string; title: string; metadata?: Record<string, unknown> | null;
}, toolName: string | null) {
  if (event.type === 'source_checked' && toolName === 'webReadPage') {
    const url = typeof event.metadata?.url === 'string' ? event.metadata.url : event.id;
    const evidenceId = typeof event.metadata?.evidenceId === 'string' ? event.metadata.evidenceId : '';
    return JSON.stringify(['source_checked', 'webReadPage', url, evidenceId]);
  }
  return `${event.type}:${toolName ?? event.title}`;
}
