import { describe, expect, it } from "vitest";
import { extractJsonObjectSpan } from "@/lib/workshops/json-output";
import { extractJsonBlock } from "@/lib/workshops/context-window";

describe("structured Work JSON extraction", () => {
  it("keeps code fences inside reportMarkdown within the outer JSON object", () => {
    const value = {
      presentation: {
        reportMarkdown: "# Result\n\n```ts\nconst sample = { answer: 42 };\n```\n\nDone.",
        summary: "A complete report",
      },
      memoryCandidates: [],
    };
    const response = `Narrative before\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\nAfter`;
    const span = extractJsonObjectSpan(response);
    expect(span?.value).toEqual(value);
    expect(response.slice(span!.start, span!.end)).toBe(JSON.stringify(value, null, 2));
    expect(extractJsonBlock(response)).toEqual(value);
  });

  it("honors escaped quotes, backslashes, braces, and nested arrays", () => {
    const value = { presentation: { reportMarkdown: 'A quote: " and a slash: \\ and } then [ done' }, items: [{ text: "{inner}" }] };
    const raw = JSON.stringify(value);
    expect(extractJsonObjectSpan(`prefix ${raw} suffix`)?.value).toEqual(value);
    expect(extractJsonBlock(raw)).toEqual(value);
  });

  it("accepts plain JSON and ignores an earlier malformed object", () => {
    expect(extractJsonObjectSpan('{"summary":"ready"}')?.value).toEqual({ summary: "ready" });
    expect(extractJsonObjectSpan('bad {oops} then {"summary":"ready"}')?.value).toEqual({ summary: "ready" });
  });

  it("rejects incomplete, mismatched, and non-object JSON", () => {
    expect(extractJsonObjectSpan('```json\n{"presentation":{"summary":"unfinished"}\n```')).toBeNull();
    expect(extractJsonObjectSpan('{"a":[1,2}}')).toBeNull();
    expect(extractJsonObjectSpan('["array"]')).toBeNull();
    expect(extractJsonBlock('plain prose only')).toBeNull();
  });
});
