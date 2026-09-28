/**
 * Web search tool owned by Zhiyu, not Claude Code's built-in WebSearch.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  DEFAULT_WEB_SEARCH_LIMIT,
  decodeHtmlEntities,
  parseDuckDuckGoHtml,
  runZhiyuWebSearch,
} from "@/lib/ai/web-search-adapter";

export { decodeHtmlEntities, parseDuckDuckGoHtml };

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
        .default(DEFAULT_WEB_SEARCH_LIMIT)
        .describe("Maximum result count. Default 5, max 10."),
    },
    async ({ query, limit = DEFAULT_WEB_SEARCH_LIMIT }) => {
      try {
        const result = await runZhiyuWebSearch({ query, limit });
        return {
          content: [
            {
              type: "text" as const,
              text: result.formatted,
            },
          ],
          data: {
            query: result.query,
            results: result.results,
            count: result.count,
          },
          isError: !result.success,
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
