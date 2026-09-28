import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainRecallRetryDetails } from "@/components/brain-recall-retry-details";

describe("recall retry display", () => {
  it('shows information gaps without claiming answer sufficiency', () => {
    const html = renderToStaticMarkup(React.createElement(BrainRecallRetryDetails, { trace: {
      originalQuery: '继续', stopReason: 'results_available', informationReadiness: {
        version: 'information-readiness.v1', needs: [{ category: 'tools', status: 'unavailable', required: true, question: '<receipt>' }],
      },
    } }));
    expect(html).toContain('工具回执：数据源不可用');
    expect(html).toContain('不代表答案已经充分');
    expect(html).toContain('&lt;receipt&gt;');
  });
  it("shows shadow degradation without claiming evidence sufficiency", () => {
    const html = renderToStaticMarkup(React.createElement(BrainRecallRetryDetails, { trace: { originalQuery: "test", stopReason: "results_available", attempts: 1, evidenceCheck: { mode: "shadow", status: "degraded", detail: "timeout" } } }));
    expect(html).toContain("旁路观察，不影响回答");
    expect(html).toContain("检查不可用");
    expect(html).toContain("timeout");
  });
  it("renders a keyboard-accessible disclosure with escaped queries and stop status", () => {
    const html = renderToStaticMarkup(React.createElement(BrainRecallRetryDetails, { trace: { originalQuery: "<script>原问题</script>", rewrittenQuery: "项目延期", reason: "同义表达", attempts: 2, stopReason: "empty_after_retry" } }));
    expect(html).toContain("<summary");
    expect(html).toContain("补查后仍无匹配");
    expect(html).toContain("项目延期");
    expect(html).toContain("同义表达");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("does not invent retry history for older events", () => {
    expect(renderToStaticMarkup(React.createElement(BrainRecallRetryDetails, { trace: undefined }))).toBe("");
  });
});
