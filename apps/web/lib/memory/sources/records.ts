import { createHash } from "node:crypto";
import { stableJson } from "../records/observations";
import type { MemorySourceKind } from "./catalog";

export function sourceValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sourceValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sourceValue(child)]));
  return value ?? null;
}
export function sourceRevision(source: MemorySourceKind, row: Record<string, unknown>, authority: unknown): string {
  return `msrc1:${createHash("sha256").update(stableJson(sourceValue({ source, row, authority }))).digest("hex")}`;
}
export function matchesSourceProjection(row: Record<string, unknown>, projection: unknown): boolean {
  return Boolean(projection && typeof projection === "object" && !Array.isArray(projection)
    && Object.entries(projection).length
    && Object.entries(projection).every(([key, value]) => Object.hasOwn(row, key)
      && stableJson(sourceValue(value)) === stableJson(sourceValue(row[key]))));
}
