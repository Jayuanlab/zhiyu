import { auth } from "@/app/(auth)/auth";
import { AppError } from "@openzhiyu/shared/errors";
import {
  CHAT_SUGGESTIONS_SOURCE_WARNING,
  FIXED_CHAT_SUGGESTIONS,
} from "@/lib/ai/chat-suggestions-policy";

/** Automatic suggestions must not turn unregistered saved profiles or insights
 * into model context. Fixed prompts keep this entry usable without source I/O. */
export async function GET(_request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:insight").toResponse();
  }

  return Response.json({
    suggested_prompts: FIXED_CHAT_SUGGESTIONS,
    provider: "fixed",
    detail: "personalized_sources_withheld",
    warning: CHAT_SUGGESTIONS_SOURCE_WARNING,
    sourceProtection: {
      status: "withheld",
      reason: "source_unregistered",
      personalized: false,
      storedSourcesRead: false,
      historicalDerivationsUsed: false,
      modelInvoked: false,
    },
  }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
}
