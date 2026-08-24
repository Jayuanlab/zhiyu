---
name: watchlist-selection-control
description: Use when a workshop agent is responsible for A-share paper-trading watchlist selection, candidate discovery, current watchlist review, add/remove/replace proposal creation, market-wide opportunity scanning, or post-close watchlist maintenance. This skill is for a watchlist selector, not a trading executor.
---

# Watchlist Selection Control

This skill turns the watchlist hunter into a bounded control system. The job is not to predict tomorrow's best stock. The job is to maintain a small, explainable, auditable candidate set that a separate paper trader can consume.

Use this for the `交易日收盘后自选股筛选` loop or any run that must discover candidates, review the current paper-trading watchlist, or create a watchlist-change proposal.

For research background and the synthesis behind these rules, read `references/methodology.md` when the run is about changing the method, diagnosing repeated selection failure, or explaining why a candidate was accepted/rejected.

## Control Philosophy

- Treat the watchlist as a state estimate, not a wish list.
- Separate observation, scoring, proposal, approval, and application.
- Prefer a smaller, higher-conviction list over a large noisy list.
- Do not chase the hottest theme unless market breadth, liquidity, relative strength, valuation/risk, and evidence quality support it.
- Do not keep a weak stock merely because it was selected before.
- Do not add a symbol that the paper trader cannot realistically observe or act on.
- Never trade. This skill may create a watchlist proposal only; owner review applies the change.

## Controlled Object

The controlled object is the paper-trading watchlist used by the paper trader.

Allowed control action:

- create a structured watchlist-change proposal through `quantPaperProposeWatchlistChange`.

Forbidden control actions:

- place or cancel paper orders,
- send external messages,
- directly edit the watchlist without a proposal,
- maintain positions or trading plans for the paper trader,
- use one data source failure as a reason to invent candidates.

## Required Observation Order

Call tools in this order when available and within budget:

1. `quantPaperGetWatchlist`
   - Read the current watchlist, quote snapshot, tags, quote time, data provider, and source detail.
   - Classify each current symbol before looking for replacements.
   - Stop concrete decisions if the watchlist snapshot is stale, empty, or internally inconsistent.

2. `workshopReadMemory` or `workshopSearchMemory`
   - Read prior selection rationale, rejected themes, source limitations, recurring mistakes, and active constraints.
   - Use `workshopGetMemoryEvidence` before relying on a high-impact or surprising memory.

3. `aStockMarketMood`
   - Classify the market regime and sector/theme breadth.
   - The watchlist should align with the current regime but must not simply mirror today's top movers.

4. `quantMarketDiscoverCandidates`
   - Discover market-wide candidates.
   - Use more than one theme or an intentionally broad theme when the task says not to limit to one sector.
   - Treat returned candidates as a noisy candidate pool, not as automatic additions.

5. `aStockQuote`
   - Refresh any candidate that may enter a proposal.
   - Refresh any current watchlist symbol that may be removed.

6. `aStockSignals`
   - Check fund flow, theme/sector relation, relative strength, turnover, risk flags, and source quality.
   - Treat source degradation, identical fallback pools, or missing fund-flow fields as explicit uncertainty.

7. `aStockFundamentals`
   - Use for candidates that survive price/volume and signal checks.
   - Do not require perfect fundamentals for every tradeable candidate, but reject obvious quality traps when risk is visible.

8. `aStockNewsAndFilings`
   - Use for candidates proposed for addition and current symbols proposed for removal when tool budget permits.
   - News is supporting evidence only; rumors, promotional articles, and stale headlines lower confidence.

9. `quantRuleEvaluate`
   - Use before concluding that a candidate crossed, failed, or stayed inside any numeric threshold.
   - Batch price, turnover, relative-strength, drawdown, position-overlap, and replacement-score checks when possible.

## Numeric Rule Discipline

Before concluding that any watchlist add/remove/replace/observe decision passed or failed a numeric threshold, batch the comparisons and call `quantRuleEvaluate`.

