import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

const sourceAliases = {
  loopRuns: "loopRuns", loop_runs: "loopRuns", workshopRuns: "workshopRuns", workshop_runs: "workshopRuns", loops: "loops",
  message: "message", Message_v2: "message", chat: "chat", Chat: "chat",
} as const;

export const PLATFORM_PUBLISHED_RECORD_FACT_KEYS = {
  loopRuns: ["id", "loopId", "status", "error", "startedAt", "completedAt", "createdAt"],
  workshopRuns: ["id", "workshopId", "status", "error", "startedAt", "completedAt", "createdAt"],
  loops: ["id", "workshopId", "name", "status", "createdAt", "updatedAt"],
  message: ["id", "chatId", "role", "createdAt"],
  chat: ["id", "title", "visibility", "createdAt"],
} as const;

export const PLATFORM_PUBLISHED_RECORD_FACT_KEYS_V2 = {
  // Identity first, then the declared run result, then recording timestamps.
  loopRuns: ["id", "loopId", "status", "error", "triggerReason", "outputSummary", "startedAt", "completedAt", "createdAt"],
  workshopRuns: ["id", "workshopId", "status", "error", "outputSummary", "startedAt", "completedAt", "createdAt"],
  loops: PLATFORM_PUBLISHED_RECORD_FACT_KEYS.loops,
  message: PLATFORM_PUBLISHED_RECORD_FACT_KEYS.message,
  chat: PLATFORM_PUBLISHED_RECORD_FACT_KEYS.chat,
} as const;

export type PlatformPublishedRecordFactsVersion = "platform-published-record-facts.v1" | "platform-published-record-facts.v2";
export type PlatformPublishedFactSource = keyof typeof PLATFORM_PUBLISHED_RECORD_FACT_KEYS;
export type PlatformPublishedFactFieldKey = (typeof PLATFORM_PUBLISHED_RECORD_FACT_KEYS_V2)[PlatformPublishedFactSource][number];
type Scalar = string | number | boolean | null;
export type PlatformPublishedFactJsonValue = Scalar | PlatformPublishedFactJsonValue[] | { [key: string]: PlatformPublishedFactJsonValue };
export type PlatformPublishedFieldFact =
  | { fieldKey: PlatformPublishedFactFieldKey; status: "read" | "not_recorded"; value: PlatformPublishedFactJsonValue; valueHash: string; complete: true }
  | { fieldKey: PlatformPublishedFactFieldKey; status: "not_present" | "invalid" | "field_too_large" | "withheld"; complete: false };
export type PlatformPublishedRecordFacts = {
  schemaVersion: PlatformPublishedRecordFactsVersion;
  source: string; id: string; parentContentHash: string;
  fields: PlatformPublishedFieldFact[];
  coverage: "fixed_whole_fields_only";
  rawRecordComplete: false;
};

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
export const PLATFORM_PUBLISHED_FACT_VALUE_MAX_UTF16 = 512;
export const PLATFORM_PUBLISHED_FACTS_MAX_UTF16 = 3000;
export const PLATFORM_PUBLISHED_FACT_WHOLE_VALUE_MAX_UTF16 = 8000;
export const PLATFORM_PUBLISHED_FACTS_V2_MAX_UTF16 = 4000;

/** Version-specific bounds are shared by the producer and receipt validator. */
export function platformPublishedRecordFactSchema(version: unknown) {
  if (version === "platform-published-record-facts.v1") return {
    schemaVersion: version, keys: PLATFORM_PUBLISHED_RECORD_FACT_KEYS,
    maxPacketUTF16: PLATFORM_PUBLISHED_FACTS_MAX_UTF16,
    identityValueMaxUTF16: PLATFORM_PUBLISHED_FACT_VALUE_MAX_UTF16,
    wholeValueMaxUTF16: PLATFORM_PUBLISHED_FACT_VALUE_MAX_UTF16,
  } as const;
  if (version === "platform-published-record-facts.v2") return {
    schemaVersion: version, keys: PLATFORM_PUBLISHED_RECORD_FACT_KEYS_V2,
    maxPacketUTF16: PLATFORM_PUBLISHED_FACTS_V2_MAX_UTF16,
    identityValueMaxUTF16: PLATFORM_PUBLISHED_FACT_VALUE_MAX_UTF16,
    wholeValueMaxUTF16: PLATFORM_PUBLISHED_FACT_WHOLE_VALUE_MAX_UTF16,
  } as const;
  return undefined;
}

/** A fixed alias map for evidence identity; it does not grant a tool source. */
export function platformPublishedRecordFactSource(source: string): PlatformPublishedFactSource | undefined {
  return Object.hasOwn(sourceAliases, source) ? sourceAliases[source as keyof typeof sourceAliases] : undefined;
}

function scalar(value: unknown): Scalar | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Match the normal JSON wire value of native timestamps, without invoking an
  // arbitrary object's toJSON or silently turning an invalid Date into null.
  if (typeof value === "object" && isProxy(value)) return undefined;
  if (value instanceof Date && Object.getPrototypeOf(value) === Date.prototype && !Object.hasOwn(value, "toJSON")) {
    if (Object.hasOwn(value, "valueOf") || Object.hasOwn(value, Symbol.toPrimitive)) return undefined;
    return Number.isFinite(Date.prototype.getTime.call(value)) ? Date.prototype.toISOString.call(value) : undefined;
  }
  return undefined;
}

