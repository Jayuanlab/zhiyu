import { createHash } from "node:crypto";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, any> | null => value && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, any> : null;
/** Both registered readers publish Date.toISOString(), never an observation timestamp. */
export function isPublishedRunCreatedAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value;
}
type CompleteRun = { runId: string; loopId: string; contentHash: string; status: string; createdAt: string;
  error: string | null; errorAvailability: "observed_text" | "observed_null" | "not_published";
  verificationObservation: { state: "absent" | "present" | "unsupported_shape";
    target: string | null; inputVersion: string | null; passed: boolean | null;
    expectedHash: string | null; observedHash: string | null };
  verification: { inputVersion: string; target: string; expectedHash: string; observedHash: string; passed: boolean } | null };
type PartialRun = { runId: string; hash: string | null; nextOffset: number; content: string;
  totalCharacters: number | null; complete: CompleteRun | null; gap: string | null; toolCallIds: string[] };
export type LoopRepairReadSubject = { ownerId: string; loopId: string; failedBaselineRunId: string;
  baselineOrigin: "explicit_user_run" | "owner_visible_timeline_anchor" };
/** A host projection over actual registered-tool results. It does not read or call tools.
 * It supplies the next exact read plan, which must use the existing counted executor. */
export class LoopRepairReadCoverage {
  private runs = new Map<string, PartialRun>();
  private successors = new Set<string>();
  private calls = new Map<string, { runId: string; offset: number; expectedHash?: string }>();
  private completedCalls = new Set<string>();
  private consumedCharacters = 0;
  private timelineAtEnd = false;
  private timelineGap: string | null = "timeline_not_observed";
  constructor(private subject: LoopRepairReadSubject, private limits: {
    maximumAccumulatedCharacters: number; maximumSuccessors: number;
  }) {
    if (![subject.ownerId, subject.loopId, subject.failedBaselineRunId].every(id => uuid.test(id))
      || !["explicit_user_run", "owner_visible_timeline_anchor"].includes(subject.baselineOrigin)
      || !Number.isSafeInteger(limits.maximumAccumulatedCharacters) || limits.maximumAccumulatedCharacters < 1
      || limits.maximumAccumulatedCharacters > 64000 || !Number.isSafeInteger(limits.maximumSuccessors)
      || limits.maximumSuccessors < 1 || limits.maximumSuccessors > 8) throw Error("invalid_repair_coverage_scope");
    this.runs.set(subject.failedBaselineRunId, this.empty(subject.failedBaselineRunId));
  }
  private empty(runId: string): PartialRun { return { runId, hash: null, nextOffset: 0,
    content: "", totalCharacters: null, complete: null, gap: "not_read", toolCallIds: [] }; }
  /** Input is a result of the registered owner timeline reader, not fixture before/setup. */
  observeOwnerTimeline(value: unknown) {
    const page = object(value);
    if (!page || page.status !== "read" || page.loopId !== this.subject.loopId
      || page.afterRunId !== this.subject.failedBaselineRunId || !Array.isArray(page.runs)
      || page.runs.some((run: any) => !run || !uuid.test(run.id) || run.loopId !== this.subject.loopId
        || run.id === this.subject.failedBaselineRunId)
      || typeof page.coverage?.hasMore !== "boolean") {
      this.timelineGap = "invalid_or_denied_timeline"; this.timelineAtEnd = false; return;
    }
    for (const run of page.runs) {
      if (!this.successors.has(run.id) && this.successors.size >= this.limits.maximumSuccessors) {
        this.timelineGap = "successor_limit_reached"; this.timelineAtEnd = false; return;
      }
      this.successors.add(run.id);
      if (!this.runs.has(run.id)) this.runs.set(run.id, this.empty(run.id));
    }
    this.timelineAtEnd = !page.coverage.hasMore;
    this.timelineGap = this.timelineAtEnd ? null : "timeline_continuation_required";
  }
  /** Exact SDK tool_use binding; additional calls still consume the existing tool budget. */
  registerReadCall(call: { toolCallId: string; toolName: string; runId: string; offset?: number; expectedHash?: string }) {
    if (call.toolName !== "readRunRecord" || !call.toolCallId.trim() || this.calls.has(call.toolCallId)
      || !this.runs.has(call.runId) || !Number.isSafeInteger(call.offset ?? 0) || (call.offset ?? 0) < 0)
      return false;
    this.calls.set(call.toolCallId, { runId: call.runId, offset: call.offset ?? 0, expectedHash: call.expectedHash });
    return true;
  }
  observeReadResult(toolCallId: string, value: unknown, isError = false) {
    const call = this.calls.get(toolCallId); if (!call) return false;
    const row = this.runs.get(call.runId)!;
    const fail = (reason: string) => { row.gap = reason; row.complete = null; row.content = "";
      row.nextOffset = 0; row.hash = null; row.totalCharacters = null; return false; };
    if (this.completedCalls.has(toolCallId)) return fail("duplicate_read_result");
    this.completedCalls.add(toolCallId); row.toolCallIds.push(toolCallId);
    let result: unknown = value;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { return fail("invalid_read_json"); } }
    const page = object(result);
    if (isError || !page || page.status !== "read") return fail(page?.status === "version_changed" ? "record_version_changed" : "read_unavailable");
    if (page.source !== "loopRuns" || page.id !== row.runId || page.offset !== call.offset
      || page.offset !== row.nextOffset || typeof page.content !== "string"
      || !/^[a-f0-9]{64}$/.test(page.contentHash ?? "")
      || (call.expectedHash && call.expectedHash !== page.contentHash)
      || (row.hash && row.hash !== page.contentHash) || !Number.isSafeInteger(page.totalCharacters)
      || page.totalCharacters < 1 || (row.totalCharacters !== null && row.totalCharacters !== page.totalCharacters))
      return fail("window_identity_offset_or_version_mismatch");
    const next = page.offset + page.content.length;
    if (next > page.totalCharacters || (page.nextOffset === null ? next !== page.totalCharacters
      : page.nextOffset !== next || next <= page.offset || next >= page.totalCharacters)) return fail("non_contiguous_window");
    if (this.consumedCharacters + page.content.length > this.limits.maximumAccumulatedCharacters) return fail("existing_character_budget_exhausted");
    this.consumedCharacters += page.content.length; row.hash = page.contentHash;
    row.totalCharacters = page.totalCharacters; row.content += page.content; row.nextOffset = next;
    if (page.nextOffset !== null) { row.gap = "record_continuation_required"; return true; }
    if (digest(row.content) !== row.hash) return fail("reconstructed_record_hash_mismatch");
    let document: any; try { document = JSON.parse(row.content); } catch { return fail("record_json_incomplete"); }
    const fields = object(document?.fields);
    if (document?.source !== "loopRuns" || document?.id !== row.runId || !fields
      || fields.id !== row.runId || fields.loopId !== this.subject.loopId || typeof fields.status !== "string")
      return fail("run_not_in_exact_owner_loop");
    if (!isPublishedRunCreatedAt(fields.createdAt)) return fail("record_created_at_unavailable_or_invalid");
    const verification = object(fields.verificationResult);
    // An explicit null is a complete missing verification field, rather than unread.
    if (!Object.hasOwn(fields, "verificationResult")) return fail("verification_field_not_published");
    let normalized: CompleteRun["verification"] = null;
    if (verification) {
      if (typeof verification.inputVersion === "string" && typeof verification.target === "string"
        && /^[a-f0-9]{64}$/.test(verification.expectedHash ?? "")
        && /^[a-f0-9]{64}$/.test(verification.observedHash ?? "") && typeof verification.passed === "boolean") {
        normalized = { inputVersion: verification.inputVersion, target: verification.target,
          expectedHash: verification.expectedHash, observedHash: verification.observedHash, passed: verification.passed };
      }
    }
    row.complete = { runId: row.runId, loopId: this.subject.loopId, contentHash: row.hash!,
      status: fields.status, createdAt: fields.createdAt, verification: normalized,
      error: typeof fields.error === "string" ? fields.error : null,
      errorAvailability: typeof fields.error === "string" ? "observed_text"
        : fields.error === null ? "observed_null" : "not_published",
      verificationObservation: { state: fields.verificationResult === null ? "absent"
        : verification ? "present" : "unsupported_shape",
        target: typeof verification?.target === "string" ? verification.target : null,
        inputVersion: typeof verification?.inputVersion === "string" ? verification.inputVersion : null,
        passed: typeof verification?.passed === "boolean" ? verification.passed : null,
        expectedHash: typeof verification?.expectedHash === "string" ? verification.expectedHash : null,
        observedHash: typeof verification?.observedHash === "string" ? verification.observedHash : null } };
    row.gap = null; row.content = ""; return true;
  }
  project(citedSuccessorRunIds: string[], remainingCountedToolCalls: number) {
    if (!Array.isArray(citedSuccessorRunIds) || !Number.isSafeInteger(remainingCountedToolCalls)
      || remainingCountedToolCalls < 0 || remainingCountedToolCalls > 20) throw Error("invalid_repair_projection_request");
    const cited = [...new Set(citedSuccessorRunIds)];
    const unknownCitations = cited.filter(id => !this.successors.has(id));
    const required = [this.subject.failedBaselineRunId, ...cited.filter(id => this.successors.has(id))];
    const gaps = required.flatMap(runId => {
      const row = this.runs.get(runId)!; return row.complete ? [] : [{ runId, reason: row.gap ?? "not_read" }];
    });
    const baseline = this.runs.get(this.subject.failedBaselineRunId)!.complete;
    const comparisons = cited.filter(id => this.successors.has(id)).map(runId => {
      const successor = this.runs.get(runId)!.complete;
      const a = baseline?.verification, b = successor?.verification;
      const sameFailureTarget = !!a && !!b && baseline?.status === "failed" && !a.passed
        && !!successor && (successor.createdAt > baseline.createdAt
          || successor.createdAt === baseline.createdAt && successor.runId > baseline.runId)
        && a.inputVersion === b.inputVersion && a.target === b.target && a.expectedHash === b.expectedHash;
      return { runId, fullyRead: !!successor, sameFailureTarget,
        successorStatus: successor?.status ?? null,
        baselineVerification: baseline?.verificationObservation ?? null,
        successorVerification: successor?.verificationObservation ?? null,
        repairedTargetObserved: sameFailureTarget && successor?.status === "completed" && !!b?.passed
          && b.observedHash === b.expectedHash,
        baselineRecordHash: baseline?.contentHash ?? null, successorRecordHash: successor?.contentHash ?? null };
    });
    const nextReads = remainingCountedToolCalls > 0 ? gaps.slice(0, remainingCountedToolCalls).map(gap => {
      const row = this.runs.get(gap.runId)!;
      const continueRead = row.gap === "record_continuation_required";
      return { toolName: "readRunRecord", params: { runId: gap.runId, offset: continueRead ? row.nextOffset : 0,
        ...(continueRead && row.hash ? { expectedHash: row.hash } : {}) }, consumesExistingToolCall: true };
    }) : [];
    return { schemaVersion: "loop-repair-read-coverage.v1", subject: { ...this.subject },
      baselineRecord: baseline,
      completeRunRecords: required.flatMap(runId => {
        const record = this.runs.get(runId)!.complete; return record ? [record] : [];
      }),
      coverageCompleteForCitedRuns: gaps.length === 0 && unknownCitations.length === 0,
      timelineAtReadEnd: this.timelineAtEnd, timelineGap: this.timelineGap,
      gaps, unknownCitations, comparisons, nextReads,
      existingBudget: { consumedCharacters: this.consumedCharacters, remainingCountedToolCalls },
      currentRuntimeInference: "not_permitted_from_historical_verification" as const,
      totalQuestionComplete: false, modelReadOrContextCommitProven: false,
      scope: "fully_reconstructed_actual_registered_reader_records_for_baseline_and_cited_successors" as const };
  }
}
