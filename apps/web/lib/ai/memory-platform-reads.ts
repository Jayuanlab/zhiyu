import { isProxy } from "node:util/types";

/** Pure routing syntax. It never looks at retrieved record content or grants authority. */
export type MemoryRecordRead = { kind: "platform_record"; source: string; id: string; offset?: number; expectedHash?: string };
export type MemoryFieldPageRead = { kind: "platform_field_page"; fieldPage: { readHandle: string; cursor?: string } };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || isProxy(value)) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
/** The final guarded tool schema is the namespace; no additional SQL/table aliases are accepted. */
export function memoryPlatformRecordSources(schema: unknown): string[] {
  const names = own(own(own(own(own(schema, "properties"), "recordRead"), "properties"), "source"), "enum");
  if (!Array.isArray(names) || isProxy(names) || names.length > 128) return [];
  const result: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = own(names, String(i));
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(name)) return [];
    result.push(name);
  }
  return [...new Set(result)];
}
/** Closed single-record commands only. Free-form compound questions remain on the old route. */
export function closedMemoryRecordSubject(question: unknown, sources: readonly string[]): { source: string; id: string } | undefined {
  if (typeof question !== "string" || question.length > 4000) return undefined;
  const idPattern = "([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})";
  const match = question.trim().match(new RegExp("^(?:read|show|inspect|fetch|get)\\s+([A-Za-z][A-Za-z0-9_]*)\\s+(?:record|row)\\s+" + idPattern + "[.!?]?$", "iu"))
    ?? question.trim().match(new RegExp("^(?:读取|查看|查询)\\s*([A-Za-z][A-Za-z0-9_]*)\\s*(?:的)?(?:记录|行)\\s*" + idPattern + "[。！？]?$", "u"));
  if (!match || !uuid.test(match[2])) return undefined;
  // Do not invent camel/snake SQL aliases or infer a table from a UUID.
  if (!sources.includes(match[1])) return undefined;
  return { source: match[1], id: match[2] };
}
/** JSON-safe shallow copy refuses accessors rather than executing them while choosing a read route. */
export function memoryReadData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) throw Error("Invalid evidence read request");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw Error("Invalid evidence read request");
  const descriptors = Object.getOwnPropertyDescriptors(value), output: Record<string, unknown> = {};
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) throw Error("Invalid evidence read request");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) throw Error("Invalid evidence read request");
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true });
  }
  return output;
}
export function validateMemoryPlatformRead(read: Record<string, unknown>, sources: readonly string[]) {
  if (read.kind === "platform_record") {
    if (Object.keys(read).some(key => !["kind", "source", "id", "offset", "expectedHash"].includes(key))
      || typeof read.source !== "string" || !sources.includes(read.source) || typeof read.id !== "string" || !uuid.test(read.id)
      || read.offset !== undefined && (!Number.isSafeInteger(read.offset) || (read.offset as number) < 0)
      || read.expectedHash !== undefined && (typeof read.expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(read.expectedHash))) throw Error("Invalid exact record read request");
    return read;
  }
  if (read.kind === "platform_field_page") {
    if (Object.keys(read).some(key => !["kind", "fieldPage"].includes(key))) throw Error("Invalid field page read request");
    const page = memoryReadData(read.fieldPage);
    if (Object.keys(page).some(key => !["readHandle", "cursor"].includes(key)) || typeof page.readHandle !== "string" || !/^pfr_[A-Za-z0-9_-]{32}$/u.test(page.readHandle)
      || page.cursor !== undefined && (typeof page.cursor !== "string" || !/^pfp_[A-Za-z0-9_-]{32}$/u.test(page.cursor))) throw Error("Invalid field page read request");
    return { kind: read.kind, fieldPage: page };
  }
  return read;
}