type ValueValidation = { status: "valid"; value: PlatformPublishedFactJsonValue; encoded: string }
  | { status: "invalid" | "field_too_large" };

/** Copy strict JSON data without invoking accessors, toJSON or prototypes. */
function strictJson(value: unknown, maximum: number): ValueValidation {
  type Container = { [key: string]: PlatformPublishedFactJsonValue } | PlatformPublishedFactJsonValue[];
  type Frame = { value: unknown; target: Container; key: string } | { exit: object };
  const holder: Container = { value: null }, stack: Frame[] = [{ value, target: holder, key: "value" }];
  const active = new Set<object>();
  let characters = 0;
  try {
    while (stack.length) {
      const frame = stack.pop()!;
      if ("exit" in frame) { active.delete(frame.exit); continue; }
      const current = frame.value;
      if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") {
        if (typeof current === "number" && !Number.isFinite(current)) return { status: "invalid" };
        if (typeof current === "string" && current.length > maximum) return { status: "field_too_large" };
        const encoded = JSON.stringify(current);
        characters += encoded.length;
        if (characters > maximum) return { status: "field_too_large" };
        // JSON wire numbers normalize -0; retain the exact published JSON value.
        Object.defineProperty(frame.target, frame.key, { value: current === 0 ? 0 : current, writable: true, enumerable: true, configurable: true });
        continue;
      }
      if (typeof current !== "object" || isProxy(current) || active.has(current)) return { status: "invalid" };
      const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
      if (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null) return { status: "invalid" };
      const descriptors = Object.getOwnPropertyDescriptors(current), ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some(key => typeof key !== "string")) return { status: "invalid" };
      if (array && current.length > maximum) return { status: "field_too_large" };
      const keys = array ? Array.from({ length: current.length }, (_, index) => String(index)) : ownKeys as string[];
      if (array && (ownKeys.length !== keys.length + 1 || !Object.hasOwn(descriptors, "length"))) return { status: "invalid" };
      if (keys.some(key => { const descriptor = descriptors[key]; return !descriptor || !("value" in descriptor) || descriptor.enumerable !== true; })) return { status: "invalid" };
      characters += 2 + Math.max(0, keys.length - 1);
      if (!array) for (const key of keys) characters += JSON.stringify(key).length + 1;
      if (characters > maximum) return { status: "field_too_large" };
      const copied: Container = array ? Object.setPrototypeOf([], null) as PlatformPublishedFactJsonValue[] : Object.create(null) as { [key: string]: PlatformPublishedFactJsonValue };
      Object.defineProperty(frame.target, frame.key, { value: copied, writable: true, enumerable: true, configurable: true });
      active.add(current); stack.push({ exit: current });
      for (let index = keys.length - 1; index >= 0; index--) stack.push({ value: descriptors[keys[index]].value, target: copied, key: keys[index] });
    }
    const copied = (holder as { value: PlatformPublishedFactJsonValue }).value, encoded = JSON.stringify(copied);
    if (encoded.length > maximum) return { status: "field_too_large" };
    return { status: "valid", value: copied, encoded };
  } catch { return { status: "invalid" }; }
}

/** Fixed-source whole-value validation; this confers no permission or truth. */
export function validatePlatformPublishedFactValue(input: {
  schemaVersion: unknown; source: string; fieldKey: string; value: unknown;
}): ValueValidation {
  const specification = platformPublishedRecordFactSchema(input.schemaVersion), source = platformPublishedRecordFactSource(input.source);
  if (!specification || !source || !(specification.keys[source] as readonly string[]).includes(input.fieldKey)) return { status: "invalid" };
  if (specification.schemaVersion === "platform-published-record-facts.v2" && input.fieldKey === "triggerReason") return strictJson(input.value, specification.wholeValueMaxUTF16);
  if (specification.schemaVersion === "platform-published-record-facts.v2" && input.fieldKey === "outputSummary") {
    if (input.value !== null && typeof input.value !== "string") return { status: "invalid" };
    if (typeof input.value === "string" && input.value.length > specification.wholeValueMaxUTF16) return { status: "field_too_large" };
    const encoded = JSON.stringify(input.value);
    return encoded.length > specification.wholeValueMaxUTF16 ? { status: "field_too_large" } : { status: "valid", value: input.value, encoded };
  }
  const observed = scalar(input.value);
  if (observed === undefined || ((input.fieldKey === "id" || input.fieldKey.endsWith("Id")) && observed !== null && (typeof observed !== "string" || !uuid.test(observed)))) return { status: "invalid" };
  const encoded = JSON.stringify(observed);
  return encoded.length > specification.identityValueMaxUTF16 ? { status: "field_too_large" } : { status: "valid", value: observed, encoded };
}

