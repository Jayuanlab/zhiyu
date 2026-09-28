export type JsonObjectSpan = {
  value: Record<string, unknown>;
  start: number;
  end: number;
};

type ScanResult = { span: JsonObjectSpan | null; next: number; incomplete: boolean };

function scanObjectAt(text: string, start: number): ScanResult {
  const closing = ["}"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      closing.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (closing.pop() !== char) return { span: null, next: index + 1, incomplete: false };
      if (closing.length === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, index + 1));
          if (value && typeof value === "object" && !Array.isArray(value)) {
            return { span: { value: value as Record<string, unknown>, start, end: index + 1 }, next: index + 1, incomplete: false };
          }
        } catch {
          // The whole candidate is invalid; its nested objects are not replacements.
        }
        return { span: null, next: index + 1, incomplete: false };
      }
    }
  }
  return { span: null, next: text.length, incomplete: true };
}

function firstTopLevelObject(text: string): JsonObjectSpan | null {
  for (let start = text.indexOf("{"); start >= 0;) {
    const scan = scanObjectAt(text, start);
    if (scan.span) return scan.span;
    if (scan.incomplete) return null;
    start = text.indexOf("{", scan.next);
  }
  return null;
}

/** Find a complete outer JSON object without treating fences inside strings as delimiters. */
export function extractJsonObjectSpan(text: string): JsonObjectSpan | null {
  const first = firstTopLevelObject(text);
  const markers = [...text.matchAll(/```json\s*/gi)];
  if (first && markers.some(marker => marker.index >= first.start && marker.index < first.end)) return first;
  for (const marker of markers) {
    const start = text.indexOf("{", marker.index + marker[0].length);
    if (start < 0) continue;
    const scan = scanObjectAt(text, start);
    if (scan.span) return scan.span;
    if (scan.incomplete) return null;
  }
  return first;
}