- Do not compare prices, stop lines, turnover, ranking thresholds, score cutoffs, drawdown limits, or concentration caps in prose.
- Every `candidatePool[]` entry with `add`, `reject`, or `observe` because of a numeric condition must include `ruleEvidence` with `tool: "quantRuleEvaluate"`, `ruleId`, `actual`, `operator`, threshold or range, `triggered`, and `comparisonText`.
- Every `currentWatchlistReview[]` entry with `replace_candidate` or `remove_candidate` because of a numeric condition must include the same `ruleEvidence`.
- If rule evidence is missing, mark the decision as `observe_pending_rule_check` instead of creating a proposal.

## Market Regime Model

Assign exactly one state:

`risk_off`
- Broad market weak, hot themes collapsing, liquidity poor, drawdown pressure high, or major data sources degraded.
- Output: mostly remove/hold/observe. Add only exceptional defensive or relative-strength names.

`rotation`
- Index mixed, themes rotating, leadership unstable, or candidates show conflicting evidence.
- Output: keep watchlist small; prefer partial replacement and short observation windows.

`risk_on`
- Breadth, liquidity, leaders, and theme participation are aligned.
- Output: allow additions, but still require evidence and explicit invalidation.

`unknown`
- Data freshness, provider quality, or source agreement is insufficient.
- Output: no proposal unless the proposal reduces risk and evidence is clear.

## Current Watchlist Review

Classify every current watchlist symbol into one bucket:

- `core_keep`: strong relative strength, acceptable liquidity, still fits the control objective.
- `conditional_keep`: useful but requires a future trigger, evidence refresh, or next-run verification.
- `replace_candidate`: weaker than available alternatives or no longer fits current market structure.
- `remove_candidate`: broken thesis, stale reason, persistent underperformance, serious data/news/fund-flow risk, or outside mission.
- `protected`: cannot remove because it is held, has open paper orders, or is needed by another active boundary.

Removal requires at least two independent reasons unless a hard boundary applies:

- current paper position or open order protection does not allow removal,
- data has become untrustworthy for that symbol,
- thesis invalidated by price/volume, sector, news, or fundamentals,
- relative strength has failed compared with both market and its sector,
- the symbol duplicates exposure already represented better by another symbol.

## Candidate Admission Gates

A candidate may enter an add proposal only if all gates pass:

- Data gate: current quote, candidate source, and at least one corroborating signal are fresh enough.
- Liquidity gate: turnover and tradability fit the paper account and A-share lot constraints.
- Relative-strength gate: stronger than market and preferably stronger than its sector peers.
- Theme gate: belongs to a real market line, not merely a label returned by a fallback pool.
- Structure gate: not obviously extended, not in a disorderly downtrend, and has a clear invalidation level.
- Risk gate: no visible filing/news/fund-flow red flag that overwhelms the thesis.
- Diversity gate: improves the watchlist rather than duplicating an existing exposure.
- Usefulness gate: the paper trader can convert it into a concrete observation or simulated trading plan.

Reject or observe if:

- the only reason is "hot today",
- the provider returns the same fallback pool across unrelated themes,
- PE/ROE/industry fields are zero or missing without explanation,
- the stock is ST, illiquid, suspended, near delisting risk, or has obvious abnormal data,
- the risk cannot be named,
- the candidate would make the watchlist too concentrated in one theme.

## Portfolio Shape Rules

Maintain a watchlist that is small enough to supervise.

Recommended structure:

- 4-8 core focus symbols.
- 2-4 reserve candidates.
- No more than 40% of names from one narrow theme unless the owner explicitly requests a thematic list.
- Keep ETFs only when they express a theme more cleanly or lower single-stock risk.
- Prefer one best representative per theme unless candidates serve different roles.

Role labels:

- `leader`: strongest representative of a theme.
- `turnaround_watch`: improving but not confirmed.
- `defensive_watch`: lower-volatility stabilizer or ETF.
- `event_watch`: catalyst-driven; requires expiry date or event date.
- `risk_watch`: kept only because removal is blocked or pending verification.

