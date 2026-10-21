import { auth } from "@/app/(auth)/auth";
import { getDocument } from "@/lib/ai/rag/langchain-service";
import { get } from "@/app/api/files/_handlers";
import { artifactHttpError, artifactIdFromReference } from "@/lib/memory/artifacts/http";

/** Original bytes use the same owner manifest, integrity and receipt boundary as files. */
export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const document = await getDocument((await params).documentId);
    if (!document || document.userId !== session.user.id) return Response.json({ error: "Document not found" }, { status: 404 });
    if (!document.blobPath) return Response.json({ error: "Original file unavailable" }, { status: 404 });
    const id = artifactIdFromReference(document.blobPath);
    if (!id) return Response.json({ error: "This historical original has no controlled private manifest", code: "artifact_legacy_uncontrolled" }, { status: 410 });
    return get(request, { params: Promise.resolve({ id }) });
  } catch (error) { return artifactHttpError(error); }
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
