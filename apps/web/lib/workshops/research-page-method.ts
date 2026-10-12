/** A method label never proves coverage. Callers still verify runtime authority,
 * ownership, saved body identity, quality and contiguous window receipts. */
export function isSavedResearchPageMethod(metadata: Record<string, unknown>): boolean {
  if (metadata.method === "jina_defuddle") return true;
  return metadata.method === "direct_defuddle" && metadata.provider === "direct_http" &&
    typeof metadata.cleaner === "string" && /^defuddle-\d+\.\d+\.\d+\/zhiyu-\d+$/.test(metadata.cleaner);
}
