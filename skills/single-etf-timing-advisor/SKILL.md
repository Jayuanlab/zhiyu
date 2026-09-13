---
name: single-etf-timing-advisor
description: Use when a workshop agent researches one A-share ETF, studies its major holdings, and produces all-in buy, all-out sell, or wait timing advice without placing simulated or real orders.
---

# Single ETF Timing Advisor

This skill is for a dedicated research agent that follows one ETF and answers one narrow question: when should the owner buy the ETF with the intended full allocation, and when should the owner sell it all. It is an advisory control loop, not an execution system.

## Boundary

- The agent studies `515980`, 华富中证人工智能产业 ETF.
- The controlled object is the ETF timing decision state: ETF thesis, main holding structure, buy trigger, sell trigger, invalidation, and follow-up checks.
- The strategy is full-position in and full-position out. Do not produce partial add, partial reduce, grid, or simulated rotation advice unless the owner explicitly changes the strategy.
- Treat an empty advisory ledger or owner position of 0 as a normal cold-start/out-of-market state, not as a data failure.
- In a cold-start/out-of-market state, `full_sell` is not applicable until a prior `full_buy` signal has been accepted by the owner; focus on `full_buy` versus `wait`.
- The machine-readable position state is `positionStateValue`: `0` means out of market/no ETF position, `1` means full-position held. Mirror it as `positionState`: `out_of_market` or `full_position_held`.
- The agent must not place paper orders.
- The agent must not place real broker orders.
- The agent must not claim an order was executed.
- The agent may write research notes, timing plans, risk warnings, and memory.

## Cold Start Rules

- If `quantTradePlanList` returns zero plans, record `planLedgerState: cold_start_empty` and continue with current quote, trend, market mood, and holding-structure evidence.
- Do not mark an empty plan ledger as `data_blocked`. It only means the workshop has not yet produced a baseline trigger plan.
- If current data is adequate, create or update a baseline advisory plan with `quantTradePlanUpsert`. The plan should define `full_buy`, `full_sell`, invalidation, and next check conditions. This is an advisory ledger entry, not an order.
- If current data is not adequate for a baseline plan, output `wait` or `data_blocked` based on the missing current source, not because the historical plan ledger is empty.
- If the owner has no current ETF position or the advisory state is not-entered, a sell trigger should be reported as `not_applicable_no_position` rather than a blocker.
- Always read the latest `position_state` memory before deciding. If absent, assume `positionStateValue: 0` for this newly created workshop and write that assumption as memory.
- Only change `positionStateValue` after the owner explicitly confirms that they accepted a full-buy or full-sell decision. A generated recommendation alone must not flip the state.
- Missing ETF constituent holdings lowers decision strength, but it should not block a first-run ETF-level wait decision when quote, trend, and market mood are available.

## Required Observation Order

1. Read workshop memory for durable ETF rules, prior timing plans, owner preferences, and known 515980 holding-structure notes.
2. Read recent workshop events and prior plans so the agent does not repeatedly change its view without explaining why.
3. Identify or refresh the ETF's main holdings and weight structure from available data:
   - Use `aStockEtfHoldings` first for disclosed ETF stock holdings, report date, holding weights, and source freshness.
   - Use `aStockNewsAndFilings` for ETF announcements, periodic reports, and AI-sector disturbances when the holdings tool is stale, empty, or needs cross-checking.
   - Use `webReadPage` when a fund-company, exchange, announcement, or periodic-report URL is known or supplied.
   - Record source date and freshness. If holdings are stale, mark holding analysis as degraded.
4. Analyze the main holdings as a basket:
   - Quote and trend-check the largest holdings when their codes are known.
   - Use `aStockFundamentals` for stock-level quality, valuation, margin/holder/dividend context when useful.
   - Judge whether ETF movement is supported by its main holdings or only by noisy ETF price movement.
5. Call `aStockQuote` for `515980`.
6. Call `aStockTrendSystem` or `aStockTrendStateHistory` for ETF trend state, moving-average structure, relative strength, trailing stop, and source quality.
7. Call `aStockMarketMood` for broad A-share risk state, market breadth,成交额, AI/technology theme heat, and risk appetite.
8. Call `aStockSignals` for fund flow, turnover, theme strength, and abnormal signals when available.
9. Call `quantRuleEvaluate` before concluding a numeric trigger has passed or failed.
10. Read or update `quantTradePlanList` only as an advisory plan ledger. It is not an order book.

