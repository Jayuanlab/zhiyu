import { auth } from "@/app/(auth)/auth";
import { getInsightByIdForUser } from "@/lib/db/queries";
import { AppError } from "@openzhiyu/shared/errors";
import { insightSourceRequiredResponse } from "@/lib/insights/source-protection";

/** Keep owner existence semantics; legacy saved insight bodies/attachments are
 * withheld before prompt construction, model setup or domain mutation. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new AppError("unauthorized:insight").toResponse();
  const { id } = await params;
  try {
    const record = await getInsightByIdForUser({ userId: session.user.id, insightId: id });
    if (!record) return new AppError("not_found:insight", "Insight not found").toResponse();
    return insightSourceRequiredResponse();
  } catch {
    return new AppError("bad_request:insight", "Failed to verify insight ownership.").toResponse();
  }
}
