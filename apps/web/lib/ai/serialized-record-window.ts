import { isProxy } from "node:util/types";

/** Bound the actual first recordRead JSON envelope, rather than its raw excerpt.
 * Facts and authority handles are preserved; only the explicitly partial raw
 * source prefix can shrink. This helper performs no read or authorization. */
export const SERIALIZED_RECORD_WINDOW_CHARACTERS = 8000;
type JsonRecord = Record<string, any>;

function detached(value: unknown, ancestors = new Set<object>(), depth = 0, counter = { nodes: 0 }): any {
  if (++counter.nodes > 100000 || depth > 64) throw Error("record_read_envelope_not_plain");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw Error("record_read_envelope_not_plain");
  if (isProxy(value)) throw Error("record_read_envelope_not_plain");
  if (ancestors.has(value)) throw Error("record_read_envelope_not_plain");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw Error("record_read_envelope_not_plain");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: any = Array.isArray(value) ? [] : {};
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) throw Error("record_read_envelope_not_plain");
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      // Never invoke accessors, toJSON, or a self-replacing metadata getter.
      if (!Object.hasOwn(descriptor, "value") || key === "toJSON") throw Error("record_read_envelope_not_plain");
      if (!descriptor.enumerable) continue;
      Object.defineProperty(result, key, { value: detached(descriptor.value, ancestors, depth + 1, counter), enumerable: true, configurable: true, writable: true });
    }
  } finally { ancestors.delete(value); }
  return result;
}
function splitPair(text: string, end: number) {
  return end > 0 && end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff;
}
/** Only host envelope handles are inspected; source fields/text are never actions. */
export function hasPlatformFieldPageReadAction(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (isProxy(result)) throw Error("record_read_envelope_not_plain");
  if (Array.isArray(result)) return false;
  const root = Object.getOwnPropertyDescriptors(result), page = root.recordRead;
  if (root.ok?.value === false || root.isError?.value === true || !page || !Object.hasOwn(page, "value") || !page.value || typeof page.value !== "object") return false;
  if (isProxy(page.value)) throw Error("record_read_envelope_not_plain");
  const metadata = Object.getOwnPropertyDescriptors(page.value);
  if (metadata.status?.value !== "read" || metadata.offset?.value !== 0) return false;
  const handles = metadata.readHandles;
  if (!handles || !Object.hasOwn(handles, "value") || !handles.value || typeof handles.value !== "object") return false;
  if (isProxy(handles.value)) throw Error("record_read_envelope_not_plain");
  if (!Array.isArray(handles.value)) return false;
  const array = Object.getOwnPropertyDescriptors(handles.value);
  for (let index = 0; index < handles.value.length; index++) {
    const entry = array[String(index)];
    if (!entry || !Object.hasOwn(entry, "value") || !entry.value || typeof entry.value !== "object") continue;
    if (isProxy(entry.value)) throw Error("record_read_envelope_not_plain");
    const handle = Object.getOwnPropertyDescriptors(entry.value), token = handle.readHandle?.value;
    if (typeof token !== "string" || !/^pfr_[A-Za-z0-9_-]{32}$/u.test(token)) continue;
    const next = handle.nextRead;
    if (!next || !Object.hasOwn(next, "value") || !next.value || typeof next.value !== "object") continue;
    if (isProxy(next.value)) throw Error("record_read_envelope_not_plain");
    const action = Object.getOwnPropertyDescriptors(next.value);
    if (Object.keys(action).length !== 1 || !action.fieldPage || !Object.hasOwn(action.fieldPage, "value") || !action.fieldPage.value || typeof action.fieldPage.value !== "object") continue;
    if (isProxy(action.fieldPage.value)) throw Error("record_read_envelope_not_plain");
    const pageAction = Object.getOwnPropertyDescriptors(action.fieldPage.value);
    if (Object.keys(pageAction).length === 1 && Object.hasOwn(pageAction.readHandle ?? {}, "value") && pageAction.readHandle.value === token) return true;
  }
  return false;
}
type EnvelopeFit = { maximumCharacters?: number; fitsModelText?: (text: string, result?: unknown) => boolean };
function eligible(page: JsonRecord | undefined, outer: boolean) {
  return page && page.status === "read" && (outer ? Number.isSafeInteger(page.offset) && page.offset >= 0 && page.truncated === true && page.nextOffset !== null : page.offset === 0) && typeof page.source === "string" && typeof page.id === "string"
    && typeof page.contentHash === "string" && /^[a-f0-9]{64}$/u.test(page.contentHash)
    && typeof page.content === "string" && page.content.length > 0 && page.content.length <= 8000
    && Number.isSafeInteger(page.totalCharacters) && page.totalCharacters >= page.offset + page.content.length
    && (page.offset + page.content.length === page.totalCharacters ? page.nextOffset === null : page.nextOffset === page.offset + page.content.length);
}
function boundedEnvelope(wire: JsonRecord, options: EnvelopeFit): { wire: JsonRecord; page: JsonRecord; changed: boolean } {
  const page = wire.recordRead ?? wire;
  const maximum = options.maximumCharacters ?? SERIALIZED_RECORD_WINDOW_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 24000) throw Error("record_read_invalid_envelope_limit");
  const fits = () => { const text = JSON.stringify(wire); return text.length <= maximum && (!options.fitsModelText || options.fitsModelText(text) === true); };
  if (fits()) return { wire, page, changed: false };
  if (!eligible(page, !!options.fitsModelText)) {
    if (options.fitsModelText) throw Error("record_read_metadata_exceeds_window_budget");
    return { wire, page, changed: false };
  }
  const original = page.content as string;
  const apply = (requested: number) => {
    let end = requested;
    if (splitPair(original, end)) end--;
    page.content = original.slice(0, end);
    page.nextOffset = page.offset + end;
    page.truncated = true;
    if (Object.hasOwn(page, "fieldReadCoverage")) page.fieldReadCoverage = "character_window";
    if (page.fieldAvailability && typeof page.fieldAvailability === "object" && !Array.isArray(page.fieldAvailability))
      page.fieldAvailability = Object.fromEntries(Object.entries(page.fieldAvailability).map(([key, status]) => [key, status === "shown" ? "present_unread" : status]));
    if (page.publishedFacts && Object.hasOwn(page.publishedFacts, "rawRecordComplete")) page.publishedFacts.rawRecordComplete = false;
    page.serializedWindow = { schemaVersion: "serialized-record-window.v1", maximumCharacters: maximum,
      originalWindowCharacters: original.length, rawCharacters: end, characterUnit: "javascript_utf16" };
    wire.completionGate = { ...wire.completionGate, status: "record_read_continuation_required",
      nextRead: { source: page.source, id: page.id, offset: page.nextOffset, expectedHash: page.contentHash },
      instruction: "The raw record prefix is partial. Use this exact nextRead to continue the same source version, or the published field read handles for the required fields. Complete scalar facts remain independent of the raw prefix; unread fields remain unknown." };
    return end;
  };
  let low = 1, high = original.length, best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), end = apply(middle);
    if (end > 0 && fits()) { best = end; low = middle + 1; }
    else high = middle - 1;
  }
  if (!best) throw Error("record_read_metadata_exceeds_window_budget");
  apply(best);
  if (!fits() || !page.content.length) throw Error("record_read_metadata_exceeds_window_budget");
  return { wire, page, changed: true };
}

