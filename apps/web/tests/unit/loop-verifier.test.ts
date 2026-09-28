import { describe, expect, it } from "vitest";
import { verifyLoopRun } from "@/lib/loops";
import { parseStructuredOutput } from "@/lib/types/execution-result";

describe("loop verifier", () => {
  it("preserves custom structured output fields for verifier contracts", () => {
    const parsed = parseStructuredOutput(
      [
        "Done",
        "<structured-output>",
        JSON.stringify({
          summary: "Completed",
          marketScanSummary: "Market scan completed.",
          watchlistDecision: "No change.",
        }),
        "</structured-output>",
      ].join("\n"),
    );

    expect(parsed.data.marketScanSummary).toBe("Market scan completed.");
    expect(parsed.data.watchlistDecision).toBe("No change.");
  });

  it("parses the final fenced JSON block when the model omits structured-output tags", () => {
    const parsed = parseStructuredOutput(
      [
        "Done",
        "```json",
        JSON.stringify({
          summary: "Completed",
          accountState: "Account reviewed.",
          trendFollowDecision: {
            marketState: "mixed",
            candidateDecisions: [
              {
                code: "159278.SZ",
                decision: "hold",
                nextVerification: "next loop",
              },
            ],
          },
        }),
        "```",
      ].join("\n"),
    );

    expect(parsed.cleanText).toBe("Done");
    expect(parsed.data.accountState).toBe("Account reviewed.");
    expect(parsed.data.trendFollowDecision).toMatchObject({
      marketState: "mixed",
    });
  });

  it("does not pass trend verification when fenced JSON only contains prose", () => {
    const parsed = parseStructuredOutput(
      [
        "Done",
        "```json",
        JSON.stringify({
          summary: "Completed",
          trendFollowDecision: "Hold because trend is unclear.",
        }),
        "```",
      ].join("\n"),
    );

    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: parsed.cleanText,
        duration: 10,
        result: {
          structuredReport: parsed.data,
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_trend_follow_decision",
        }),
      ]),
    );
  });

  it("passes legacy status verification for successful jobs", () => {
    const result = verifyLoopRun({
      verificationConfig: { type: "legacy_status" },
      result: {
        status: "success",
        output: "Done",
        duration: 10,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.type).toBe("legacy_status");
    expect(result.issues).toEqual([]);
  });

  it("passes structured checks when fields and sources are present", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["summary", "reasoningChain"],
        requiredSources: ["jira", "memory"],
      },
      result: {
        status: "success",
        output: "Risk is medium",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Risk is medium",
            reasoningChain: [
              {
                summary: "Checked Jira",
                sourceType: "jira",
              },
              {
                summary: "Checked memory",
                sourceType: "memory",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.evidence.observedSources).toEqual(["jira", "memory"]);
  });

  it("fails structured checks when required evidence is missing", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["riskLevel"],
        requiredSources: ["insight"],
      },
      result: {
        status: "success",
        output: "Done",
        duration: 10,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing_required_field",
      "missing_required_source",
    ]);
  });

  it("uses execution trace tool calls as required source evidence", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["wechatDesktopSendMessage"],
      },
      result: {
        status: "success",
        output: "Sent",
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName: "mcp__business-tools__wechatDesktopSendMessage",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.evidence.observedSources).toContain(
      "wechatDesktopSendMessage",
    );
  });

  it("does not accept prose as evidence for a required tool-like source", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["watchlistFollowupTaskList"],
      },
      result: {
        status: "success",
        output: "watchlistFollowupTaskList 已读取，后续任务为空。",
        duration: 10,
        result: {
          structuredReport: {
            reasoningChain: [
              {
                summary: "watchlistFollowupTaskList 已读取",
                sourceType: "watchlistFollowupTaskList",
              },
            ],
          },
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName: "workshopSearchMemory",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_required_source",
          message:
            'Required source "watchlistFollowupTaskList" was not observed',
        }),
      ]),
    );
  });

  it("passes tool-like required source checks only when the tool was actually observed", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["watchlistFollowupTaskList"],
      },
      result: {
        status: "success",
        output: "后续任务已读取。",
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName: "watchlistFollowupTaskList",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
  });

  it("recognizes workshop and quant source aliases from output headings and tools", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["操盘交易员", "自选股猎手", "量化工作台"],
      },
      result: {
        status: "success",
        output: [
          "### 操盘交易员车间",
          "今日无新增模拟盘操作。",
          "### 自选股猎手车间",
          "今日保留观察池。",
        ].join("\n"),
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName: "mcp__workshop-tools__quantPaperGetWatchlist",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.evidence.observedSources).toEqual(
      expect.arrayContaining([
        "操盘交易员车间",
        "自选股猎手车间",
        "量化工作台",
      ]),
    );
  });

  it("recognizes video generation tool calls as model source evidence", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["video_generation_model"],
      },
      result: {
        status: "success",
        output: "Video generated.",
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName:
                  "mcp__workshop-tools__videoRenderInvestmentBrief",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.evidence.observedSources).toContain(
      "video_generation_model",
    );
  });

  it("observes required fields from markdown headings and tool event titles", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: [
          "marketScanSummary",
          "currentWatchlistReview",
          "candidatePool",
          "watchlistDecision",
        ],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: [
          "### marketScanSummary",
          "Market scan completed.",
          "### currentWatchlistReview",
          "Watchlist reviewed.",
        ].join("\n"),
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                title: "candidatePool: 全市场候选Top 10",
                detail:
                  '{"title":"watchlistDecision: 移除中科曙光，加入药明康德"}',
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.evidence.observedFields).toEqual(
      expect.arrayContaining([
        "marketScanSummary",
        "currentWatchlistReview",
        "candidatePool",
        "watchlistDecision",
      ]),
    );
  });

  it("passes trend follow decision checks when each candidate has an order or blocker", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: "Trend decision completed.",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Trend decision completed.",
            trendFollowDecision: {
              marketState: "mixed",
              candidateDecisions: [
                {
                  code: "159278.SZ",
                  lifecycleState: "break_warning",
                  controlAction: "reduce_watch",
                  decision: "tighten_stop",
                  profitState: "positive",
                  profitProtection:
                    "Keep core position, tighten trailing stop, no add.",
                  nextVerification: "next intraday check",
                  ruleEvidence: {
                    tool: "quantRuleEvaluate",
                    ruleId: "159278_profit_protection",
                    triggered: false,
                    comparisonText: "0.991 < 0.990 is false",
                  },
                },
                {
                  code: "300124.SZ",
                  lifecycleState: "breakout_confirmed",
                  decision: "buy_blocked",
                  blockedReason: "Price is above plannedPrice * 1.02.",
                  ruleEvidence: {
                    tool: "quantRuleEvaluate",
                    ruleId: "300124_buy_deviation",
                    triggered: true,
                    comparisonText: "63.3 > 62.22 is true",
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(result.passed).toBe(true);
  });

  it("fails trend follow decision checks when an executable action has no order or blocker", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: "Trend decision completed.",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Trend decision completed.",
            trendFollowDecision: {
              marketState: "risk_on",
              candidateDecisions: [
                {
                  code: "300124.SZ",
                  lifecycleState: "breakout_confirmed",
                  decision: "buy",
                },
              ],
            },
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_trend_follow_decision",
        }),
      ]),
    );
  });

  it("fails trend follow decision checks when break warnings are not handled", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: "Trend decision completed.",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Trend decision completed.",
            trendFollowDecision: {
              marketState: "mixed",
              candidateDecisions: [
                {
                  code: "159278.SZ",
                  lifecycleState: "break_warning",
                  controlAction: "reduce_watch",
                  decision: "hold",
                  nextVerification: "next intraday check",
                },
              ],
            },
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "invalid_trend_follow_decision",
    });
  });

  it("fails trend follow decision checks when numeric decisions lack rule evidence", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: "Trend decision completed.",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Trend decision completed.",
            trendFollowDecision: {
              marketState: "risk_on",
              candidateDecisions: [
                {
                  code: "000977.SZ",
                  decision: "buy_blocked",
                  blockedReason: "price_breakdown: 77.66 < 77.61",
                  invalidation: "77.61",
                  actualPrice: 77.66,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_numeric_rule_evidence",
        }),
      ]),
    );
  });

  it("passes blocked numeric trend decisions with quantRuleEvaluate evidence", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: ["trendFollowDecision"],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: "Trend decision completed.",
        duration: 10,
        result: {
          structuredReport: {
            summary: "Trend decision completed.",
            trendFollowDecision: {
              marketState: "risk_on",
              candidateDecisions: [
                {
                  code: "000977.SZ",
                  decision: "buy_blocked",
                  blockedReason: "price_breakdown rule did not trigger.",
                  invalidation: "77.61",
                  actualPrice: 77.66,
                  ruleEvidence: {
                    tool: "quantRuleEvaluate",
                    ruleId: "000977_buy_invalid_line",
                    actual: 77.66,
                    operator: "<",
                    threshold: 77.61,
                    triggered: false,
                    comparisonText: "77.66 < 77.61 is false",
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(result.passed).toBe(true);
  });

  it("fails a required WeChat delivery when only weather search ran", () => {
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredSources: ["wechatDesktopSendMessage"],
      },
      result: {
        status: "success",
        output: "北京天气预报已查询",
        duration: 10,
        result: {
          executionTrace: {
            events: [
              {
                type: "tool_used",
                toolName: "mcp__business-tools__searchUnifiedMemory",
              },
            ],
          },
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_required_source",
          message:
            'Required source "wechatDesktopSendMessage" was not observed',
        }),
      ]),
    );
  });

  it("fails any verification when the execution failed", () => {
    const result = verifyLoopRun({
      verificationConfig: { type: "legacy_status" },
      result: {
        status: "error",
        error: "Agent failed",
        duration: 10,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "job_failed",
      severity: "error",
    });
  });
});
