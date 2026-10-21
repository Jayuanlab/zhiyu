import { MemoryModuleError } from "../kernel/errors";
import { MAX_ARTIFACT_BYTES } from "./contracts";
import { getAuthMode, requestBoundary } from "@/lib/auth/request-boundary";
export function artifactHttpError(error: unknown) {
  if (error instanceof SyntaxError) return Response.json({ error: "A valid JSON file request is required", code: "invalid_memory_request" }, { status: 400 });
  return error instanceof MemoryModuleError ? Response.json({ error: error.message, code: error.code }, { status: error.status })
    : Response.json({ error: "Private file operation could not be completed", code: "artifact_unavailable" }, { status: 503 });
}
export function requireArtifactSameOrigin(request: Request) {
  if (requestBoundary(request, getAuthMode()))
    throw new MemoryModuleError("memory_access_denied", 403, "File mutations require a same-origin owner request");
}
export async function artifactMultipart(request: Request): Promise<FormData> {
  const maximum = MAX_ARTIFACT_BYTES + 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maximum) throw new MemoryModuleError("artifact_request_too_large", 413, "Upload exceeds the transport limit");
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new MemoryModuleError("invalid_memory_request", 400, "A multipart file upload is required");
  const reader = request.body?.getReader(); if (!reader) throw new MemoryModuleError("invalid_memory_request", 400, "An upload body is required");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maximum) { await reader.cancel().catch(() => undefined); throw new MemoryModuleError("artifact_request_too_large", 413, "Upload exceeds the transport limit"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return await new Response(data, { headers: { "Content-Type": type } }).formData(); }
  catch { throw new MemoryModuleError("invalid_memory_request", 400, "Invalid multipart upload"); }
}
/** Only an app-managed ID or relative app URL is accepted; this never fetches a URL. */
export function artifactIdFromReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.replace(/^artifact:/, "");
  const match = /^\/api\/files\/([a-f0-9-]{36})(?:\?[^#]*)?$/.exec(value);
  const id = match?.[1] ?? raw;
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : null;
}
export function exactArtifactReference(values: unknown[]): string {
  const supplied = values.filter(value => value !== undefined && value !== null);
  const ids = supplied.map(artifactIdFromReference);
  const first = ids[0];
  if (!first || ids.some(id => !id)) throw new MemoryModuleError("artifact_legacy_uncontrolled", 410, "This source has no private manifest; arbitrary URLs and raw paths are not read");
  if (ids.some(id => id !== ids[0])) throw new MemoryModuleError("invalid_memory_request", 400, "Conflicting file references must be resolved explicitly");
  return first;
}
export function artifactHttpRange(header: string | null, total: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new MemoryModuleError("artifact_range_invalid", 416, "A single valid byte range is required");
  const left = match[1] ? Number(match[1]) : undefined, right = match[2] ? Number(match[2]) : undefined;
  if (left !== undefined && !Number.isSafeInteger(left) || right !== undefined && !Number.isSafeInteger(right))
    throw new MemoryModuleError("artifact_range_invalid", 416, "Byte range exceeds the safe integer limit");
  const start = left ?? Math.max(0, total - (right ?? 0)), end = left === undefined ? total : Math.min(total, right === undefined ? total : right + 1);
  if (start >= total || start < 0 || end <= start || left === undefined && right === 0) throw new MemoryModuleError("artifact_range_invalid", 416, "Byte range is outside the file");
  return { start, end };
}
