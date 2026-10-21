import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { getUserStorageUsage, listUserFiles } from "@/lib/db/storageService";
import { artifactHttpError } from "@/lib/memory/artifacts/http";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit =
    limitParam && Number.parseInt(limitParam, 10) > 0
      ? Math.min(Number.parseInt(limitParam, 10), 50)
      : 20;

  const usage = await getUserStorageUsage(session.user.id, session.user.type);
  const { files, nextCursor, hasMore } = await listUserFiles({
    userId: session.user.id,
    limit,
    cursor,
  });

  return NextResponse.json({
    files: files.map((file) => ({
      id: file.id,
      name: file.name,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      savedAt: file.savedAt,
      url: ["private_local", "private_blob"].includes(file.storageProvider) ? `/api/files/${file.id}` : null,
      blobPathname: file.blobPathname,
      chatId: file.chatId,
      messageId: file.messageId,
      storageProvider: file.storageProvider,
      providerFileId: file.providerFileId,
      providerMetadata: ["private_local", "private_blob"].includes(file.storageProvider) ? { artifactId: file.id, controlStatus: "private_manifest" } : null,
      controlStatus: ["private_local", "private_blob"].includes(file.storageProvider) ? "private_manifest" : "legacy_uncontrolled",
      warning: ["private_local", "private_blob"].includes(file.storageProvider) ? null : "Historical public/external objects lack a controlled digest and cannot be retroactively made private by their metadata.",
    })),
    pagination: {
      nextCursor,
      hasMore,
    },
    usage,
  });
  } catch (error) { return artifactHttpError(error); }
}
