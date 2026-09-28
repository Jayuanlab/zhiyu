import { fetchPublicWeb } from "@/lib/workshops/web-fetch";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: "bailian" | "brave" | "duckduckgo";
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

type BailianSearchResponse = {
  error?: { message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
};

export const DEFAULT_WEB_SEARCH_LIMIT = 5;
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
  limit = DEFAULT_WEB_SEARCH_LIMIT,
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

export function formatResultsForModel(
  query: string,
  results: WebSearchResult[],
) {
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

async function searchBailian(query: string, limit: number) {
  const apiKey =
    process.env.BAILIAN_WEB_SEARCH_API_KEY?.trim() ||
    process.env.DASHSCOPE_API_KEY?.trim() ||
    process.env.BAILIAN_API_KEY?.trim();
  if (!apiKey) return null;

  const response = await fetchPublicWeb(
    "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bailian_web_search",
          arguments: { query, count: limit },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Bailian Search HTTP ${response.status}`);

  const payload = (await response.json()) as BailianSearchResponse;
  if (payload.error || payload.result?.isError) {
    throw new Error(`Bailian Search failed: ${payload.error?.message ?? "tool error"}`);
  }
  const text = payload.result?.content?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Bailian Search returned no result content");

  let pages: unknown;
  try {
    pages = (JSON.parse(text) as { pages?: unknown }).pages;
  } catch {
    throw new Error("Bailian Search returned invalid result content");
  }
  if (!Array.isArray(pages)) {
    throw new Error("Bailian Search returned no pages list");
  }
  return pages
    .map((page) => {
      const item = page as { title?: unknown; url?: unknown; snippet?: unknown };
      if (typeof item.title !== "string" || typeof item.url !== "string") return null;
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        return null;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return {
        title: stripHtml(item.title),
        url: url.toString(),
        snippet: stripHtml(typeof item.snippet === "string" ? item.snippet : "").slice(0, 500),
        source: "bailian" as const,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.title && item.url))
    .slice(0, limit);
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
  if (
    response.status === 202 ||
    /anomaly-modal|challenge-form|anomaly\.js/i.test(html)
  ) {
    throw new Error(
      "DuckDuckGo requires human verification; search coverage is unavailable, not zero results. Configure DASHSCOPE_API_KEY or BRAVE_SEARCH_API_KEY for a supported search API, or use known official sources.",
    );
  }
  return parseDuckDuckGoHtml(html, limit);
}

export async function runZhiyuWebSearch(input: {
  query: string;
  limit?: number;
}) {
  const normalizedQuery = input.query.trim();
  if (!normalizedQuery) {
    return {
      success: false,
      query: input.query,
      results: [] as WebSearchResult[],
      count: 0,
      message: "query is required",
      formatted: JSON.stringify(
        { success: false, message: "query is required" },
        null,
        2,
      ),
    };
  }

  const limit = Math.min(
    Math.max(Number.isFinite(input.limit ?? NaN) ? Number(input.limit) : DEFAULT_WEB_SEARCH_LIMIT, 1),
    10,
  );
  const results =
    (await searchBailian(normalizedQuery, limit)) ??
    (await searchBrave(normalizedQuery, limit)) ??
    (await searchDuckDuckGo(normalizedQuery, limit));

  return {
    success: results.length > 0,
    query: normalizedQuery,
    results,
    count: results.length,
    formatted: formatResultsForModel(normalizedQuery, results),
  };
}
