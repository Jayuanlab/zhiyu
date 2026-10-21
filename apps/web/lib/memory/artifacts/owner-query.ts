import { memoryInvalid } from "../kernel/errors";
import { readArtifact, readArtifactCurrent } from "./service";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) memoryInvalid("An artifact query object is required");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) memoryInvalid("Unexpected artifact query field");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) memoryInvalid("Invalid artifact reference");
  return value.toLowerCase();
}

/** Binary evidence has explicit byte windows and encoding. It must never be
 * serialized as a Buffer object or presented as decoded/verified document text. */
export async function readOwnerArtifact(userId: string, input: unknown) {
  const query = object(input); only(query, ["purpose", "ref", "range"]);
  if (query.purpose === "current") {
    if (query.range !== undefined) memoryInvalid("Current artifact reads do not accept a window");
    const ref = object(query.ref); only(ref, ["kind", "id"]);
    if (ref.kind !== "artifact") memoryInvalid("Invalid artifact reference kind");
    return readArtifactCurrent(userId, { artifactId: id(ref.id) });
  }
  if (query.purpose !== "evidence") memoryInvalid("Invalid artifact read purpose");
  const fixed = object(query.ref); only(fixed, ["record", "revision"]);
  const record = object(fixed.record); only(record, ["kind", "id"]);
  if (record.kind !== "artifact") memoryInvalid("Invalid artifact reference kind");
  const artifactId = id(record.id);
  if (typeof fixed.revision !== "string" || !new RegExp(`^artifact:${artifactId}:[0-9]+:[a-f0-9]{64}$`, "i").test(fixed.revision)) memoryInvalid("A fixed artifact version is required");
  const window = object(query.range); only(window, ["start", "end"]);
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || Number(window.start) < 0
    || Number(window.end) < Number(window.start) || Number(window.end) - Number(window.start) > 65536) memoryInvalid("Artifact windows are limited to 65536 bytes");
  const result = await readArtifact(userId, { artifactId, revision: fixed.revision, range: { start: window.start, end: window.end } });
  if (result.status !== "ok") return result;
  const { bytes, ...metadata } = result;
  return { ...metadata, encoding: "base64" as const, content: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength };
}