## Proposal Rules

Default output is `no proposal` unless a concrete change improves the watchlist.

Create `quantPaperProposeWatchlistChange` in the same run when:

- at least one add or remove decision is concrete,
- evidence is current enough,
- the reason includes both supporting evidence and opposing risk,
- the change does not remove held positions or symbols with open orders,
- the result is not a duplicate of a pending proposal.

Proposal payload principles:

- `add`: only symbols that passed admission gates.
- `remove`: only symbols that passed removal rules, are not protected, and are present in the latest current active watchlist snapshot from `quantPaperGetWatchlist` in this same run.
- `keep`: protected or high-conviction names that should remain.
- `reason`: explain the watchlist-level improvement, not just individual stock appeal.
- `strategyFit`: describe the market regime, role mix, and how the paper trader should use the new list.
- `risk`: include data-source limitations, concentration, timing, and false-breakout risk.
- `evidenceSourceEventIds`: include source event ids from candidate discovery, watchlist read, quote/signal/news checks when available.

Candidate-pool-only cleanup is not a watchlist-change proposal. If a stale or weak symbol is only in the candidate pool, record it as candidate maintenance with `workshopLogEvent` or `watchlistFollowupTaskUpsert` instead of passing it to `quantPaperProposeWatchlistChange.remove`.

Do not create a proposal when:

- discovery returned a low-diversity fallback pool,
- every candidate is weaker than the current list,
- data is stale or contradictory,
- proposed changes are cosmetic,
- the run cannot explain what the paper trader should do differently tomorrow.

## Required Visible Output

Before finishing, call `workshopLogEvent` with these exact title prefixes:

- `marketScanSummary: ...`
- `currentWatchlistReview: ...`
- `candidatePool: ...`
- `watchlistDecision: ...`
- `riskAssessment: ...`

The final response must include a `<structured-output>` JSON object with these exact top-level keys:

```json
{
  "marketScanSummary": "market regime, breadth, themes, source freshness and provider warnings",
  "currentWatchlistReview": [
    {
      "code": "000000.SZ",
      "name": "example",
      "bucket": "core_keep|conditional_keep|replace_candidate|remove_candidate|protected",
      "reason": "evidence-based reason"
    }
  ],
  "candidatePool": [
    {
      "code": "000000.SZ",
      "name": "example",
      "role": "leader|turnaround_watch|defensive_watch|event_watch|risk_watch",
      "decision": "add|observe|reject",
      "support": "supporting evidence",
      "opposition": "opposing evidence or missing data"
    }
  ],
  "watchlistDecision": {
    "action": "proposal_created|no_change|observe_only|blocked",
    "add": [],
    "remove": [],
    "keep": [],
    "proposalEventId": null,
    "reason": "why this is the correct bounded action"
  },
  "riskAssessment": "main market, data, concentration, timing and false-signal risks"
}
```

## Memory Rules

Use `workshopWriteMemory` for reusable selection state:

- stable selection rule,
- rejected or confirmed candidate rationale,
- repeated data-provider limitation,
- theme rotation lesson,
- proposal outcome lesson,
- mistake that future runs must avoid.

Do not write memory for routine candidate lists that have no reusable lesson. Use log events for routine observations.

## Failure Handling

If a required source fails:

- log the provider and failure detail,
- downgrade market state to `unknown` when the failure affects selection,
- avoid proposal unless it clearly reduces risk,
- write a source-note memory if the same provider issue repeats.

If `quantMarketDiscoverCandidates` returns the same fallback pool across different themes:

- log `candidatePool: fallback diversity warning`,
- run at most one alternate discovery attempt,
- do not add candidates solely from the fallback pool,
- prefer reviewing current watchlist and recording the source limitation.

If the proposal tool is unavailable or approval-gated:

- log `watchlistDecision: proposal blocked`,
- include the intended add/remove/keep sets in structured output,
- do not claim the watchlist changed.
