import { describe, expect, it } from "vitest";
import {
  buildReportQualityOpenAiCompatibleHeaders,
  parseReportQualityLlmReview,
} from "@/lib/work-evolution/report-quality-evaluator";

describe("report quality evaluator", () => {
  it("adds an OpenCode Go session header for OpenAI-compatible requests", () => {
    const headers = buildReportQualityOpenAiCompatibleHeaders({
      apiKey: "test-key",
      baseUrl: "https://opencode.ai/zen/go",
    });

    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-opencode-session"]).toMatch(
      /^zhiyu-report-quality-/,
    );
  });

  it("normalizes unknown LLM problem types instead of rejecting the review", () => {
    const parsed = parseReportQualityLlmReview(
      JSON.stringify({
        score: 72,
        passed: false,
        summary: "The report needs more actionable detail.",
        problems: [
          {
            type: "unsupported_provider_label",
            severity: "medium",
            evidence: "The evaluator used a provider-specific label.",
            yamlTarget: "loops.demo.outputContract",
            suggestedChange: "Use one of the supported quality categories.",
          },
        ],
        strengths: ["The report is readable."],
        proposedYamlPatch: null,
        riskLevel: "low",
        needsOwnerReview: true,
      }),
    );

    expect(parsed.problems[0]?.type).toBe("formatting_gap");
    expect(parsed.summary).toContain("actionable");
  });
});
