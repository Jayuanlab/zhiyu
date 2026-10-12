/** Offline matched replay over frozen candidate bytes and same-run receipts.
 * Only new replay artifacts are written. No DB, model, provider, owner run,
 * source refresh, historical repair, configuration or deployment is executed.
 * A hypothetical successful final input is not a rescued historical run. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseGroundedResearchFinalJson } from "../lib/workshops/grounded-final-json";
import { finalizeWorkshopResearchDelivery } from "../lib/workshops/research-report-delivery";
import { finalizeWorkshopResearchReaderDelivery } from "../lib/workshops/research-reader-delivery";
import type { WorkshopExecutionResult } from "../lib/workshops/executor";
import type { WorkshopResearchEvidenceEvent } from "../lib/workshops/research-evidence-verification";

const baseline = process.argv[2] === "--baseline";
assert(process.argv.length === (baseline ? 3 : 2), "usage_optional_--baseline");
const inputDirectory = new URL("../../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/", import.meta.url);
const qualityDirectory = new URL("../../../docs/verification/artifacts/research-report-quality-2026-10-09/", import.meta.url);
const outputDirectory = new URL("../../../docs/verification/artifacts/research-reader-first-2026-10-09/", import.meta.url);
const evidenceDirectory = new URL("../.data/web-read-evidence/", import.meta.url);
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
type Json = Record<string, any>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const manifest = new Map<string, { file: URL; hash: string; bytes: number }>();
async function readPinned(file: URL, expectedHash?: string) {
  const bytes = await readFile(file);
  const hash = sha(bytes);
  if (expectedHash) assert.equal(hash, expectedHash, "frozen_input_changed:" + fileURLToPath(file));
  const key = fileURLToPath(file);
  const previous = manifest.get(key);
  if (previous) assert.equal(previous.hash, hash, "input_changed_during_replay:" + key);
  manifest.set(key, { file, hash, bytes: bytes.length });
  return bytes;
}
async function readJson(file: URL, expectedHash?: string): Promise<Json> {
  return JSON.parse((await readPinned(file, expectedHash)).toString("utf8"));
}

// A wrapper may catch a provider error internally. Count attempts as well as
// denying them so such a fallback cannot masquerade as a local-only replay.
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw Error("offline_replay_network_forbidden"); };

const fixtures = [
  {
    runId: "ae32ad1f-d5ce-85b1-a1ca-2946118e0d86",
    terminal: "run-ae32ad1f-d5ce-85b1-a1ca-2946118e0d86-terminal-2026-10-09T04-16-56-741Z.json",
    terminalHash: "9e2604cd82064f35bcd06569ada7ac898d6857203a67a43e8920ba31695b5752",
    candidate: "candidate-ae32ad1f-d5ce-85b1-a1ca-2946118e0d86-0.txt",
    candidateHash: "3c394aae27565b3ef0c3458f2cce5ff6233a4ab36de091f10847219d1ece426d",
    readerAudit: "review58-ae32-reader-quality.json",
    readerAuditHash: "56414a6a3d1d26cc0eeae3415f7fc219ce798c7c5fa3ffe87767b393397535ad",
    proseSentinel: "通过组内得分估计基线",
    knownQualityErrors: [
      "Math 的纯 RL 证明和基础能力假设去模态超出来源。",
      "R1-Zero 被绑定 R1 的 79.8% 分数；真实模型对象混用。",
      "MCTS、成本与 GRM 排名/比较范围扩写未由所引 facts 支持。"
    ],
    localValue: "三项主题及阅读入口有参考价值；冗长复述和新增失真使整篇科学质量未通过。"
  },
  {
    runId: "e82b57e9-95ef-8247-ace9-dd3587b8dd80",
    terminal: "run-e82b57e9-95ef-8247-ace9-dd3587b8dd80-terminal-2026-10-09T04-25-28-905Z.json",
    terminalHash: "b7a786b1c184b4e0cf2b0ba4af9ec566a0cb220b63b7ffbfc0612441f991625b",
    candidate: "candidate-e82b57e9-95ef-8247-ace9-dd3587b8dd80-0.txt",
    candidateHash: "d24422d078fac7823f54d73579a94e806806ff58d0ed4fbb9061c5c1c3890097",
    readerAudit: "review58-e82-failure-reader-audit.json",
    readerAuditHash: "70c844dfcccb906f0c14e5bf555af0cfda926af9f11477b69e3c684c3c42a0fa",
    proseSentinel: "提出两种路径",
    knownQualityErrors: [
      "前言加完整 JSON 不符合历史单一 JSON 合同；缺 Math/GRM limitation。",
      "GRPO 到奖励评估的完整闭环关系没有所引 GRM refs 支持。",
      "旧审查仅有界检查部分解读，未完成所有事实的独立科学审查。"
    ],
    localValue: "Zero 与 R1 冷启动的区分有阅读价值；不能因草稿格式宽容就认定闭环关系及全部内容已核实。"
  },
  {
    runId: "065266a8-6c29-84dd-a78d-8c71528541a1",
    terminal: "run-065266a8-6c29-84dd-a78d-8c71528541a1-terminal-2026-10-09T04-49-00-229Z.json",
    terminalHash: "31d612dc6f52498a1c351bfcfb92820dbcf7089808779578aa705d789456c0f9",
    candidate: "candidate-065266a8-6c29-84dd-a78d-8c71528541a1-2.txt",
    candidateHash: "cbcb1f76ff2fad925aad256f7e5cb158eaec6428b2df2dbf33b8ebe9c5d52035",
    readerAudit: "review59-065-reader-quality.json",
    readerAuditHash: "189c41a163736cb19d8feb59caa89ea83daf97d408d24b091310d8cca8072673",
    proseSentinel: "需区分训练时优化与推理时采样",
    knownQualityErrors: [
      "三阶段/逐步演进、冷启动必要性和原则链未获所引原句支持。",
      "critic 节省事实真实，但 F1 指向 method 而非实际含 critic 的 R1/experiment。",
      "Math 未涉及非数学任务/跨域仅 CMATH 被已读正文反证。",
      "GRM 32/8/671 比较的 Reward Bench 与 could 条件遗漏；真实数字超当前短摘不等于数字幻觉。"
    ],
    localValue: "训练时优化与推理时采样的对象区别是有用认识；短简报不等于科学质量通过。"
  }
] as const;

async function sourceInputs(observation: Json) {
  const scopeHash = sha("workshop:" + observation.workId);
  const sourceEvents = (observation.allSourceCheckedReceipts ?? observation.sourceCheckedReceipts) as Json[];
  const sources = [];
  for (const page of observation.pages as Json[]) {
    assert.equal(page.available, true);
    const directory = new URL(scopeHash + "/" + page.evidenceId + "/", evidenceDirectory);
    const snapshot = await readJson(new URL("snapshot.json", directory));
    const cleanBytes = await readPinned(new URL("clean.md", directory), page.contentHash);
    const clean = cleanBytes.toString("utf8");
    const raw = await readPinned(new URL("raw.html", directory), snapshot.rawHash);
    assert.equal(snapshot.content, clean);
    assert.equal(snapshot.contentHash, page.contentHash);
    assert.equal(snapshot.evidenceId, page.evidenceId);
    assert.equal(snapshot.scopeHash, scopeHash);
    assert.equal(snapshot.url, page.url);
    assert.equal(raw.length, snapshot.rawBytes);
    assert.equal(clean.length, page.snapshotChars);
    const validEvents = sourceEvents.filter(event => page.validEventIds.includes(event.eventId));
    assert.equal(validEvents.length, page.validEventIds.length);
    const windows = [];
    let covered = 0;
    for (const event of validEvents.sort((a, b) => a.metadata.offset - b.metadata.offset)) {
      const metadata = event.metadata;
      assert.equal(event.runId, observation.run.id);
      assert.equal(event.workshopId, observation.workId);
      assert.equal(event.type, "source_checked");
      assert.equal(metadata.receiptAuthority, "runtime");
      assert.equal(metadata.execution.runId, observation.run.id);
      assert.equal(metadata.evidenceId, page.evidenceId);
      assert.equal(metadata.contentHash, page.contentHash);
      assert.equal(metadata.url, page.url);
      assert.equal(metadata.offset, covered);
      const windowProof = page.diskWindows.find((window: Json) => window.offset === metadata.offset);
      assert(windowProof?.valid, "missing_frozen_disk_window_identity");
      const window = await readJson(new URL(windowProof.file, directory));
      assert.equal(window.evidenceId, page.evidenceId);
      assert.equal(window.contentHash, page.contentHash);
      assert.equal(window.offset, metadata.offset);
      assert.equal(window.content.length, metadata.contentLength);
      assert.equal(window.content, clean.slice(metadata.offset, metadata.offset + metadata.contentLength));
      assert.equal(window.totalChars, clean.length);
      assert.equal(window.nextOffset, metadata.nextOffset);
      covered += metadata.contentLength;
      windows.push({ eventId: event.eventId, offset: metadata.offset, endOffset: covered,
        diskFile: windowProof.file, diskHash: manifest.get(fileURLToPath(new URL(windowProof.file, directory)))!.hash });
    }
    assert.equal(covered, clean.length);
    sources.push({ evidenceId: page.evidenceId, url: page.url, contentHash: page.contentHash,
      rawHash: snapshot.rawHash, chars: clean.length, scopeHash, windows });
  }
  const events: WorkshopResearchEvidenceEvent[] = [...sourceEvents, ...(observation.quoteSelections ?? [])]
    .map((event: Json) => {
      assert.equal(event.runId, observation.run.id);
      assert.equal(event.workshopId, observation.workId);
      assert.equal(event.metadata.receiptAuthority, "runtime");
      return { id: event.eventId, runId: event.runId, type: event.type, metadata: event.metadata };
    });
  return { events, sources };
}

const results = [];
const wrapperFile = new URL("../lib/workshops/research-reader-delivery.ts", import.meta.url);
const wrapperHash = sha(await readPinned(wrapperFile));
for (const fixture of fixtures) {
  const observed = await readJson(new URL(fixture.terminal, inputDirectory), fixture.terminalHash);
  assert.equal(observed.run.id, fixture.runId);
  assert.equal(observed.run.status, "failed");
  assert.equal(observed.captured.status, "error");
  assert.equal(observed.databaseReadOnly, true);
  assert.equal(observed.matchedInput.sourcePromptMatches, true);
  const candidate = (await readPinned(new URL(fixture.candidate, inputDirectory), fixture.candidateHash)).toString("utf8");
  const originalError = (await readPinned(new URL(observed.rawOutput.file, inputDirectory), observed.rawOutput.hash)).toString("utf8");
  assert.equal(originalError.length, observed.rawOutput.chars);
  const readerReview = await readJson(new URL(fixture.readerAudit, qualityDirectory), fixture.readerAuditHash);
  const { events, sources } = await sourceInputs(observed);
  const context = observed.captured.pinnedResearchContext;
  assert(context?.modelConfig && typeof context.taskText === "string");
  const common = { workshopId: observed.workId, runId: fixture.runId,
    modelConfig: structuredClone(context.modelConfig), taskText: context.taskText, events };

  // These success fields are explicit counterfactual inputs for the new seam.
  // The historical captured status remains error and no run is mutated.
  const hypothetical: WorkshopExecutionResult = { status: "success", output: candidate,
    structured: parseGroundedResearchFinalJson(candidate) as WorkshopExecutionResult["structured"],
    durationMs: observed.captured.durationMs, toolCallCount: observed.captured.toolCallCount };
  const strict = await finalizeWorkshopResearchDelivery({ ...common, result: structuredClone(hypothetical) });
  const reader = await finalizeWorkshopResearchReaderDelivery({ ...common, result: structuredClone(hypothetical) });
  const audit = record(reader.audit);
  const presentation = record(reader.result.structured?.presentation);
  const rendered = [presentation.summary, presentation.researchBriefMarkdown,
    presentation.reportMarkdown, ...(presentation.warnings ?? [])].filter(value => typeof value === "string").join("\n");
  const knownEventIds = new Set(events.map(event => event.id));
  const attachedEventIds = Array.isArray(presentation.evidenceEventIds) ? presentation.evidenceEventIds : [];
  const checks = {
    originalStrictGateStillRejected: strict.audit?.status === "rejected" && strict.verification.status !== "sufficient",
    hypotheticalReaderDelivered: audit.version === "reader-report/v1" && audit.status === "delivered" && reader.result.status === "success",
    verificationNotPromoted: audit.verificationStatus === "unverified" && audit.semanticStatus === "not_independently_verified",
    hostReaderSource: presentation.source === "host_research_reader",
    canonicalHashPresent: typeof audit.canonicalHash === "string" && /^[a-f0-9]{64}$/u.test(audit.canonicalHash),
    readerProseActuallyRendered: typeof presentation.researchBriefMarkdown === "string" && presentation.researchBriefMarkdown.includes(fixture.proseSentinel),
    verificationWarningVisible: /尚未.{0,16}核验|未核验|待核验|待核查|尚未通过|核验.{0,16}未通过|未通过.{0,12}核验|unverified/iu.test(rendered),
    provenanceOnlyUsesCurrentRun: attachedEventIds.length > 0 && attachedEventIds.every((id: unknown) => typeof id === "string" && knownEventIds.has(id))
  };

  // Frozen exports contain a summary of result_json, not its complete bytes.
  // Reconstruct only the actual error fields, and say so in the proof.
  const actualFailureInput: WorkshopExecutionResult = { status: "error", output: originalError,
    structured: { runtimeFailure: structuredClone(observed.captured.runtimeFailure) },
    durationMs: observed.captured.durationMs, toolCallCount: observed.captured.toolCallCount };
  const failure = await finalizeWorkshopResearchReaderDelivery({ ...common, result: actualFailureInput });
  const failurePresentation = record(failure.result.structured?.presentation);
  const failureChecks = {
    actualErrorStatusRetained: failure.result.status === "error",
    actualErrorOutputRetained: failure.result.output === originalError,
    actualErrorNotDeliveredAsReader: record(failure.audit).status !== "delivered" && failurePresentation.source !== "host_research_reader"
  };
  results.push({ runId: fixture.runId, historicalStatus: observed.run.status,
    frozenTerminal: { file: fixture.terminal, sha256: fixture.terminalHash },
    candidate: { file: fixture.candidate, sha256: fixture.candidateHash, chars: candidate.length },
    sourceEvidence: sources, eventsBasis: "frozen_same_run_runtime_source_and_quote_metadata",
    counterfactual: { hypotheticalSuccessfulFinal: true, changedFields: ["result.status=success", "result.output=exact_rejected_candidate", "result.structured=strict_parse_of_candidate"],
      productionRunCreated: false, historicalRunChanged: false },
    strictGate: { strictWholeResponseParsed: hypothetical.structured !== null,
      audit: strict.audit, verificationStatus: strict.verification.status },
    readerDelivery: { audit: reader.audit, verificationStatus: reader.verification.status,
      resultStatus: reader.result.status, presentation, checks },
    actualFailure: { inputBasis: "minimal_error_result_reconstructed_from_frozen_export_fields",
      originalRawOutputFile: observed.rawOutput.file, originalRawOutputHash: observed.rawOutput.hash,
      originalRawOutput: originalError, originalCapturedStatus: observed.captured.status,
      returnedStatus: failure.result.status, returnedOutput: failure.result.output,
      returnedAudit: failure.audit ?? null, checks: failureChecks },
    quality: { readerAuditFile: fileURLToPath(new URL(fixture.readerAudit, qualityDirectory)), readerAuditSha256: fixture.readerAuditHash,
      knownErrorsNotErased: [...fixture.knownQualityErrors], localLearningValue: fixture.localValue,
      originalReaderReview: readerReview, scientificApproval: false,
      wholeReportValueAccepted: false, deliveryIsNotQualityApproval: true },
    behaviorPass: Object.values(checks).every(Boolean) && Object.values(failureChecks).every(Boolean) });
}

assert.equal(networkAttempts, 0, "wrapper_attempted_external_fetch");
for (const entry of manifest.values()) assert.equal(sha(await readFile(entry.file)), entry.hash, "historical_input_changed_after_replay");
const artifact = {
  version: "reader-policy-matched-replay/v1", observedAt: new Date().toISOString(), requestedBaselineOutput: baseline,
  evaluatedReaderWrapper: { file: fileURLToPath(wrapperFile), sha256: wrapperHash },
  earlierHarnessCheck: {
    file: "reader-policy-replay-first-check.json",
    sha256: "ce786bc721a06784ca50c9ad2b0a5b3e4295e0665200fc2eb180046dc0d2e214",
    explanation: "初次使用 --baseline 输出名时 wrapper 已实现 reader 行为，故该文件不是旧 wrapper 基线。唯一失败是本脚本的告警正则未识别‘尚未全部核验’，不是产品缺少告警；已扩展脚本识别范围，完整首检字节保留。旧 strict 基线由每组独立调用原 finalizer 直接记录。"
  },
  evaluatedPolicy: "reader-first delivery evaluated separately from original grounded verification",
  allBehaviorChecksPassed: results.every(result => result.behaviorPass), results,
  acceptance: { deliveryBehavior: results.every(result => result.behaviorPass) ? "passed_offline" : "failed_offline",
    userValue: "partial_local_learning_with_known_content_errors", scientificApproval: false,
    productionQualityImprovementProven: false, productionRerunPerformed: false,
    historicalStrictStandardChanged: false },
  inputManifest: [...manifest.entries()].map(([file, entry]) => ({ file, sha256: entry.hash, bytes: entry.bytes })),
  sideEffects: { databaseReads: 0, databaseWrites: 0, modelCalls: 0, externalCalls: 0, networkAttempts,
    historicalArtifactWrites: 0, sourceCodeWritesByReplay: 0, ownerRunCreated: false,
    newArtifactWrites: [baseline ? "reader-policy-replay-baseline.json" : "reader-policy-replay.json"] },
  interpretationBoundary: "三组 success 输入只是假设正常最终答复到达时的接口回放，不是历史失败复活。delivered 只表示草稿交付；旧 grounded rejection、独立质量错误和科学未通过状态均保留。"
};
const serialized = JSON.stringify(artifact, null, 2) + "\n";
assert(!serialized.includes("\ufffd"), "replacement_character_in_artifact");
await mkdir(outputDirectory, { recursive: true });
const output = new URL(baseline ? "reader-policy-replay-baseline.json" : "reader-policy-replay.json", outputDirectory);
await writeFile(output, serialized, { encoding: "utf8", mode: 0o600 });
assert.equal(await readFile(output, "utf8"), serialized, "artifact_utf8_readback_mismatch");
console.log(JSON.stringify({ artifact: fileURLToPath(output), artifactSha256: sha(serialized),
  allBehaviorChecksPassed: artifact.allBehaviorChecksPassed,
  checks: results.map(result => ({ runId: result.runId, behaviorPass: result.behaviorPass,
    readerChecks: result.readerDelivery.checks, failureChecks: result.actualFailure.checks })),
  scientificApproval: false, productionQualityImprovementProven: false,
  databaseReads: 0, databaseWrites: 0, modelCalls: 0, externalCalls: 0 }));
process.exitCode = artifact.allBehaviorChecksPassed ? 0 : 1;
