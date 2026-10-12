import { describe, expect, it } from "vitest";
import { conversationInputSourceId, createConversationFileSources, formatWorkshopConversation,
  isConversationToolAllowed, parseConversationInputFiles, readConversationTrigger } from "@/lib/workshops/conversation-input";

const runId = "00000000-0000-4000-a000-000000000001";

describe("temporary conversation inputs", () => {
  it("finds explicit Windows, POSIX and file URI inputs, preserving quoted spaces and Chinese", () => {
    const files = parseConversationInputFiles('清洗 "D:\\资料\\季度 报表(1).xlsx"，还有 `/tmp/input data.md`\nC:\\files\\a.pdf\nfile:///D:/data/test.txt');
    expect(files).toEqual(['D:\\资料\\季度 报表(1).xlsx', '/tmp/input data.md', 'C:\\files\\a.pdf', 'file:///D:/data/test.txt']);
  });
  it("does not interpret URLs or relative paths as local file grants", () => {
    expect(parseConversationInputFiles('看 https://example.test/a.pdf 和 data/a.txt 或 //example.test/x')).toEqual([]);
  });
  it("does not stage bare web routes as local files", () => {
    expect(parseConversationInputFiles('查看 /knowledge-pipeline、/memory、/workspace、/loops 四个页面')).toEqual([]);
    expect(parseConversationInputFiles('清洗 /tmp/report.pdf 和 `/README`')).toEqual(['/tmp/report.pdf', '/README']);
  });
  it("pairs delimiters without splitting a filename at another kind of quote", () => {
    expect(parseConversationInputFiles(`清洗 "D:\\O'Brien\\report.pdf" 和 “D:\\data\\中文 '附录'.md”`))
      .toEqual(["D:\\O'Brien\\report.pdf", "D:\\data\\中文 '附录'.md"]);
  });
  it("deduplicates file references and rejects oversized batches", () => {
    expect(parseConversationInputFiles('"D:\\data\\a.md" "D:\\data\\a.md"')).toEqual(['D:\\data\\a.md']);
    expect(() => parseConversationInputFiles(Array.from({ length: 21 }, (_, n) => `/tmp/${n}.txt`).join('\n'))).toThrow('20');
  });
  it("rejects malformed conversation triggers instead of falling through to autonomous work", () => {
    expect(readConversationTrigger({ type: 'manual' })).toBeNull();
    expect(() => readConversationTrigger({ type: 'conversation', content: 'run', inputFiles: ['relative.txt'] })).toThrow();
    expect(readConversationTrigger({ type: 'conversation', content: '问题', parentRunId: null, inputFiles: [] }))
      .toEqual({ type: 'conversation', content: '问题', parentRunId: null, inputFiles: [] });
  });
  it("creates only deterministic descriptors scoped to the specific run", () => {
    const path = 'D:\\data\\test.csv';
    const sources = createConversationFileSources({ workshopId: 'work', runId, inputFiles: [path] });
    expect(sources[0]).toMatchObject({ name: 'test.csv', uri: path, workshopId: 'work', config: { scope: 'conversation', runId } });
    expect(sources[0].id).toBe(conversationInputSourceId(runId, path));
    expect(sources[0].id).not.toBe(conversationInputSourceId('another-run', path));
  });
  it("blocks durable task/memory/notification tools regardless of MCP prefix", () => {
    expect(isConversationToolAllowed('mcp__workshop-tools__workshopWriteMemory')).toBe(false);
    expect(isConversationToolAllowed('workshopCreateLoopTask')).toBe(false);
    expect(isConversationToolAllowed('wechatCreateReplyDraft')).toBe(false);
    expect(isConversationToolAllowed('workshopConvertDocument')).toBe(true);
    expect(isConversationToolAllowed('workshopSearchMemory')).toBe(true);
  });
  it("marks history as context, keeps current task explicit, and preserves the reply contract", () => {
    const prompt = formatWorkshopConversation({ content: '解释上一份结果', inputFiles: [], history: [
      { runId, content: '清洗', reply: '完成', status: 'completed' },
    ] });
    expect(prompt).toContain('历史消息仅帮助理解追问');
    expect(prompt).toContain('"currentRequest":"解释上一份结果"');
    expect(prompt).toContain('presentation.reportMarkdown');
  });
});
