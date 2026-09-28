# Jev evidence checks for memory recall

## Objective and rollout

Improve complete, evidence-supported answers. The controlled object is the evidence supplied to the answering agent, not permission policy or the underlying facts. Local rollout begins in `BRAIN_JEV_MODE=shadow`. `off` removes provider calls; `active` enables the bounded behavior below. No credentials belong in tracked files. Restart an existing backend if it has not reloaded `.env.local`.

## Implemented behavior

- Shared evaluator: `apps/web/lib/brain/jev-evidence-check.ts`. Fixed official endpoint and pinned `jev-1.13.0`; no SDK dependency. Whole-question coverage plus explicit question/semicolon/newline segments; relevance per supplied evidence item. This is NOT full semantic decomposition.
- Provider input is post-permission evidence. Brain supplies selected memory content/freshness/references, not denied candidates. Platform supplies architecture and projected exact records, not grants or provider configuration. Credential patterns are redacted; this is not a comprehensive DLP system.
- Bounded input: 24 evidence items, 2,000 characters each, 24,000 total evidence characters, 3,000 per question, seven coverage questions. Truncation is explicit and prevents Brain coverage-driven retries.
- A two-second total deadline includes response parsing. Timeout, malformed response, missing configuration and HTTP failure produce an explicit degraded check and retain the existing retrieval path. No provider retries.
- Shadow mode retains original ordering and retry policy. Brain persists judgments in the existing owner-scoped recall audit, then removes scores from the returned trace. Platform retains structured tool details but excludes judgments from model-facing text.
- Active Brain mode can use the existing faithful alternate query once when coverage is below 0.35. Permission/filter/warning/source blocks take priority. Scope, time, confidence and source filters remain fixed. Results are deduplicated by ID; both snapshots are retained via context log IDs, and denied/omitted IDs are excluded from the union. This can include up to two original packs; it does not mutate stored memories. The cutoff is experimental, not calibrated accuracy.
- Active platform mode reorders returned architecture items without removing evidence. Coverage guidance evaluates architecture/exact records only. Follow-up remains the existing agent-directed, prompt-bounded mechanism; a turn-wide hard budget across tools is NOT implemented here.
- Existing desktop recall detail exposes check mode and degradation; the status is not a factual correctness certificate. Users can correct via the existing recall feedback flow. No automatic feedback-to-threshold tuning.

## Observations and limitations

Trace records provider, mode, status, safe failure reason, latency, pinned model, input hash, usage, truncation, coverage and evidence IDs. Raw provider error bodies and credentials are not logged. Source facts remain separate from judgments. Platform details use the existing tool trace; no new audit table.

Unimplemented later stages: semantic subquestion planning, choosing among multiple targeted rewrite candidates, turn-wide retry accounting across Brain and platform tools, evaluation of every live platform section, independent final-answer citation checking, automatic memory write/merge/delete decisions. Source freshness and missing adapters still require separate work.

## Verification and promotion gate

Run from `apps/web`:

```
pnpm exec vitest run tests/unit/jev-evidence-check.test.ts tests/unit/brain-query-retry.test.ts tests/unit/platform-recall.test.ts tests/unit/brain-service.test.ts tests/unit/brain-recall-retry-details.test.ts
pnpm exec tsc --noEmit --pretty false
node --import tsx scripts/check-jev-memory.mjs
```

The live smoke uses actual query-retry source code, asks one supported question and one unsupported database-count question, and saves `.runtime/evals/jev-memory/smoke.json`. It is not an answer-accuracy benchmark.

Do not promote local configuration to active solely from unit/smoke success. Compare fixed 100-question baseline and untouched new questions with the same data snapshot, answering model, timeout, and concurrency. Measure complete answer rate, factual errors, useful evidence loss, effective supplemental searches, p95 latency, timeouts and cost. Use independent judging and manual review of changed answers. No improvement percentage is claimed in this implementation stage.

### Recorded implementation checks

- 2026-09-22 local time: five targeted suites, 45 tests passed; TypeScript `--noEmit` passed.
- Live source-backed smoke: support 0.93 for the source-supported question (1,192 ms), 0.01 for the unsupported database-count question (696 ms). Both checks passed, no truncated evidence. Combined usage: 1,479 input / 120 output tokens.
- Local `.env.local` is Git-ignored and now specifies shadow mode. Existing running-process reload and full browser end-to-end behavior have not been verified in this stage. No 100-question accuracy rerun or active-mode promotion was performed.