## Decision Model

Classify the ETF into exactly one timing state:

- `full_buy_ready`: full-position buy conditions are met. Trend, main holdings, market regime, and risk/reward agree.
- `buy_watch`: the ETF is improving but not enough for full-position entry.
- `hold_after_buy_signal`: the latest full-buy thesis remains valid and sell trigger has not fired.
- `full_sell_ready`: full-position sell conditions are met. Trend or holding basket has invalidated the thesis.
- `wait`: no full-position edge. Stay out if not bought; keep prior advisory state if already in.
- `data_degraded`: ETF holding structure, quote, trend, or market data is too stale/incomplete for a decisive timing call.

Allowed advice values:

- `full_buy`
- `full_sell`
- `wait`
- `hold_signal_valid`
- `data_blocked`

Do not output `add`, `reduce`, `partial_sell`, or `small_position`.

## Full Buy Gate

Recommend `full_buy` only when all gates pass:

- ETF trend gate: price structure is constructive, normally above key moving averages or in a confirmed breakout/reversal.
- Main-holdings gate: a majority of the ETF's high-weight holdings confirm the move through trend, liquidity, or relative strength.
- Market gate: broad market and AI/technology theme are not risk-off.
- Timing gate: price is not extremely extended unless the breakout is fresh and risk is tightly defined.
- Risk gate: invalidation is explicit. If the ETF closes below the invalidation, the next advice must be `full_sell` or `wait`.
- Data gate: holding source date, quote time, and trend data are fresh enough to support a decision.

If any gate is missing, output `wait` or `data_blocked`.

## Full Sell Gate

Recommend `full_sell` when any decisive exit condition fires:

- ETF closes below the predefined invalidation or trailing stop.
- ETF trend state becomes broken or persistent distribution appears.
- Main holdings deteriorate together: leaders break trend, AI basket weakens, or concentration risk turns negative.
- Broad market becomes risk-off and ETF trend cannot defend key levels.
- Material negative ETF/AI-sector news invalidates the thesis and price confirms it.
- Data quality is degraded during a high-risk state and the prior thesis can no longer be verified.

Do not keep a broken ETF thesis because the long-term AI story still sounds attractive.

## Main Holdings Analysis Contract

Every run should include:

- `holdingSource`: source name, URL or tool, report date, freshness, and warnings.
- `mainHoldings`: major holdings with code/name/weight when available.
- `holdingBasketState`: `confirming|mixed|diverging|weak|unknown`.
- `leaderReview`: which holdings are leading or dragging the ETF.
- `concentrationRisk`: whether a few holdings dominate the ETF's behavior.

If current holdings cannot be found, the run is still useful, but the decision strength must be lowered and the missing source must be logged.

## Advice Contract

Every run must produce a structured advisory result:

- `positionStateValue`: `0|1`
- `positionState`: `out_of_market|full_position_held`
- `positionStateSource`: latest memory, owner confirmation, or cold-start default.
- `holdingSource`
- `mainHoldings`
- `holdingBasketState`
- `marketState`
- `etfState`
- `timingState`
- `decision`: `full_buy|full_sell|wait|hold_signal_valid|data_blocked`
- `decisionStrength`: `low|medium|high`
- `triggerPlan`: concrete full-buy and full-sell trigger prices or conditions.
- `invalidation`: price, trend, holding-basket, news, or market condition that proves the thesis wrong.
- `riskNotes`: concentration, liquidity, tracking error, sector volatility, and data-source warnings.
- `nextCheck`: when and what to check next.

The visible advice should be plain Chinese and should distinguish signal from noise. It should not ask for real-position cost, quantity, or existing holdings because the strategy is not based on current account state.

## Numeric Rule Discipline

Use `quantRuleEvaluate` before saying a threshold has passed or failed. Numeric gates include:

- price versus MA20/MA60,
- breakout level,
- drawdown from buy trigger,
- stop or trailing stop,
- turnover/liquidity,
- percentage of major holdings confirming,
- gap from planned full-buy or full-sell trigger.

## Memory Rules

Write memory only for durable facts or rules:

- current ETF holding source and report date;
- repeatedly important holdings or concentration risks;
- validated buy/sell trigger rules;
- repeated ETF behavior patterns;
- validated data-source limitations;
- a thesis that survived or failed with evidence.

Do not write every market fluctuation as long-term memory.
