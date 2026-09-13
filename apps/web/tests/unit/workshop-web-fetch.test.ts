import { afterEach, describe, expect, it, vi } from "vitest";
import { describeWebFailure, fetchPublicWeb, readWithWebFallback, publicNewsFeedFallback } from "@/lib/workshops/web-fetch";
import { classifyLoopAction, decideLoopActionApproval } from "@/lib/loops/approval";
import { rssToReadableText } from "@/lib/workshops/web-feed";

afterEach(() => vi.unstubAllGlobals());

describe("public web transport and approval", () => {
  it("preserves RSS entry titles, URLs and dates while decoding CDATA", () => {
    const result = rssToReadableText('<rss><channel><title><![CDATA[News]]></title><item><title><![CDATA[A & B]]></title><link>https://example.com/a</link><pubDate>Sat, 12 Sep 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>Evidence</p>]]></description></item></channel></rss>');
    expect(result).toContain("## A & B");
    expect(result).toContain("URL: https://example.com/a");
    expect(result).toContain("Published: Sat, 12 Sep 2026");
    expect(result).not.toContain("CDATA");
    expect(() => rssToReadableText("<html>challenge</html>")).toThrow("invalid feed");
  });
  it("uses official RSS only for a blocked OpenAI index, never as a substitute for an article", () => {
    expect(publicNewsFeedFallback(new URL("https://openai.com/news/"), 403)).toBe("https://openai.com/news/rss.xml");
    expect(publicNewsFeedFallback(new URL("https://openai.com/news/article"), 403)).toBeNull();
    expect(publicNewsFeedFallback(new URL("https://example.com/news/"), 403)).toBeNull();
    expect(publicNewsFeedFallback(new URL("https://openai.com/news/"), 200)).toBeNull();
  });
  it("supplies a proxy-aware dispatcher and a body-lifetime abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPublicWeb("https://example.com");
    const options = fetchMock.mock.calls[0][1];
    expect(options.dispatcher.dispatch).toBeTypeOf("function");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves connection cause without exposing credentials", () => {
    const error = new Error("fetch failed at http://user:secret@proxy", { cause: { code: "ECONNREFUSED" } });
    expect(describeWebFailure(error)).toContain("ECONNREFUSED");
    expect(describeWebFailure(error)).not.toContain("secret");
  });

  it("keeps both provider failures and distinguishes missing coverage", async () => {
    const errors: string[] = [];
    await expect(readWithWebFallback(
      async () => { throw new Error("Direct fetch failed with HTTP 403."); },
      async () => { throw new Error("Jina Reader failed with HTTP 403."); }, errors,
    )).rejects.toThrow("Coverage is incomplete");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("Direct");
    expect(errors[1]).toContain("Jina");
  });

  it("returns a successful fallback with the original failure retained", async () => {
    const errors: string[] = [];
    expect(await readWithWebFallback(async () => { throw new Error("HTTP 403"); }, async () => "content", errors)).toBe("content");
    expect(errors).toEqual(["HTTP 403"]);
  });

  it.each(["webSearch", "mcp__workshop-tools__webSearch", "mcp__business-tools__webSearch", "webReadPage", "WebFetch"])("classifies %s as read, preserving explicit deny", actionName => {
    expect(classifyLoopAction(actionName)).toBe("read");
    expect(decideLoopActionApproval({ actionName, actionPolicy: {}, approvalPolicy: { defaultMode: "allow", externalWrites: "require_approval" } }).decision).toBe("allow");
    expect(decideLoopActionApproval({ actionName, actionPolicy: { allowed: [actionName], denied: [actionName] }, approvalPolicy: {} }).decision).toBe("deny");
    expect(decideLoopActionApproval({ actionName, actionPolicy: { requiresApproval: [actionName] }, approvalPolicy: {} }).decision).toBe("require_approval");
  });

  it.each(["douyinPrepareUpload", "douyinPublishApprovedDraft"])("retains approval for %s", actionName => {
    expect(decideLoopActionApproval({ actionName, actionPolicy: {}, approvalPolicy: { defaultMode: "allow", externalWrites: "require_approval" } }).decision).toBe("require_approval");
  });
});
