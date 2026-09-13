---
name: single-etf-position-advisor
description: Use only for legacy or explicit ETF position-state advisory loops that review one ETF position without placing simulated or real orders.
---

# Single ETF Position Advisor

This skill exists for legacy ETF position-state loops and explicit owner-approved position-review tasks. The current 515980 workshop strategy is handled by `single-etf-timing-advisor`; use this skill only when a loop is explicitly about historical/declared position state rather than generating the all-in/all-out timing plan.

## Boundary

- Study only the specified ETF and its declared position state.
- Treat `positionStateValue=0` as out of market and `positionStateValue=1` as full-position held.
- Do not infer real holdings, cost, quantity, or broker account state from missing data.
- Do not call simulated order tools.
- Do not call real broker or payment tools.
- Do not claim a buy or sell was executed.
- Only update durable position memory after the owner explicitly confirms that the position state changed.

## Workflow

1. Read workshop memory for the latest declared `positionStateValue`, source, and confirmation time.
2. Read the latest advisory plan or timing report if available.
3. Check current ETF quote, trend, market state, and major holding basket only to evaluate whether the declared position state remains reasonable.
4. If position state is unknown, report `position_unknown` and ask for owner confirmation instead of assuming a real holding.
5. If position state is out of market, sell checks are `not_applicable_no_position`.
6. If position state is full-position held, evaluate whether the existing sell trigger or thesis invalidation is active.

## Output Contract

Every run should report:

- `positionStateValue`
- `positionState`
- `positionStateSource`
- `etfState`
- `trendState`
- `holdingBasketState`
- `advisoryDecision`
- `ownerActionRequired`
- `riskNotes`
- `nextCheck`

Visible reports should be Markdown and should clearly separate observed facts, advisory judgment, and actions not taken.
