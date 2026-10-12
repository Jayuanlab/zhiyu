/** The grounded protocol is one complete object, optionally in one JSON fence.
 * Parse the entire candidate; never scan for a recoverable prefix or suffix. */
export function parseGroundedResearchFinalJson(text: string): Record<string, unknown> | null {
  const candidate = text.trim();
  let body = candidate;
  if (candidate.startsWith('```')) {
    const opening = /^```json[\t ]*\r?\n/u.exec(candidate);
    const closing = /\r?\n```$/u.exec(candidate);
    if (!opening || !closing || closing.index < opening[0].length) return null;
    body = candidate.slice(opening[0].length, closing.index);
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