/** Call after handle decoration and before budget/constructed-result observation.
 * Native text and the frozen single-page serializer are different wire shapes. */
export function reducePlatformRecordReadResult<T>(result: T, shape: "native_text" | "single_page", options: EnvelopeFit = {}): T {
  if (!result || typeof result !== "object") return result;
  if (isProxy(result)) throw Error("record_read_envelope_not_plain");
  if (Array.isArray(result)) return result;
  const descriptors = Object.getOwnPropertyDescriptors(result);
  if (descriptors.ok?.value === false || descriptors.isError?.value === true || !descriptors.recordRead) return result;
  if (!Object.hasOwn(descriptors.recordRead, "value")) throw Error("record_read_envelope_not_plain");
  if (descriptors.recordRead.value && typeof descriptors.recordRead.value === "object" && isProxy(descriptors.recordRead.value)) throw Error("record_read_envelope_not_plain");
  const pageDescriptors = Object.getOwnPropertyDescriptors(descriptors.recordRead.value ?? {});
  if (["status", "offset"].some(key => pageDescriptors[key] && !Object.hasOwn(pageDescriptors[key], "value"))) throw Error("record_read_envelope_not_plain");
  // Continuation, unsupported status, and permission-denied branches are untouched.
  if (pageDescriptors.status?.value !== "read" || !options.fitsModelText && pageDescriptors.offset?.value !== 0) return result;
  const copy = detached(result) as JsonRecord;
  let wire: JsonRecord;
  if (shape === "native_text") {
    if (typeof copy.text !== "string") throw Error("record_read_envelope_not_plain");
    try { wire = JSON.parse(copy.text); } catch { throw Error("record_read_envelope_not_plain"); }
  } else {
    const { data: _data, text: _text, ...single } = copy;
    wire = single;
  }
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) throw Error("record_read_envelope_not_bound");
  const wirePage = wire.recordRead ?? wire;
  if (["status", "source", "id", "contentHash", "offset", "nextOffset", "totalCharacters", "content"].some(key => wirePage[key] !== copy.recordRead[key]))
    throw Error("record_read_envelope_not_bound");
  const bindCandidate = (text: string) => {
    copy.recordRead = wire.recordRead ?? wire;
    if (copy.data && typeof copy.data === "object") copy.data.recordRead = copy.recordRead;
    copy.completionGate = wire.completionGate;
    if (shape === "native_text") copy.text = text;
    else for (const [key, value] of Object.entries(wire)) copy[key] = value;
    return options.fitsModelText!(text, copy);
  };
  const reduced = boundedEnvelope(wire, { ...options, ...(options.fitsModelText ? { fitsModelText: bindCandidate } : {}) });
  if (!reduced.changed) return result;
  copy.recordRead = reduced.page;
  if (copy.data && typeof copy.data === "object") copy.data.recordRead = reduced.page;
  copy.completionGate = reduced.wire.completionGate;
  if (shape === "native_text") copy.text = JSON.stringify(reduced.wire);
  else {
    for (const [key, value] of Object.entries(reduced.wire)) copy[key] = value;
  }
  return copy as T;
}
