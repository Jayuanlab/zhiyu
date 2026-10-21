import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { getUserStorageUsage } from "@/lib/db/storageService";
import { artifactHttpError } from "@/lib/memory/artifacts/http";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try { return NextResponse.json(await getUserStorageUsage(session.user.id, session.user.type)); }
  catch (error) { return artifactHttpError(error); }
}
