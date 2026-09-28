/**
 * Contacts tool - Query user contacts
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "next-auth";
import { queryContactsForUser } from "@/lib/ai/contacts-query";

/**
 * Create the queryContacts tool
 */
export function createContactsTool(session: Session) {
  return tool(
    "queryContacts",
    "Query and retrieve user's contacts with pagination support. This tool can fetch contacts with optional filtering by name and paginated results. Results include contact details and pagination metadata.",
    {
      filter: z
        .object({
          name: z
            .string()
            .optional()
            .describe(
              "Optional name to search for specific contacts (partial matches allowed)",
            ),
        })
        .optional()
        .describe("Optional filter criteria to narrow down contact results"),
      page: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe("Page number (starting from 1), default is 1"),
      pageSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Number of items per page (1-100), default is 10"),
    },
    async (args) => {
      try {
        const { filter, page = 1, pageSize = 10 } = args;

        const result = await queryContactsForUser({
          userId: session.user.id,
          filter,
          page,
          pageSize,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
          data: result.data,
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to query contacts: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
