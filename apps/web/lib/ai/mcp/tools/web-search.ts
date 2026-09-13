/**
 * Web search tool owned by Zhiyu, not Claude Code's built-in WebSearch.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchPublicWeb } from "@/lib/workshops/web-fetch";

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: "brave" | "duckduckgo";
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
};

const DEFAULT_LIMIT = 5;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ZhiyuWebSearch/1.0; +https://github.com/Jayuanlab/zhiyu)";

function stripHtml(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_match, code) => {
      const parsed = Number(code);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : "";
    });
}

function normalizeDuckDuckGoUrl(value: string) {
  const decoded = decodeHtmlEntities(value);
  try {
    const url = new URL(decoded);
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : decoded;
  } catch {
    return decoded;
  }
}

export function parseDuckDuckGoHtml(
  html: string,
  limit = DEFAULT_LIMIT,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRegex =
    /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b[^"]*"|<\/body>|$)/gi;

  for (const blockMatch of html.matchAll(blockRegex)) {
    const block = blockMatch[0];
    const linkMatch = block.match(
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;

    const snippetMatch = block.match(
      /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );

    const title = stripHtml(linkMatch[2] ?? "");
    const url = normalizeDuckDuckGoUrl(linkMatch[1] ?? "");
    const snippet = stripHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "");

    if (!title || !url || results.some((item) => item.url === url)) continue;
    results.push({ title, url, snippet, source: "duckduckgo" });
    if (results.length >= limit) break;
  }

  return results;
}

function formatResultsForModel(query: string, results: WebSearchResult[]) {
  if (results.length === 0) {
    return JSON.stringify(
      {
        success: false,
        query,
        results: [],
        message:
          "No web search results were found. Try a shorter query or provide a known website/domain.",
        evidencePolicy:
          "You may only say this search adapter returned no citable web results for this query. Do not claim that all public channels, company registries, Qichacha, Tianyancha, Aiqicha, or government systems were checked unless the tool returns citable results from those sites.",
      },
      null,
      2,
    );
  }

  const markdownSources = results
    .map((item, index) => {
      const snippet = item.snippet ? ` - ${item.snippet}` : "";
      return `${index + 1}. [${item.title}](${item.url})${snippet}`;
    })
    .join("\n");

  return JSON.stringify(
    {
      success: true,
      query,
      source: results[0]?.source,
      results,
      markdownSources,
      instruction:
        "Use markdown hyperlinks from markdownSources when citing web search results. Do not invent sources, channels, or checked websites that are not present in results.",
    },
    null,
    2,
  );
}

async function searchBrave(query: string, limit: number) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return null;

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(limit, 1), 10)));
  url.searchParams.set("search_lang", "zh-hans");
  url.searchParams.set("country", "CN");

  const response = await fetchPublicWeb(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Brave Search HTTP ${response.status}`);
  }
  const payload = (await response.json()) as BraveSearchResponse;
  return (
    payload.web?.results
      ?.map((item) => ({
        title: stripHtml(item.title ?? ""),
        url: item.url ?? "",
        snippet: stripHtml(item.description ?? ""),
        source: "brave" as const,
      }))
      .filter((item) => item.title && item.url)
      .slice(0, limit) ?? []
  );
}

async function searchDuckDuckGo(query: string, limit: number) {
  const body = new URLSearchParams({
    q: query,
    kl: "cn-zh",
  });
  const response = await fetchPublicWeb("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo Search HTTP ${response.status}`);
  }
  const html = await response.text();
  if (response.status === 202 || /anomaly-modal|challenge-form|anomaly\.js/i.test(html)) {
    throw new Error("DuckDuckGo requires human verification; search coverage is unavailable, not zero results. Configure BRAVE_SEARCH_API_KEY for the supported search API or use known official sources.");
  }
  return parseDuckDuckGoHtml(html, limit);
}

export function createWebSearchTool() {
  return tool(
    "webSearch",
    [
      "Search the public web using Zhiyu's own search adapter.",
      "",
      "Use this instead of Claude Code's built-in WebSearch.",
      "Use it when the user asks for current public information, company information, public websites, news-like facts, or source-backed web lookup.",
      "",
      "The tool returns JSON with results and markdownSources. Cite sources using markdown hyperlinks from markdownSources.",
      "If results is empty, say only that this search adapter found no citable web results for the query. Do not claim a total absence from all public information channels.",
    ].join("\n"),
    {
      query: z.string().min(1).describe("Search query."),
      limit: z.coerce
        .number()
        .min(1)
        .max(10)
        .default(DEFAULT_LIMIT)
        .describe("Maximum result count. Default 5, max 10."),
    },
    async ({ query, limit = DEFAULT_LIMIT }) => {
      try {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { success: false, message: "query is required" },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const results =
          (await searchBrave(normalizedQuery, limit)) ??
          (await searchDuckDuckGo(normalizedQuery, limit));

        return {
          content: [
            {
              type: "text" as const,
              text: formatResultsForModel(normalizedQuery, results),
            },
          ],
          data: {
            query: normalizedQuery,
            results,
            count: results.length,
          },
          isError: results.length === 0,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  query,
                  results: [],
                  message:
                    error instanceof Error
                      ? error.message
                      : "Web search failed",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
