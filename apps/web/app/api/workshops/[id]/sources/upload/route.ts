import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { auth } from "@/app/(auth)/auth";
import { getAppDir } from "@/lib/env/config/constants";
import { addWorkSource, assertWorkAccess } from "@/lib/work-runtime";
import { countWorkshopSources } from "@/lib/workshops/service";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const work = await assertWorkAccess({ userId: session.user.id, workId: id }).catch(() => null);
  if (!work) {
    return NextResponse.json({ error: "Work not found" }, { status: 404 });
  }
  if ((work.modelConfig as Record<string, unknown> | null)?.role !== "document_markdown_cleaner") {
    return NextResponse.json({ error: "This Work cannot accept document uploads" }, { status: 403 });
  }
  if ((await countWorkshopSources(id)) >= 1000) {
    return NextResponse.json({ error: "This Work already has 1,000 sources; use a new Work for the next batch" }, { status: 409 });
  }
  const body = await request.formData();
  const file = body.get("file");
  if (!(file instanceof File) || !file.name.trim() || file.size === 0 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Choose a nonempty file up to 100 MiB" }, { status: 400 });
  }
  const extension = extname(file.name).toLowerCase();
  if (extension && !/^\.[a-z0-9]{1,12}$/.test(extension)) {
    return NextResponse.json({ error: "Invalid filename extension" }, { status: 400 });
  }
  const directory = join(getAppDir(), "workshop-sources", session.user.id, id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}${extension}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes, { flag: "wx" });
  try {
    const { source } = await addWorkSource({
      userId: session.user.id,
      workId: id,
      type: "file",
      name: file.name,
      uri: pathToFileURL(path).href,
      config: { originalName: file.name, contentType: file.type || null, sizeBytes: bytes.length, sha256, uploadedAt: new Date().toISOString() },
      source: "owner",
      reason: "Document uploaded for Markdown conversion.",
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    await unlink(path).catch(() => {});
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
