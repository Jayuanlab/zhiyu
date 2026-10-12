import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {createPiAgentRuntime} from "@openzhiyu/ai/agent/runtime";
// @ts-expect-error TS5097: Vitest resolves the explicit script extension without emitting it.
import {createFrozenEvalTools} from "../../scripts/lib/platform-eval-v2-frozen-tools.mts";
import {createPlatformAnswerSession} from "@/lib/ai/runtime/platform-answer-session";
import {guardPlatformAnswer} from "@/lib/ai/runtime/platform-answer-gate";
import {createMemoryReadBudget} from "@/lib/ai/memory-read-budget";
import {PlatformReadHandleRegistry} from "@/lib/ai/platform-read-handle-registry";
import type {PlatformFieldPageBinding} from "@/lib/ai/platform-field-pages";

vi.mock("@/lib/db/client", () => ({db: {}, withDatabaseTransaction: () => {throw Error("Frozen paging tests must not access production DB");}}));
const directories: string[] = [];
const ownerId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const loopId = "33333333-3333-4333-8333-333333333333";
const capturedAt = "2026-10-04T03:00:00.000Z";
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("zhiyu-platform-paging-frozen-")) throw Error("Unexpected test cleanup path");
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});
function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-platform-paging-frozen-")); directories.push(folder);
  const output = "OUTPUT_BEGIN_" + "x".repeat(16000) + "_OUTPUT_END";
  const verification = {status: "requires_review", approved: false, detail: "VERIFY_BEGIN_" + "y".repeat(9000) + "_VERIFY_END"};
  const content = {id: runId, loop_id: loopId, status: "completed", output_summary: output, verification_result: verification};
  const manifest = {ownerId, recordSnapshotCapturedAt: capturedAt, repositoryCapturedAt: capturedAt, sourceHashes: {}};
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(folder, "corpus.jsonl"), JSON.stringify({kind: "database_row", id: "run", table: "loop_runs", recordId: runId,
    ownerId, capturedAt, content, sha256: createHash("sha256").update(JSON.stringify(content)).digest("hex")}) + "\n", "utf8");
  return {folder, manifest, output, verification, question: {id: "paging-fixture", requester: {userId: ownerId},
    question: `loopRuns ${runId} 的状态、完整输出和验证结果是什么？`}};
}
function handles(value: any): any[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(handles);
  return [...(Array.isArray(value.readHandles) ? value.readHandles : []), ...Object.values(value).flatMap(handles)];
}

