import { describe, expect, it } from "vitest";
import { createLoopAgentTextBuffer } from "@/lib/loops/native-executor";
import { buildStructuredExecutionReport, parseStructuredOutput } from "@/lib/types/execution-result";

describe("createLoopAgentTextBuffer", () => {
  it("selects the approved terminal result rather than earlier rejected structured drafts", () => {
    const buffer = createLoopAgentTextBuffer();
    const draft = '```json\n{"summary":"rejected draft","reportMarkdown":"partial"}\n```';
    const approved = '```json\n{"summary":"approved final","reportMarkdown":"complete report","researchProcess":{"status":"evidence_insufficient"},"projectAssessment":{},"checkpoint":{"nextQuestions":["continue the research"]},"warnings":[]}\n```';
    buffer.append(draft);
    buffer.append(approved.slice(0, 70)); buffer.append(approved.slice(70));
    expect(buffer.acceptFinalResult({type:'result',answerPhase:'candidate_final',content:approved})).toBe(true);
    const selected = buffer.finalText();
    expect(parseStructuredOutput(selected).data.summary).toBe('approved final');
    expect(parseStructuredOutput(selected).data.checkpoint).toEqual({nextQuestions:['continue the research']});
    const parsed = parseStructuredOutput(selected);
    const stored = buildStructuredExecutionReport({structuredData:parsed.data,cleanText:parsed.cleanText,rawText:selected,
      preferReportMarkdown:true,requiredFields:['researchProcess','projectAssessment','checkpoint','warnings','reportMarkdown']});
    for (const field of ['researchProcess','projectAssessment','checkpoint','warnings','reportMarkdown']) expect(stored[field]).toEqual(parsed.data[field]);
    expect(buffer.text()).toBe(draft + approved);
  });
  it('ignores intermediate results and preserves legacy text fallback without a selected candidate', () => {
    const buffer = createLoopAgentTextBuffer(); buffer.append('Legacy stream.');
    expect(buffer.acceptFinalResult({type:'result',answerPhase:'intermediate',content:'Rejected draft.'})).toBe(false);
    expect(buffer.hasFinalCandidate()).toBe(false);
    expect(buffer.finalText()).toBe('Legacy stream.');
  });
  it('rejects empty or duplicate approved final results without replacing the selected report', () => {
    const buffer = createLoopAgentTextBuffer();
    expect(() => buffer.acceptFinalResult({type:'result',answerPhase:'candidate_final',content:'  '})).toThrow('Empty approved');
    expect(buffer.hasFinalCandidate()).toBe(false);
    buffer.acceptFinalResult({type:'result',answerPhase:'candidate_final',content:'Exact approved report.'});
    expect(() => buffer.acceptFinalResult({type:'result',answerPhase:'candidate_final',content:'Different report.'})).toThrow('Duplicate approved');
    expect(buffer.finalText()).toBe('Exact approved report.');
  });
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
