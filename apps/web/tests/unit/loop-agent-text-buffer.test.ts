import { describe, expect, it } from "vitest";
import { createLoopAgentTextBuffer } from "@/lib/loops/native-executor";
import { parseStructuredOutput } from "@/lib/types/execution-result";

describe("createLoopAgentTextBuffer", () => {
  it("coalesces model text deltas for final output and hides structured metadata from trace text", () => {
    const buffer = createLoopAgentTextBuffer();
    const traceBlocks: string[] = [];
    const chunks = [
      "Report starts. ",
      "Point A",
      ".",
      "\n<structured-output>",
      "{\"summary\":\"Full summary\",\"items\":[1",
      ",2",
      "]}",
      "</structured-output>",
    ];

    for (const chunk of chunks) {
      buffer.append(chunk);
      const flushed = buffer.flush(false);
      if (flushed) traceBlocks.push(flushed);
    }

    const finalFlush = buffer.flush(true, { final: true });
    if (finalFlush) traceBlocks.push(finalFlush);

    const parsed = parseStructuredOutput(buffer.text());

    expect(buffer.text()).toContain("</structured-output>");
    expect(parsed.data.summary).toBe("Full summary");
    expect(parsed.cleanText).toBe("Report starts. Point A.");
    expect(traceBlocks.join("\n")).toBe("Report starts. Point A.");
    expect(traceBlocks.join("\n")).not.toContain("structured-output");
    expect(traceBlocks.at(-1)).not.toBe("]");
  });

  it("keeps short tool-boundary fragments buffered until they join useful text", () => {
    const buffer = createLoopAgentTextBuffer();

    buffer.append("情绪：");
    expect(buffer.flush(true)).toBeNull();

    buffer.append("市场热点集中在电力和元件PCB，继续读取规则证据。");
    expect(buffer.flush(false)).toBeNull();
    expect(buffer.flush(true, { final: true })).toBe(
      "情绪：市场热点集中在电力和元件PCB，继续读取规则证据。",
    );
  });

  it("does not flush numbered fragments as readable stage output", () => {
    const buffer = createLoopAgentTextBuffer();

    buffer.append("7. ✅ quantRuleEvaluate — 8/8 triggered 8.");

    expect(buffer.flush(false)).toBeNull();
    expect(buffer.flush(true)).toBeNull();
    expect(buffer.flush(true, { final: true })).toBe(
      "7. ✅ quantRuleEvaluate — 8/8 triggered 8.",
    );
  });
});