describe("frozen field paging through the actual factory and installed SDK", () => {
  it.each(["complete", "missing-page-core-commit", "final-denied"] as const)("keeps full-field coverage honest for %s", async mode => {
    const data = fixture();
    const identity = {ownerId, requester: {kind: "chat" as const, id: data.question.id}, turnId: `paging-${mode}`};
    const registry = new PlatformReadHandleRegistry(identity);
    const budget = createMemoryReadBudget();
    let authorizePages: ((binding: PlatformFieldPageBinding) => Promise<boolean>) | undefined;
    let currentAccess = true;
    const sourceOptions = {...data, turnId: identity.turnId, platformReadRegistry: registry, platformReadIdentity: identity,
      memoryReadBudget: budget, platformReadAuthorize: async () => currentAccess,
      onFieldPageAuthorizer: (authorize: (binding: PlatformFieldPageBinding) => Promise<boolean>) => {authorizePages = authorize;},
      onResultConstructed: (receipt: any) => session.observeToolConstruction(receipt)};
    const session = createPlatformAnswerSession({mode: "enforce_supported", turnId: identity.turnId, ownerId,
      question: data.question.question, policyHash: "test-policy", runtimeHash: "test-runtime", snapshotAt: capturedAt,
      timePolicy: {mode: "unconstrained"}, auditSink: async () => undefined, authorizeFinal: async () => true,
      resolveFieldPageReadHandle: handle => registry.resolve(handle, identity),
      authorizeFieldPageFinal: binding => authorizePages?.(binding) ?? Promise.resolve(false)});
    const tools = createFrozenEvalTools(sourceOptions);
    const faux = createFauxCore({});
    let invocation = 0, selected: any[] = [], fieldIndex = 0, cursor: string | undefined;
    let skipped = false, SDKCallbacks = 0, pageCallbacks = 0;
    const pageLengths: number[] = [];
    const streamFn = async (model: any, context: any, options: any) => {
      invocation++;
      if (invocation === 1) faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", {question: data.question.question}), {stopReason: "toolUse"})]);
      else if (fieldIndex < selected.length) faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", {fieldPage:
        {readHandle: selected[fieldIndex].readHandle, ...(cursor ? {cursor} : {})}}), {stopReason: "toolUse"})]);
      else {
        if (mode === "final-denied") currentAccess = false;
        faux.setResponses([fauxAssistantMessage("UNSUPPORTED_USER_DRAFT_ALL_FIELDS_VERIFIED")]);
      }
      return faux.streamSimple(model, context, options);
    };
    const runtime = createPiAgentRuntime({adapter: "harness", model: faux.getModel(), streamFn, tools});
    const visible: any[] = [];
    try {
      const run = runtime.run({operation: "run", prompt: data.question.question,
        options: {sessionId: identity.turnId, abortController: new AbortController(), onToolContextCommitted: async receipt => {
          SDKCallbacks++;
          const lineBreak = receipt.modelText.indexOf("\n");
          const header = lineBreak >= 0 ? JSON.parse(receipt.modelText.slice(0, lineBreak)) : null;
          if (header?.fieldPage) {
            expect(header.fieldPage?.schemaVersion).toBe("platform-field-page.v2");
            expect(header.fieldPage?.status).toBe("read_window");
            pageCallbacks++; pageLengths.push(receipt.modelText.length);
            cursor = header.fieldPage.nextCursor ?? undefined;
            if (!cursor) fieldIndex++;
            if (mode === "missing-page-core-commit" && !skipped) {skipped = true; return;}
          } else {
            expect(invocation).toBe(1);
            selected = handles(JSON.parse(receipt.modelText)).filter(handle => ["outputSummary", "verificationResult"].includes(handle.fieldKey));
            expect(selected.map(handle => handle.fieldKey)).toEqual(["outputSummary", "verificationResult"]);
          }
          await session.observeContextCommitted(receipt);
        }}});
      for await (const event of guardPlatformAnswer(run, session)) visible.push(event);
    } finally {registry.close();}
    const decision = session.snapshot().decision;
    const answer = visible.filter(event => event.type === "text").map(event => event.content ?? "").join("");
    if (process.env.C75_FROZEN_DIAGNOSTIC_DIR) fs.writeFileSync(path.join(process.env.C75_FROZEN_DIAGNOSTIC_DIR, mode + ".diagnostic.json"), JSON.stringify({invocation, SDKCallbacks, pageCallbacks, eventTypes: visible.map(event => event.type), errors: visible.filter(event => event.type === "error" || event.runtimeTerminal?.error).map(event => String(event.runtimeTerminal?.error ?? event.error ?? event.content ?? "").slice(0, 700))}), {encoding: "utf8", flag: "wx"});
    expect(SDKCallbacks).toBeGreaterThan(3);
    expect(pageCallbacks).toBeGreaterThan(2);
    expect(pageLengths.every(length => length <= 8000)).toBe(true);
    expect(budget.snapshot().attempts).toBeLessThanOrEqual(10);
    expect(budget.snapshot().committedCharacters).toBeLessThanOrEqual(64000);
    expect(answer.includes("UNSUPPORTED_USER_DRAFT_ALL_FIELDS_VERIFIED")).toBe(false);
    expect(decision?.questionComplete).toBe(mode === "complete");
    if (mode === "complete") {
      expect(answer.includes(data.output)).toBe(true);
      expect(answer.includes(data.verification.detail)).toBe(true);
      expect(answer.includes("requires_review")).toBe(true);
      expect(answer.includes('"approved": false') || answer.includes('"approved":false')).toBe(true);
      expect(decision?.resolutions.every(resolution => resolution.state === "supported")).toBe(true);
    }
  });
});
