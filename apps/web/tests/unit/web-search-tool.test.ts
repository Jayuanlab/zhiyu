import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeHtmlEntities,
  parseDuckDuckGoHtml,
  createWebSearchTool,
} from "@/lib/ai/mcp/tools/web-search";

describe("web search tool", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("reports a verification challenge as unavailable instead of empty results", async () => {
    vi.stubEnv("BAILIAN_WEB_SEARCH_API_KEY", "");
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    vi.stubEnv("BAILIAN_API_KEY", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<form id="challenge-form">verify</form>', { status: 202 })));
    const result = await createWebSearchTool().handler({ query: "Hugging Face blog", limit: 3 }, {} as never);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("requires human verification");
    expect(JSON.stringify(result.content)).not.toContain("No web search results were found");
  });

  it("uses Bailian search with a provider key and returns citable results", async () => {
    vi.stubEnv("BAILIAN_WEB_SEARCH_API_KEY", "bailian-test-key");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ pages: [{
              title: "Official documentation",
              url: "https://example.com/docs",
              snippet: "Useful source",
            }] }),
          }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createWebSearchTool().handler(
      { query: "documentation", limit: 3 },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.data)).toContain('"source":"bailian"');
    expect(JSON.stringify(result.content)).toContain("[Official documentation](https://example.com/docs)");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/mcps/WebSearch/mcp");
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer bailian-test-key");
  });

  it("reports Bailian failure without silently switching providers", async () => {
    vi.stubEnv("BAILIAN_WEB_SEARCH_API_KEY", "bailian-test-key");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createWebSearchTool().handler(
      { query: "documentation", limit: 3 },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Bailian Search HTTP 401");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("decodes common html entities and numeric entities", () => {
    expect(
      decodeHtmlEntities(
        "A&amp;B &lt;tag&gt; &quot;quote&quot; &#39;x&#39; &#x4E2D;&#25991;",
      ),
    ).toBe(`A&B <tag> "quote" 'x' 中文`);
  });

  it("parses DuckDuckGo html results and unwraps redirected urls", () => {
    const html = `
      <html><body>
        <div class="result results_links">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2">重庆市冰雪环保科技有限公司 &amp; 企业信息</a>
          <a class="result__snippet">企业信用、地址与公开信息。</a>
        </div>
        <div class="result results_links">
          <a class="result__a" href="https://example.org/profile">企业官网</a>
          <div class="result__snippet">官方网站简介。</div>
        </div>
      </body></html>
    `;

    expect(parseDuckDuckGoHtml(html, 5)).toEqual([
      {
        title: "重庆市冰雪环保科技有限公司 & 企业信息",
        url: "https://example.com/a?x=1&y=2",
        snippet: "企业信用、地址与公开信息。",
        source: "duckduckgo",
      },
      {
        title: "企业官网",
        url: "https://example.org/profile",
        snippet: "官方网站简介。",
        source: "duckduckgo",
      },
    ]);
  });

  it("deduplicates urls and respects the limit", () => {
    const html = `
      <body>
        <div class="result"><a class="result__a" href="https://example.com/a">A</a></div>
        <div class="result"><a class="result__a" href="https://example.com/a">A duplicate</a></div>
        <div class="result"><a class="result__a" href="https://example.com/b">B</a></div>
      </body>
    `;

    expect(parseDuckDuckGoHtml(html, 1)).toEqual([
      {
        title: "A",
        url: "https://example.com/a",
        snippet: "",
        source: "duckduckgo",
      },
    ]);
  });
});