function readValue(fields: Record<string, unknown>, key: PlatformPublishedFactFieldKey, source: string, schemaVersion: PlatformPublishedRecordFactsVersion): ValueValidation | { status: "not_present" } {
  const snake = key.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`);
  const camelPresent = Object.hasOwn(fields, key), snakePresent = snake !== key && Object.hasOwn(fields, snake);
  if (!camelPresent && !snakePresent) return { status: "not_present" };
  const descriptor = Object.getOwnPropertyDescriptor(fields, camelPresent ? key : snake);
  if (!descriptor || !("value" in descriptor)) return { status: "invalid" };
  const observed = validatePlatformPublishedFactValue({ schemaVersion, source, fieldKey: key, value: descriptor.value });
  if (observed.status !== "valid") return observed;
  if (camelPresent && snakePresent) {
    const otherDescriptor = Object.getOwnPropertyDescriptor(fields, snake);
    if (!otherDescriptor || !("value" in otherDescriptor)) return { status: "invalid" };
    const other = validatePlatformPublishedFactValue({ schemaVersion, source, fieldKey: key, value: otherDescriptor.value });
    if (other.status !== "valid" || observed.encoded !== other.encoded) return { status: "invalid" };
  }
  return observed;
}

/**
 * Construct only fixed whole values from the owner-checked published row.
 * The caller must bind this to a successful initial parent read. This pure
 * projection proves no owner permission, observation time, context emission,
 * claim truth or raw-record completeness on its own.
 */
export function platformPublishedRecordFacts(input: {
  source: string; id: string; parentContentHash: string; fields: Record<string, unknown>;
  schemaVersion?: PlatformPublishedRecordFactsVersion;
}): PlatformPublishedRecordFacts | undefined {
  const source = platformPublishedRecordFactSource(input.source), specification = platformPublishedRecordFactSchema(input.schemaVersion ?? "platform-published-record-facts.v2");
  if (!source || !specification || !uuid.test(input.id) || !hash.test(input.parentContentHash) || !input.fields || Array.isArray(input.fields) || isProxy(input.fields)) return undefined;
  const identity = readValue(input.fields, "id", input.source, specification.schemaVersion);
  if (identity.status !== "valid" || typeof identity.value !== "string" || identity.value.toLowerCase() !== input.id.toLowerCase()) return undefined;
  const result: PlatformPublishedRecordFacts = {
    schemaVersion: specification.schemaVersion, source: input.source, id: input.id,
    parentContentHash: input.parentContentHash, fields: [], coverage: "fixed_whole_fields_only", rawRecordComplete: false,
  };
  if (specification.schemaVersion === "platform-published-record-facts.v2" && (source === "loopRuns" || source === "workshopRuns")) {
    const candidates = specification.keys[source].map(fieldKey => ({ fieldKey,
      observed: readValue(input.fields, fieldKey, input.source, specification.schemaVersion) }));
    // Reserve every gap's envelope first. Identity, status and the recorded
    // error keep their original priority. Short whole timestamps then fit
    // before optional prose; no timestamp is inferred from another field.
    result.fields = candidates.map(({ fieldKey, observed }) => ({ fieldKey,
      status: observed.status === "valid" ? "withheld" : observed.status, complete: false }));
    const early = candidates.map(({ fieldKey, observed }, index) =>
      ["id", "loopId", "workshopId", "status", "error"].includes(fieldKey)
      || ["startedAt", "completedAt", "createdAt"].includes(fieldKey)
        && observed.status === "valid" && observed.encoded.length <= 64 ? index : -1).filter(index => index >= 0);
    const order = [...early, ...candidates.map((_, index) => index).filter(index => !early.includes(index))];
    for (const index of order) {
      const { fieldKey, observed } = candidates[index];
      if (observed.status !== "valid") continue;
      const gap = result.fields[index];
      result.fields[index] = { fieldKey, status: observed.value === null ? "not_recorded" : "read", value: observed.value,
        valueHash: createHash("sha256").update(observed.encoded).digest("hex"), complete: true };
      if (JSON.stringify(result).length > specification.maxPacketUTF16) result.fields[index] = gap;
    }
    return result;
  }
  for (const fieldKey of specification.keys[source]) {
    const observed = readValue(input.fields, fieldKey, input.source, specification.schemaVersion);
    if (observed.status !== "valid") { result.fields.push({ fieldKey, status: observed.status, complete: false }); continue; }
    const fact: PlatformPublishedFieldFact = {
      fieldKey, status: observed.value === null ? "not_recorded" : "read", value: observed.value,
      valueHash: createHash("sha256").update(observed.encoded).digest("hex"), complete: true,
    };
    result.fields.push(fact);
    if (JSON.stringify(result).length > specification.maxPacketUTF16) result.fields[result.fields.length - 1] = { fieldKey, status: "withheld", complete: false };
  }
  // Later gap entries also use space. Recheck the entire finished packet rather
  // than assuming a per-field limit guarantees its serialized envelope fits.
  for (let index = result.fields.length - 1; JSON.stringify(result).length > specification.maxPacketUTF16 && index >= 0; index--) {
    if (result.fields[index].complete) result.fields[index] = { fieldKey: result.fields[index].fieldKey, status: "withheld", complete: false };
  }
  return result;
}
