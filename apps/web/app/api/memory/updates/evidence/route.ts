import { NextResponse, type NextRequest } from "next/server";
import { getBrainMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { resolveEvidenceRefs as resolveBrainEvidenceRefs } from "@/lib/memory/evidence/reader";
import type { EvidenceOwnerHint as BrainEvidenceOwnerHint } from "@/lib/memory/evidence/types";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_REFS = 40;
const MAX_SOURCE_CHARACTERS = 20_000;
const MAX_TOTAL_CHARACTERS = 200_000;

/** Expand stored proposal evidence only. References never authorize URL or file access. */
export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  const proposalId = request.nextUrl.searchParams.get("proposalId") ?? "";
  if (!UUID.test(proposalId)) return NextResponse.json({ error: "Invalid proposal ID" }, { status: 400 });
  try {
    const candidate = await getBrainMemoryById({ userId: user.userId, memoryId: proposalId });
    const proposal = candidate?.metadata?.updateProposal;
    const revision = candidate?.metadata?.revision as Record<string, unknown> | undefined;
    const admission = candidate?.metadata?.admission as Record<string, unknown> | undefined;
    const guardedCandidate = Boolean(revision || admission?.requiresOwnerVerification);
    if (!candidate || (!proposal && !guardedCandidate) || (proposal && (typeof proposal !== "object" || Array.isArray(proposal)))) {
      return NextResponse.json({ error: "Memory update proposal not found" }, { status: 404 });
    }
    const baseId = (proposal as Record<string, unknown> | undefined)?.targetMemoryId
      ?? (proposal as Record<string, unknown> | undefined)?.baseMemoryId;
    const base = typeof baseId === "string" && UUID.test(baseId)
      ? await getBrainMemoryById({ userId: user.userId, memoryId: baseId }) : null;
    const refs = [...new Set([...candidate.evidenceRefs, ...(base?.evidenceRefs ?? [])])];
    const ownerHintsByRef = new Map<string, BrainEvidenceOwnerHint[]>();
    for (const memory of [candidate, base]) {
      if (!memory) continue;
      for (const ref of memory.evidenceRefs) ownerHintsByRef.set(ref, [
        ...(ownerHintsByRef.get(ref) ?? []), { ownerType: memory.ownerType, ownerId: memory.ownerId },
      ]);
    }
    const resolved = await resolveBrainEvidenceRefs({
      userId: user.userId, evidenceRefs: refs.slice(0, MAX_REFS), ownerHintsByRef,
    });
    let remaining = MAX_TOTAL_CHARACTERS;
    const sources = resolved.map(source => {
      const length = source.content?.length ?? 0;
      const limit = Math.min(MAX_SOURCE_CHARACTERS, remaining);
      const content = source.content == null ? null : source.content.slice(0, limit);
      remaining -= content?.length ?? 0;
      return { ...source, content, truncated: length > limit,
        warning: source.status !== "resolved" ? "来源未能解析，不能视为已核实。"
          : length > limit ? "来源正文已截断，请继续核对完整原始来源。" : null };
    });
    return NextResponse.json({
      proposalId, sources, requestedCount: refs.length, returnedCount: sources.length,
      truncated: refs.length > MAX_REFS || sources.some(source => source.truncated),
      warning: "来源记录存在不代表其内容正确；请核对来源身份、时间及与提案的对应关系。",
    });
  } catch (error) {
    return errorResponse(error, "Failed to read memory update evidence");
  }
}
