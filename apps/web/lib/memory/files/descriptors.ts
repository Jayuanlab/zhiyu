/** A configured file source is a locator, never evidence that its cached body
 * is still authorized or equal to the immutable managed object. */
export function fileSourceDescriptors<T extends { id: string; type: string; content?: string | null; uri?: string | null }>(sources: T[]): T[] {
  return sources.map(source => source.type === 'file' ? { ...source, content: null, uri: `source:${source.id}` } : source);
}
