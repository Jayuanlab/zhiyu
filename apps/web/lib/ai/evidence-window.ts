import { createHash } from "node:crypto";

/** A stable character window over retrieved text. A changed version must be restarted. */
export function evidenceWindow(content: string, offset = 0, expectedHash?: string) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid evidence offset");
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (expectedHash && expectedHash !== contentHash) return {
    status: "version_changed" as const, contentHash, content: "", nextOffset: null,
    warning: "Source changed between reads. Restart at offset 0; do not combine different versions.",
  };
  if (offset > content.length) throw Error("Evidence offset exceeds source length");
  const end = Math.min(content.length, offset + 8000);
  return { status: "read" as const, contentHash, offset, nextOffset: end < content.length ? end : null,
    totalCharacters: content.length, content: content.slice(offset, end),
    truncated: offset > 0 || end < content.length,
    warning: "Offsets use JavaScript UTF-16 code units. Read time is not fact validity time. A source excerpt does not prove the question is answered.",
  };
}
