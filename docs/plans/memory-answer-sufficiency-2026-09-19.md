# Memory answer sufficiency improvement

## Objective and measurement

Optimize evidence-backed complete answers, not successful tool calls. The prior
100-question Pi run completed 82 requests but the model-assisted judge accepted
only 23 complete answers and 4 boundary answers (27/100). Partial answers: 10.
Keep this denominator, the original questions, and the original grading rubric.
Never ingest gold answers or evaluation corpus into runtime retrieval.

The existing questions mix live records with historical snapshot questions.
Current observations must not be relabeled as historical facts. Report this
evaluation limitation, provider failures, and incorrect answers separately.

## Observed failure and change

The gateway exposed recent lists, not record lookup. It removed Loop policies
and state fields; it interpreted any UUID as a Work ID. Source records for
approvals, events, observations and interaction-derived knowledge were absent.
Architecture results were sliced without relevance ranking.

The owner desktop chat gateway now has three read paths:

1. Exact IDs or quoted entity names -> fixed, explicitly projected source
   adapters -> at most one provenance hop. Every query independently checks
   authenticated ownership through direct user columns or parent ownership.
2. Count questions -> owner-filtered GROUP BY counts, independent of list limits.
   Only aggregate dimensions are selected, including model enabled status;
   credentials and raw configuration are excluded.
3. Architecture questions -> existing source-backed catalog, lexical ranking
   before truncation, explicit candidate limit and response truncation.

Exact evidence suppresses broad Work/Loop/Brain list payloads. The answer policy
requires coverage of all requested facts, source IDs, explicit null/empty
semantics, and distinction between entity state, run state and event claims.
Insufficient answers may trigger one narrower follow-up, not repeated identical
queries. Returned content remains untrusted evidence, never instructions.

## Control model and boundaries

- Controlled output: completeness and correctness of owner-visible answers.
- Observations: immutable source records and timestamped live reads; source
  failures are observable, never silently interpreted as empty results.
- State: original operational DB plus existing Brain catalog; no evaluation
  answers are persisted as memory, and no runtime source data is rewritten.
- Actions: read-only bounded queries; no external messages, memory writes,
  approvals, scheduling changes or Work configuration updates.
- Isolation: only authenticated owner desktop chat may use this gateway. It is
  not a replacement for grant-checked cross-Work recall. Parent and related
  records are independently owner-checked; no arbitrary SQL, table or file access.
- Feedback: unit regression results, raw Pi tool events, per-question answers,
  judge reasons and before/after outcomes remain inspectable in eval artifacts.
- Recovery: retain successful evidence on partial source failure and disclose
  missing sources. User can correct the target name/ID or re-query fresh state.
  There is no autonomous control action to approve or roll back.
- User surface: existing desktop chat with evidence references and limitations;
  no new page or mobile work is required.

## Validation

- Regression reproduced: a relevant architecture item after an irrelevant item
  was lost at limit=1. The test failed before ranking and passed afterward.
- Exact record, child-vs-parent status, provenance expansion, quoted names,
  no-identifier no-op and partial-source failure regressions are covered.
- All 52 relevant tests across five suites pass; TypeScript checking passes.
- Real PostgreSQL check: 61 of 62 identifier questions resolve source records;
  all registered projections and 13 aggregate sources read successfully.
  Foreign-owner checks cover parent-scoped runs, notes, diagnostics, chat messages
  and aggregates, all returning zero records. A real named-entity query without
  an ID also passes. This is source coverage, not accuracy.
- Eight representative Pi HTTP questions completed with one tool call each.
- Full 100-question rerun and semantic grading are complete (results below).

## Measured result

The candidate ran through the real desktop Pi HTTP endpoint in development mode,
with platformRecall as its only allowed tool. All 100 original questions were
retained. No answer retries were merged into the result. A failed judge-network
request for the last ten questions was retried; the other 90 grades were cached.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Sufficient, including boundary cases | 27/100 | 86/100 |
| Factual complete, excluding five boundary cases | 23/95 | 81/95 |
| Partial answers | 10 | 4 |
| Incorrect answers | 5 | 2 |
| Insufficient answers, including execution failures | 57 | 8 |
| Correct boundary handling | 4/5 | 5/5 |
| Requests completed | 82/100 | 96/100 |

The primary metric improved by 59 percentage points. Sixty-three questions became
sufficient; four previously sufficient questions regressed. Two are now partial,
one is incorrect, and one timed out. The result is not uniformly better per case.

Baseline: `pi-run-2026-09-19T05-43-36-390Z`.
Candidate: `pi-run-2026-09-19T07-10-01-270Z`.
Both are under `.runtime/evals/platform-memory-real-100/2026-09-19T04-07-03-002Z/`.
The candidate directory contains raw per-question events, `pi-answer-judge/`,
and `answer-comparison.json` with every improvement, regression and remaining
failure plus runtime source hashes.

Remaining non-sufficient cases:

- Provider request timeouts: REAL-002, REAL-092, REAL-098, REAL-100.
- Partial coverage: REAL-043, REAL-082, REAL-093, REAL-099.
- Incorrect architecture interpretation: REAL-086, REAL-088.
- Missing simulation data adapters: REAL-058, REAL-073, REAL-074.
- Missing implementation evidence: REAL-089.

Candidate request concurrency was two, versus one in the baseline. This is a
before/after answer-quality result, not a controlled performance experiment.
Model-assisted scoring has not been manually verified for all 100 cas
REAL-027 grounding defect described below is not captured by the headline score.

Reproduction commands, from apps/web:

```text
pnpm exec vitest run tests/unit/platform-recall.test.ts tests/unit/platform-record-reader.test.ts tests/unit/native-pi-web-chat-tools.test.ts --coverage.enabled=false
pnpm exec tsc --noEmit --pretty false
node --import tsx --conditions=react-server scripts/check-platform-record-recall.mjs
node scripts/run-pi-memory-eval.mjs --tools=platformRecall --concurrency=2
node --import tsx --conditions=react-server scripts/judge-pi-memory-answers.mjs <run-folder>
```

## Remaining limits

- Non-UUID composite simulation fill references are not resolved by this reader.
- Historical counts cannot be reconstructed from mutable current tables alone.
- Natural-language entity resolution supports exact quoted names, not arbitrary
  semantic matching or unnamed ordinal references.
- Architecture candidate retrieval still has a 100-row window; ranking is
  lexical, not semantic, and does not expand complete source files.
- Provider timeouts remain independent of source retrieval.
- Large individual source fields do not yet have a token-budgeted paging API.
- Manual review found REAL-027 inferring a missing heartbeat table from an empty
  name search. Correctness grading alone does not establish evidence faithfulness;
  a typed collection-status reader and an evidence-grounding check remain needed.
- This benchmark informed development and is not an unseen generalization test.
  Future work should freeze source snapshots separately, add held-out paraphrases,
  test cross-user and cross-Work boundaries, and manually review judge decisions.
