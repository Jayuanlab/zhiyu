# AgentHarness source audit: Pi 0.85.1

Reviewed 2026-09-15, release commit d981de1229ef899957bbe968bc8dcda02a21f477. This is a bounded source/test inspection, not a full security audit or production certification. No packages installed, tests executed, live state touched, or business code changed by this investigation. Any separate parent runtime probe is independent evidence.

## Assessment

AgentHarness has substantive recovery and execution machinery and merits an isolated prototype. It should not yet replace Zhiyu's runtime wholesale. The strongest integration blockers are storage ownership across workers, uncertain external side effects, fail-open non-tool hooks, and an unimplemented session-wide watch API. None establishes that ordinary single-owner runs are unusable; each needs an explicit host boundary.

## Verified positive behavior

Tool recovery defaults to replay never. Reexecution requires both the persisted invocation and the currently registered tool to declare replay safe. Otherwise interrupted work is materialized as an error with its latest durable progress and an explicitly unknown external outcome. Persisted arguments, invocation memos and progress checkpoints support recovery. These are useful foundations for idempotent tools, not a universal exactly-once guarantee. [Tool driver](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/tools.ts)

Orphaned assistant generation is settled from the committed partial-frame prefix without issuing another provider call. Recovery warns that newer live output and the external outcome may be unknown; synthetic recovery usage is zero, so it must not be mistaken for proof that the interrupted external request had no billable usage. [Generation recovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/recovery.ts)

The effect gate prevents admission of new work after cancellation begins and propagates an abort signal. This controls admission and cooperative cancellation; an already admitted external action may still have occurred. [Effect gate](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/execution/effect-gate.ts)

## Storage constraints

JSONL storage serializes commits on an instance-local promise queue. Each transaction occupies one line; state is applied in memory after append succeeds. Reopening validates complete transactions, drops an unterminated final line, and rejects malformed complete/interior lines. Snapshot publication uses a temporary file and rename. These cover torn-tail recovery, but do not establish cross-process exclusion or power-loss durability. [Storage implementation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/storage.ts)

The repository guards open sessions through an instance-local map. The inspected path has no cross-process lock or fencing token. Repository close contains an ownership TODO and does not automatically close open session handles. Therefore workers must not independently open the same session file without host ownership enforcement; lifecycle cleanup must explicitly close handles. A shared transactional storage adapter is another candidate, subject to conformance tests. [JSONL repository](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/jsonl/repo.ts)

NodeExecutionEnv appends using the standard filesystem API without an explicit fsync. It checks abort again after append, allowing a reported abort after bytes have been written. Treat write failures as potentially uncertain outcomes and reopen/reconcile rather than blindly reuse stale in-memory sequence state. This is a source-derived risk, not a reproduced corruption claim. [Node environment](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/env/nodejs.ts)

## Hook and observation boundaries

before_tool handler failure is reported and blocks the call. By contrast, transform_context, before_request and before_payload handler failures are reported while processing continues. Consequently mandatory tenant isolation, memory authorization or redaction must not depend solely on a throwing transform hook; enforce such constraints in host data selection/provider boundaries with explicit failure behavior. [Hook aggregation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/hooks.ts)

The concrete Harness.watchSession implementation throws SliceNotImplemented. Lane-level watch/snapshot mechanisms exist but are a different surface. An application needing session-wide updates must adapt its event stream or aggregate lanes explicitly and test subscription recovery. [Harness implementation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/harness.ts), [lane implementation](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/lane.ts)

## Test evidence inspected

The repository has storage and session-repository conformance suites, JSONL migration/torn-tail cases, execution gate tests, tool replay/recovery, cancellation and driver restore tests. Tool cases specifically cover safe replay versus unsafe interruption, restored cancelled batches, outcome-ready recovery without executing tools, and durability before cancellation outcome publication. JSONL tests cover complete transaction replay, interrupted-tail removal and rejecting malformed interior lines. Tests were read, not run; their presence does not prove behavior in Zhiyu's PostgreSQL/worker/desktop deployment. [Tool recovery tests](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/harness/runtime/drive-tools.test.ts), [JSONL tests](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/test/harness/jsonl-storage.test.ts), [conformance suites](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/testing/conformance)

## Required prototype gates

1. Prove one owner per session across worker restart, lease expiry and duplicate delivery; otherwise supply fenced transactional storage.
2. Kill a run before/after an external action and before/after result commit; confirm unsafe actions do not silently replay and unknown outcomes remain visible.
3. Exercise allowed/denied/throwing authorization, context selection and redaction paths; prove failures cannot expose data or enable tools.
4. Confirm cancellation closes admission while late results are recorded without false success or automatic repetition.
5. Map run/lane/operation IDs to Zhiyu events, Brain provenance and desktop status; test reconnect and session-watch alternatives.
6. Run relevant upstream conformance tests plus focused Zhiyu integration probes. Retain a rollback path and current runtime until these gates pass.

Supported conclusion: promising implemented building blocks for controlled adoption. Unknown: production maturity under multi-worker contention, exactly-once business effects, long-term upgrade compatibility, power-loss durability and desktop integration quality.
