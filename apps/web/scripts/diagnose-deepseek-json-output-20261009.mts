import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractJsonObjectSpan } from "../lib/workshops/json-output";

const runId = "23826eba-bb8e-80e9-a1d6-1d645557b349";
const inputPath = resolve("../../docs/verification/artifacts/workshop-chat-control-2026-10-09", `source-coverage-${runId}.json`);
const outputPath = resolve("../../docs/verification/artifacts/deepseek-reading-rerun-2026-10-09", `json-output-diagnosis-${runId}.json`);
const evidence = JSON.parse(readFileSync(inputPath, "utf8"));
const event = evidence.failures.find((value: { type: string }) => value.type === "run_failed");
const raw: string = event.body;
assert.equal(raw.length, 26_803, "Must inspect the complete persisted run_failed body, not reportText");
const markers = [...raw.matchAll(/```json\s*/gi)];
const closingFenceAt = raw.lastIndexOf("```");
const candidates = markers.map(marker => {
  const start = raw.indexOf("{", marker.index! + marker[0].length);
  const candidate = raw.slice(start, closingFenceAt).trimEnd();
  try {
    const value = JSON.parse(candidate);
    return { markerOffset: marker.index, objectOffset: start, length: candidate.length, validJson: true,
      parserExtractsSuffix: extractJsonObjectSpan(raw.slice(marker.index)) !== null,
      rootKeys: Object.keys(value), sourceIds: value.researchEvidence?.works?.map((work: { sourceId: string }) => work.sourceId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionText = message.match(/position (\d+)/)?.[1];
    const position = positionText === undefined ? null : Number(positionText);
    return { markerOffset: marker.index, objectOffset: start, length: candidate.length, validJson: false,
      error: message, jsonOffset: position, rawOffset: position === null ? null : start + position,
      offendingCharacterCode: position === null ? null : candidate.charCodeAt(position),
      excerptOffset: position === null ? null : Math.max(0, start + position - 125),
      excerpt: position === null ? candidate.slice(-250) : candidate.slice(Math.max(0, position - 125), position + 125) };
  }
});
const result = {
  inspectedAt: new Date().toISOString(), runId, sourceEventId: event.id,
  inputArtifact: inputPath, sourceField: "failures[type=run_failed].body", rawChars: raw.length,
  rawSha256: createHash("sha256").update(raw).digest("hex"),
  capturedStatus: evidence.capturedOutput?.status ?? null,
  fullTextParserResult: extractJsonObjectSpan(raw) === null ? "null" : "parsed",
  jsonFenceCount: markers.length, candidates,
  diagnosis: "模型在首个 JSON 的 presentation.reportMarkdown 字符串内重新开始了另一段回复，留下未转义换行与未闭合首段；完整回复不满足严格 JSON。解析器拒绝首个未完成的外层对象，符合当前避免把字符串或嵌套对象误当顶层报告的保护规则。后段可单独解析不等于完整响应有效，也不能恢复为已验收成功。",
  scope: "只读定位，无数据更新、修复、重跑或模型调用。",
};
writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
const stored = readFileSync(outputPath, "utf8");
assert.ok(!stored.includes("\uFFFD") && !stored.includes("???"), "UTF-8 readback mismatch");
console.log(JSON.stringify({ outputPath, rawChars: result.rawChars, fullTextParserResult: result.fullTextParserResult,
  jsonFenceCount: result.jsonFenceCount, candidates }, null, 2));
