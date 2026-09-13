import { createHash } from "node:crypto";

export type CommandJson = null | boolean | number | string | CommandJson[] | { [key: string]: CommandJson };

/** Reject lossy JS values instead of silently aliasing different commands. */
export function canonicalCommandJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("Command requires acyclic JSON values");
    ancestors.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new Error("Command cannot contain symbol keys");
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new Error("Command requires a dense JSON array");
        return `[${Array.from(item, encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Command requires plain JSON objects");
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}

export function commandPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalCommandJson(value), "utf8").digest("hex");
}
